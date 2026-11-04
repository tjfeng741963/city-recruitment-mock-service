"""回复编排：检索 → 事实/话术分离 → LLM → 数字校验 → 降级。

这是把前面几块串起来的唯一入口。五条路径：

0. 纯寒暄           → 不查库，随机挑一句带问题的招呼（客户只是打个招呼）
1. 检索无命中        → 分清是"年龄不符""城市没岗位"还是真没有，别一律"我确认一下"，也不调 LLM
2. LLM 返回且校验通过 → 用模型回复
3. LLM 返回但校验失败 → 重生成一次；仍失败则降级为模板
4. LLM 不可用        → 降级为模板，绝不沉默

**绝不因为 LLM 挂掉就不回客户**（决策文档 5.1 节）。
"""

from __future__ import annotations

import random
import re
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models_kb import DEFAULT_TENANT_ID, KbEntry
from .kb_extract import _CITY_HINTS
from .kb_reply import Facts, build_facts, build_messages, verify_reply
from .kb_search import SearchQuery, extract_age_from_query, search
from .llm_provider import ChatMessage, LLMProvider, LLMUnavailable

NO_MATCH_REPLY = "我确认一下，稍后回你哈"
TEMPLATE_FALLBACK = "我这边查一下，等下给你准信哈"
CLARIFY_CITY_REPLY = "你在哪个城市呀？我按城市给你找合适的厂。"

# 上面这几个是"没有确定信息"时的问句/兜底，不算答非所问

# 寒暄不能让客户对着同一句话看三遍——真人不会每次都一个字不差。
# 每条都必须落到一个具体问题上（城市 / 工种 / 年龄），否则客户接不下去。
GREETING_VARIANTS = (
    "你好呀，我们这边广州、深圳、东莞都有厂在招，你之前做过什么工种？",
    "哎你好，是想找普工还是别的岗位？我这边广州深圳都有在招的。",
    "在的，你打算去哪个城市？我看看那边有什么合适的厂。",
    "你好，最近厂里在补人，你多大年纪、想找哪个城市的？",
)


def infer_city(text: str, history: Sequence[str] = ()) -> str | None:
    """从当前消息或最近几句里找城市。

    客户经常先说"我在广州"，下一句只问"工价多少"。第二句没有城市，
    不追问就会随便挑一个城市的岗位——答非所问比不回答更糟。

    规则：当前消息优先；没有就往前翻历史，**从最近往最早找**。
    """
    for candidate in (text, *reversed(tuple(history))):
        if not candidate:
            continue
        for city in _CITY_HINTS:
            if city in candidate:
                return city
    return None


def _already_asked_city(history: Sequence[str]) -> bool:
    """上一轮已经问过城市了就别再问——连续追问同一件事，客户会觉得是机器人。

    历史上限只看最近两条，够用且不依赖消息角色标记。
    """
    recent = tuple(history)[-2:]
    return any(CLARIFY_CITY_REPLY in turn for turn in recent if turn)


# 纯条件类问法：答案高度依赖城市，没城市就答不准
_CONDITION_WORDS = (
    "工价", "多少", "工资", "几号发", "多少钱", "包吃", "包住", "宿舍",
    "年龄", "岁", "加班", "面试", "体检", "班次", "白班", "夜班",
)

# 用户能自己说清楚要什么：具体厂名、地铁站、公司名
_SPECIFIC_WORDS = ("厂", "公司", "地铁", "站", "哪个", "哪家")


def wants_clarification(text: str, city: str | None) -> bool:
    """是否需要先反问城市。

    只有"问条件"且"没提具体对象"时才反问。两类不反问：
    - 已经知道城市（当前句或历史里提到过）
    - 用户问的是具体厂名/站点，直接查
    "你好""在吗"这种也不是条件问法，不该反问。
    """
    if city or not text:
        return False
    if any(token in text for token in _SPECIFIC_WORDS):
        return False
    return any(token in text for token in _CONDITION_WORDS)


# 纯寒暄词。只认"整句就是在打招呼"，不做语义猜测
_GREETING_TOKENS = (
    "你好", "您好", "在吗", "在不在", "有人吗", "老板",
    "hello", "hi", "早上好", "下午好", "晚上好",
)

# 实质内容词：出现任何一个就说明客户在问事，不是单纯打招呼。
# "你好，广州有什么厂" 里有「厂」「广州」，必须走正常检索，不能当寒暄打发。
_SUBSTANTIVE_WORDS = (
    "厂", "公司", "岗", "工作", "招", "工价", "工资", "多少", "钱", "包吃", "包住",
    "面试", "体检", "年龄", "岁", "多大", "城市", "哪儿", "哪里", "哪家", "哪个",
    "上班", "加班", "班次", "白班", "夜班", "宿舍", "什么时候",
)

# 寒暄都很短。放宽到 8 个字，"老板你好呀在吗" 这种叠着说的也算
_MAX_GREETING_LEN = 8

_PUNCT_RE = re.compile(r"[\s，。、！？!?,.~～…:：;；\"'“”‘’()（）]+")


def classify_greeting(text: str) -> bool:
    """这句话是不是单纯的打招呼。

    判定必须保守：**短** 且 **不含实质词** 且 **含寒暄词**，三个条件同时成立才算。
    宁可把一句寒暄当正常问题去查（最多回一句兜底），也不能把
    "你好，广州有什么厂" 当成寒暄打发掉——那是客户唯一一次说需求的机会。
    """
    if not text:
        return False
    stripped = text.strip()
    normalized = _PUNCT_RE.sub("", stripped)
    if not normalized or len(normalized) > _MAX_GREETING_LEN:
        return False
    if any(word in stripped for word in _CITY_HINTS):
        return False
    if any(word in stripped for word in _SUBSTANTIVE_WORDS):
        return False
    lowered = stripped.lower()
    return any(_contains_greeting_token(lowered, token) for token in _GREETING_TOKENS)


def _contains_greeting_token(lowered: str, token: str) -> bool:
    """中文直接找子串；英文按单词边界，避免 "hi" 命中 "this"。"""
    if token.isascii():
        return re.search(rf"(?<![a-z]){token}(?![a-z])", lowered) is not None
    return token in lowered


async def _cities_with_stock(
    session: AsyncSession, *, exclude: str | None = None, limit: int = 3
) -> list[str]:
    """库里真实有岗位的城市，按在招条目数降序。

    绝不拿 _CITY_HINTS 顶替：那份表是"识别城市名用的词典"，
    库里没有的城市推荐给客户，等于让人白跑一趟。
    """
    stmt = select(KbEntry.city, func.count(KbEntry.id)).where(
        KbEntry.tenant_id == DEFAULT_TENANT_ID,
        KbEntry.status == "enabled",
        KbEntry.city.is_not(None),
        KbEntry.city != "",
    )
    if exclude:
        stmt = stmt.where(KbEntry.city != exclude)
    stmt = (
        stmt.group_by(KbEntry.city)
        .order_by(func.count(KbEntry.id).desc(), KbEntry.city)
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return [city for city, _count in rows if city]


def _city_empty_reply(city: str, others: Sequence[str]) -> str:
    names = "、".join(others)
    tail = "这几个地方还在招" if len(others) > 1 else "还在招"
    return f"{city}暂时没有合适的，{names}{tail}，你考虑哪个？"


def _age_mismatch_reply(entry: KbEntry, age: int) -> str | None:
    """用条目里真实的年龄区间解释"为什么去不了"。没有区间就返回 None，交给上层兜底。"""
    if entry.age_min is None or entry.age_max is None:
        return None
    name = (entry.title or "这个厂").strip()
    place = f"{entry.city}" if entry.city and not name.startswith(entry.city) else ""
    return (
        f"{place}{name}要{entry.age_min}到{entry.age_max}岁，"
        f"{age}岁去不了。我帮你看看有没有年龄放宽一点的？"
    )


@dataclass(frozen=True)
class Answer:
    """一次回复的完整结果，字段够用于事后回溯。"""

    reply: str
    source: str  # llm / template / no_match / clarify / greeting / city_empty / age_mismatch
    matched_entry_ids: tuple[int, ...]
    tiers_used: tuple[str, ...]
    validation_passed: bool
    unauthorized_numbers: tuple[str, ...]
    llm_fallback: bool


async def answer(
    session: AsyncSession,
    user_text: str,
    provider: LLMProvider | None,
    *,
    city: str | None = None,
    history: Sequence[str] = (),
    limit: int = 3,
) -> Answer:
    """生成一条回复。任何异常都不外抛，最差也给模板。

    `provider` 为 None 表示租户没配大模型——这是**正式运行模式**，不是降级：
    检索照常做，回复由 `render_template()` 从命中的真实条目拼成口语化话术，
    不发起任何外部调用，也不会有超时等待。
    """
    # 寒暄不查库：客户只是打个招呼，检索命中 0 条再回"我确认一下"是最伤人的回答
    if classify_greeting(user_text):
        return _greeting_answer()

    age = extract_age_from_query(user_text)

    # 城市：显式传入 > 当前消息里提到的 > 最近对话里提到的
    resolved_city = city or infer_city(user_text, history)

    # 纯条件类问法（问工价/包吃住/年龄）却没给城市：先反问，别乱挑一个城市回答
    if wants_clarification(user_text, resolved_city) and not _already_asked_city(history):
        return Answer(
            reply=CLARIFY_CITY_REPLY,
            source="clarify",
            matched_entry_ids=(),
            tiers_used=(),
            validation_passed=True,
            unauthorized_numbers=(),
            llm_fallback=False,
        )

    result = await search(
        session,
        SearchQuery(city=resolved_city, age=age, text=user_text, limit=limit),
    )

    entry_ids = tuple(h.entry.id for h in result.hits)
    tiers = result.tiers_used

    if not result.hits:
        return await _no_hit_answer(
            session,
            user_text=user_text,
            resolved_city=resolved_city,
            age=age,
            city_given=city is not None,
            history=history,
            entry_ids=entry_ids,
            tiers=tiers,
            limit=limit,
        )

    facts = build_facts(result)

    # 没配大模型：直接用模板，不发起任何网络调用，也不等超时
    if provider is None:
        return Answer(
            reply=render_template(result, age=age),
            source="template",
            matched_entry_ids=entry_ids,
            tiers_used=tiers,
            validation_passed=True,
            unauthorized_numbers=(),
            llm_fallback=False,
        )

    messages = build_messages(user_text, facts)

    # 第一次生成
    try:
        reply = await provider.complete(messages)
    except LLMUnavailable:
        return _fallback(facts, entry_ids, tiers)

    ok, bad = verify_reply(reply, facts.allowed_numbers)
    if ok:
        return Answer(
            reply=reply,
            source="llm",
            matched_entry_ids=entry_ids,
            tiers_used=tiers,
            validation_passed=True,
            unauthorized_numbers=(),
            llm_fallback=False,
        )

    # 校验失败：带着"你用了未授权数字"的提示重生成一次
    try:
        retry_reply = await provider.complete(
            [
                *messages,
                ChatMessage(role="assistant", content=reply),
                ChatMessage(role="user", content=_repair_hint(bad)),
            ]
        )
    except LLMUnavailable:
        return _fallback(facts, entry_ids, tiers)

    ok2, bad2 = verify_reply(retry_reply, facts.allowed_numbers)
    if ok2:
        return Answer(
            reply=retry_reply,
            source="llm",
            matched_entry_ids=entry_ids,
            tiers_used=tiers,
            validation_passed=True,
            unauthorized_numbers=(),
            llm_fallback=False,
        )

    return Answer(
        reply=_template_from_facts(facts),
        source="template",
        matched_entry_ids=entry_ids,
        tiers_used=tiers,
        validation_passed=False,
        unauthorized_numbers=tuple(sorted(bad2)),
        llm_fallback=True,
    )


def _greeting_answer() -> Answer:
    return Answer(
        reply=random.choice(GREETING_VARIANTS),
        source="greeting",
        matched_entry_ids=(),
        tiers_used=(),
        validation_passed=True,
        unauthorized_numbers=(),
        llm_fallback=False,
    )


async def _no_hit_answer(
    session: AsyncSession,
    *,
    user_text: str,
    resolved_city: str | None,
    age: int | None,
    city_given: bool,
    history: Sequence[str],
    entry_ids: tuple[int, ...],
    tiers: tuple[str, ...],
    limit: int,
) -> Answer:
    """检索 0 条时该怎么解释。

    同一个 0 条有三种完全不同的原因，回同一句话就是答非所问：
    - 年龄卡住了（去掉年龄能查到）
    - 这个城市没有岗位（别的城市有）
    - 真没有（或问的是某个具体厂，库里没录）

    `city_given` 是调用方显式传入的城市筛选条件，不是客户原话；
    这种时候保持原来"我确认一下"的口径，不推翻外部给定的筛选结果。
    """
    # ① 年龄不符：不带年龄再查一次，能查到就说明是年龄这道门卡住的
    if age is not None and not city_given:
        relaxed = await search(
            session, SearchQuery(city=resolved_city, text=user_text, limit=limit)
        )
        for hit in relaxed.hits:
            reply = _age_mismatch_reply(hit.entry, age)
            if reply:
                return Answer(
                    reply=reply,
                    source="age_mismatch",
                    matched_entry_ids=tuple(hit.entry.id for hit in relaxed.hits),
                    tiers_used=relaxed.tiers_used,
                    validation_passed=True,
                    unauthorized_numbers=(),
                    llm_fallback=False,
                )

    # ② 这个城市没有岗位：把真实在招的城市报给他。
    #    上文说的是**另一个**城市时（客户在对比两座城市，或刚换地方还没说清），
    #    先保持中性说法，别急着把他往别处带。
    history_city = infer_city("", history)
    if (
        resolved_city
        and not city_given
        and (history_city is None or history_city == resolved_city)
    ):
        others = await _cities_with_stock(session, exclude=resolved_city)
        if others:
            return Answer(
                reply=_city_empty_reply(resolved_city, others),
                source="city_empty",
                matched_entry_ids=(),
                tiers_used=(),
                validation_passed=True,
                unauthorized_numbers=(),
                llm_fallback=False,
            )

    # ③ 原兜底，语义不变
    reply = NO_MATCH_REPLY
    if resolved_city is None and not wants_clarification(user_text, resolved_city):
        # 用户问的是具体厂名但没查到，别让他一直猜
        reply = "这个我这边暂时没查到，你方便说一下是哪个城市、什么厂吗？我帮你确认。"
    return Answer(
        reply=reply,
        source="no_match",
        matched_entry_ids=entry_ids,
        tiers_used=tiers,
        validation_passed=True,
        unauthorized_numbers=(),
        llm_fallback=False,
    )


def _repair_hint(bad: set[str]) -> str:
    return (
        f"你刚才的回复里出现了事实中没有的数字：{'、'.join(sorted(bad))}。"
        "请只用【事实】里给出的数字重新回答，不要编造。"
    )


def _fallback(
    facts: Facts, entry_ids: tuple[int, ...], tiers: tuple[str, ...]
) -> Answer:
    return Answer(
        reply=_template_from_facts(facts),
        source="template",
        matched_entry_ids=entry_ids,
        tiers_used=tiers,
        validation_passed=True,
        unauthorized_numbers=(),
        llm_fallback=True,
    )


def _template_from_facts(facts: Facts) -> str:
    """事实块摘要。仅在 LLM 调用失败时兜底，正常路径走 render_template。"""
    if not facts.block:
        return TEMPLATE_FALLBACK
    first = facts.block.splitlines()[0]
    return f"{first}，你看合适不？"


_WAGE_UNIT_TEXT = {"hour": "块一小时", "day": "块一天", "month": "块一个月"}


def _format_wage(entry) -> str | None:
    if entry.wage_min is None:
        return None
    unit = _WAGE_UNIT_TEXT.get(entry.wage_unit or "", "")
    low = _fmt_num(entry.wage_min)
    high = _fmt_num(entry.wage_max) if entry.wage_max is not None else None
    if high and high != low:
        return f"{low}-{high}{unit}"
    return f"{low}{unit}"


def _fmt_num(value) -> str:
    """22.00 -> '22'，22.50 -> '22.5'。避免把库里的 Decimal 原样贴给客户。"""
    text = f"{value}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def render_template(result: SearchResult, *, age: int | None = None) -> str:
    """不依赖大模型的回复。直接用人话把命中的岗位信息讲出来。

    这不是"降级"——很多客户就是不想配大模型。要求一样：
    只说库里有的事实，数字全部来自结构化字段，绝不自己发挥。

    结构：先说岗位，再说门槛（年龄/工价/食宿），最后给一个可执行的下一步。
    """
    if not result.hits:
        return NO_MATCH_REPLY

    # 优先推荐岗位：客户问"能去吗"，要的是岗位，不是话术。
    # 检索层已按 job 优先排序，但年龄过滤可能把岗位全滤掉、只剩话术，
    # 这时直接回话术原文会答非所问（客户问 52 岁能不能去，回了一段闲聊）。
    jobs = [h for h in result.hits if h.entry.kind == "job"]
    if not jobs:
        if age is not None:
            return "这个条件我这边暂时没有能接的厂，我先帮你留意着，有合适的马上给你信。"
        top = result.hits[0].entry
        body = (top.body or "").strip()
        return body[:300] if body else TEMPLATE_FALLBACK

    top = jobs[0].entry

    parts: list[str] = []
    name = (top.title or "这个岗位").strip()
    # 标题里已经带了城市（如「广州番禺电子厂普工」）就不要再加前缀，
    # 否则会拼出「广州广州番禺电子厂普工」。
    place = f"{top.city}" if top.city and not name.startswith(top.city) else ""
    parts.append(f"{place}{name}现在还在招")

    # 年龄：先判断用户本身能不能进，再报岗位要求
    age_ok: bool | None = None
    if age is not None and top.age_min is not None and top.age_max is not None:
        age_ok = top.age_min <= age <= top.age_max
    if top.age_min is not None and top.age_max is not None:
        if age_ok is False:
            parts.append(
                f"不过这个厂卡年龄，要{top.age_min}到{top.age_max}岁，你{age}岁进不去"
            )
        else:
            parts.append(f"年龄要{top.age_min}到{top.age_max}岁")

    wage = _format_wage(top)
    if wage:
        parts.append(f"工价{wage}")

    perks = []
    if top.has_meal:
        perks.append("包吃")
    if top.has_dorm:
        perks.append("包住")
    if perks:
        parts.append("、".join(perks))

    if top.interview_at is not None:
        parts.append(f"面试时间{top.interview_at:%m月%d日%H:%M}")

    reply = "，".join(parts)

    # 用户超龄时给个台阶：另外还有别的岗位
    if age_ok is False:
        alternatives = [e for e in jobs[1:]]
        if alternatives:
            reply += f"。同城还有{alternatives[0].entry.title}可以考虑，要不要看看"
            return reply + "？"
        return reply + "。我这边再帮你找找别的合适的不？"

    return reply + "。你什么时候方便过来面试？"

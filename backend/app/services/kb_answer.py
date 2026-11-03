"""回复编排：检索 → 事实/话术分离 → LLM → 数字校验 → 降级。

这是把前面几块串起来的唯一入口。四条路径：

1. 检索无命中        → 直说"我确认一下"，不调 LLM（省成本也不让模型瞎编）
2. LLM 返回且校验通过 → 用模型回复
3. LLM 返回但校验失败 → 重生成一次；仍失败则降级为模板
4. LLM 不可用        → 降级为模板，绝不沉默

**绝不因为 LLM 挂掉就不回客户**（决策文档 5.1 节）。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from .kb_reply import Facts, build_facts, build_messages, verify_reply
from .kb_search import SearchQuery, extract_age_from_query, search
from .llm_provider import ChatMessage, LLMProvider, LLMUnavailable

NO_MATCH_REPLY = "我确认一下，稍后回你哈"
TEMPLATE_FALLBACK = "我这边查一下，等下给你准信哈"


@dataclass(frozen=True)
class Answer:
    """一次回复的完整结果，字段够用于事后回溯。"""

    reply: str
    source: str  # llm / template / no_match
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
    limit: int = 3,
) -> Answer:
    """生成一条回复。任何异常都不外抛，最差也给模板。

    `provider` 为 None 表示租户没配大模型——这是**正式运行模式**，不是降级：
    检索照常做，回复由 `render_template()` 从命中的真实条目拼成口语化话术，
    不发起任何外部调用，也不会有超时等待。
    """
    age = extract_age_from_query(user_text)
    result = await search(
        session,
        SearchQuery(city=city, age=age, text=user_text, limit=limit),
    )

    entry_ids = tuple(h.entry.id for h in result.hits)
    tiers = result.tiers_used

    if not result.hits:
        return Answer(
            reply=NO_MATCH_REPLY,
            source="no_match",
            matched_entry_ids=entry_ids,
            tiers_used=tiers,
            validation_passed=True,
            unauthorized_numbers=(),
            llm_fallback=False,
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
    place = f"{top.city}" if top.city else ""
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

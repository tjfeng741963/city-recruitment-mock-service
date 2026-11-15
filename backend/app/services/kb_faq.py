"""场景问答检索（知识库 v3 第 2 层）。

设计见 docs/知识库方案-流程驱动-20261113.md §3.5 / §四。

和 kb_placeholder.py 的分工：
- kb_placeholder 是旧路径：扫 kb_entry 的话术标题关键词，城市 +3 / 同厂 +5 **打分**。
- 本文件是新路径：扫 kb_faq，按 vertical + scope **硬过滤**，不做模糊打分。

为什么硬过滤：客户问「包吃住吗」，如果靠打分，别家厂的话术只要分数够高就会
被选中——这就是"串厂"。硬过滤下，别家厂的条目**根本不进候选集**。

检索顺序（写死）：
    1. vertical_id 匹配（NULL 视为所有品类通用）
    2. scope 从窄到宽：employer → city → vertical → global
    3. 同层 keywords 命中，取 priority 最大
    4. 都不命中 → 返回 None，由调用方记 unknown_questions + 走兜底

占位符渲染：
    {wage} {welfare} {shift} {work} {dorm} {age} {insurance} {regular}
    {advance} {medical} {tattoo_policy} {relocate_policy}  ← 从 position.data_json 取
    {address} {walk_guide} {interview_time}                 ← 从 location / job 取
    {employer}                                              ← 从 employer 取
没填的占位符连同它所在的那一小句一起丢掉，绝不把 {wage} 字面量发给客户。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models_kb import DEFAULT_TENANT_ID, Employer, KbFaq, Location, Vertical
from .kb_policy import shared_answer_allowed
from .question_topics import WAGE_KEYWORDS, is_non_wage_cost_question, is_wage_keyword

# scope 从窄到宽的检索顺序
SCOPE_ORDER = ("position", "employer", "city", "vertical", "global")

# 占位符：单花括号，与旧路径的双花括号 {{x}} 区分开。
# 支持兜底写法 {name|兜底文案}：有值用值，没值用兜底，两者都没有才整句丢弃。
# 为什么要兜底：「买社保吗」「多久转正」这类问题，岗位字段常常空着，
# 但客户问了必须有答——整句丢弃等于不回复，比给个不含数字的通用说法更糟。
_PLACEHOLDER = re.compile(r"\{([^{}\n|]{1,40})(?:\|([^{}\n]{1,200}))?\}")

# 一句话里含这些字，说明客户在问事（才去查 FAQ）
_QUESTION_HINTS = (
    "吗", "么", "几", "多少", "什么", "怎么", "哪", "行不行", "能不能", "有没有", "？", "?",
)


@dataclass(frozen=True)
class FaqHit:
    """一条命中结果。tier 记录命中在哪一层，用于日志回溯「当时用的是哪条」。"""

    id: int
    question: str
    answer: str
    media: list[str]
    scope_level: str
    tier: str  # employer | city | vertical | global


def _loads(raw: str | None) -> list[str]:
    """JSON 数组字段宽松解析：脏数据不抛异常，按空处理。"""
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return [str(item) for item in value] if isinstance(value, list) else []


def looks_like_question(text: str) -> bool:
    """客户这句话是不是在问事。寒暄/答话不进 FAQ，免得答非所问。"""
    value = (text or "").strip()
    if len(value) < 2:
        return False
    return any(hint in value for hint in _QUESTION_HINTS)


# 同义词组：把客户常见说法归到同一概念。
#
# 为什么需要：keywords 是运营手列的固定词表，客户说法千变万化——词表写
# 「住宿」，客户说「宿舍」就漏答；写「工资」，客户说「一个月能拿多少」也漏。
# 实测 030 导入的真实话术里，「宿舍」「几人间」「伙食」一个都不在词表里。
#
# 只收**无歧义的概念词**：「远」「多大」这类泛词不收，否则「宿舍多大」会误命中
# 「年龄」。宁可少扩，不能错配——错配比漏答更糟（答错要赔钱，漏答只是不答）。
_SYNONYM_GROUPS: tuple[tuple[str, ...], ...] = (
    WAGE_KEYWORDS,
    ("住宿", "宿舍", "包住", "住宿条件", "几人间"),
    ("吃饭", "包吃", "伙食", "食堂", "管饭"),
    ("社保", "五险", "一金", "保险", "缴纳"),
    ("体检", "健康证", "查体"),
    ("押金", "押钱", "中介费", "收费"),
    ("转正", "正式工", "试用期", "实习"),
    ("年龄", "多大年纪", "几岁", "岁数"),
    ("纹身", "纹身要求", "刺青"),
)


def _synonyms_of(keyword: str) -> tuple[str, ...]:
    """关键词所属的同义词组（含自身）。不在任何组里就只返回自身。"""
    for group in _SYNONYM_GROUPS:
        if keyword in group:
            return group
    return (keyword,)


def match_keywords(question: str, keywords: list[str]) -> int:
    """命中返回分数（同 priority 内排序用），不命中返回 0。

    两级计分，保证「客户原话直接命中词表」永远赢过「靠同义词猜的」：
      1. 关键词原文出现在客户这句话里 → 按字数 ×2 计分
      2. 原文没命中，但它的同义词有说法出现 → 按字数 ×1 计分
    """
    text = question or ""
    score = 0
    expense_question = is_non_wage_cost_question(text)
    for word in keywords:
        if not word:
            continue
        # 具体费用优先，不能让“多少钱”同义扩展成工资，或因“从工资扣”
        # 命中工资FAQ；体检/社保等主题关键词仍按正常作用域查找。
        if expense_question and is_wage_keyword(word):
            continue
        if word in text:
            score += len(word) * 2
            continue
        for alias in _synonyms_of(word):
            if alias != word and alias in text:
                score += len(alias)
                break
    return score


def _vertical_id_subquery(vertical_code: str):
    """品类 code → id 的子查询。写成子查询是为了不额外打一次库。"""
    return (
        select(Vertical.id)
        .where(
            Vertical.tenant_id == DEFAULT_TENANT_ID,
            Vertical.code == vertical_code,
        )
        .scalar_subquery()
    )


async def lookup(
    session: AsyncSession,
    question: str,
    *,
    vertical_code: str = "factory",
    employer_id: int | None = None,
    location_id: int | None = None,
    position_id: int | None = None,
    tenant_id: int = DEFAULT_TENANT_ID,
) -> FaqHit | None:
    """查一条场景问答。命中返回 FaqHit，未命中返回 None。

    硬过滤顺序：position → employer → city → vertical → global。
    任何一层命中就立刻返回，不再往宽了找——窄层赢就是"本岗位/本厂优先"的语义。
    岗位级存在的理由：同厂不同工种工价不同（普工 24-26、焊工 35-40）。
    """
    text = (question or "").strip()
    if not text:
        return None

    base = [
        KbFaq.tenant_id == tenant_id,
        KbFaq.status == "enabled",
        # 品类匹配：本品类 or 通用（NULL）
        or_(KbFaq.vertical_id.is_(None), KbFaq.vertical_id == _vertical_id_subquery(vertical_code)),
    ]

    tiers: list[tuple[str, list[Any]]] = []
    if position_id:
        tiers.append(
            ("position", [KbFaq.scope_level == "position", KbFaq.scope_position_id == position_id])
        )
    if employer_id:
        tiers.append(
            ("employer", [KbFaq.scope_level == "employer", KbFaq.scope_employer_id == employer_id])
        )
    if location_id:
        tiers.append(
            ("city", [KbFaq.scope_level == "city", KbFaq.scope_location_id == location_id])
        )
    tiers.append(("vertical", [KbFaq.scope_level == "vertical"]))
    tiers.append(("global", [KbFaq.scope_level == "global"]))

    for tier_name, tier_filters in tiers:
        stmt = (
            select(KbFaq)
            .where(*base, *tier_filters)
            .order_by(KbFaq.priority.desc(), KbFaq.id)
        )
        rows = (await session.execute(stmt)).scalars().all()
        best: tuple[int, KbFaq] | None = None
        for row in rows:
            score = match_keywords(text, _loads(row.keywords))
            if not score:
                continue
            if tier_name not in {"position", "employer"} and not shared_answer_allowed(
                text, str(row.answer or ""),
                keywords=[str(row.question or ""), *_loads(row.keywords)],
                media=_loads(row.media),
                fact_fields={*_PLACEHOLDER_KEYS, *_PLACEHOLDER_KEYS.values()},
            ):
                continue
            if best is None or score > best[0] or (
                score == best[0] and int(row.priority or 0) > int(best[1].priority or 0)
            ):
                best = (score, row)
        if best:
            row = best[1]
            return FaqHit(
                id=int(row.id),
                question=str(row.question or ""),
                answer=str(row.answer or ""),
                media=_loads(row.media),
                scope_level=str(row.scope_level or "global"),
                tier=tier_name,
            )
    return None


# 占位符 → 岗位动态字段键。模板里写 {wage}，实际值在 position.data_json 的 wage_text。
# 这样模板短、好写，岗位字段沿用前端已有的命名，两边都稳定。
_PLACEHOLDER_KEYS: dict[str, str] = {
    "wage": "wage_text",
    "welfare": "welfare_text",
    "shift": "hours_text",
    "work": "work_text",
    "dorm": "dorm_text",
    "age": "age_text",
    "insurance": "insurance_text",
    "regular": "regular_text",
    "advance": "advance_text",
    "medical": "medical_text",
    "tattoo_policy": "tattoo_policy",
    "relocate_policy": "relocate_policy",
    # 地铁安检品类特有：月休、身高、线路、民族限制、面试带什么
    "rest": "rest_text",
    "height": "height_text",
    "line": "line_text",
    "ethnicity": "ethnicity_policy",
    "cert": "cert_text",
}


def render(
    answer: str,
    *,
    job: dict[str, Any] | None = None,
    location: dict[str, Any] | None = None,
    employer_name: str = "",
) -> str:
    """占位符渲染。

    规则：**没值的占位符，连同它所在的那一小句一起删掉。**
    否则会拼出「这边工价是」「面试地点在，我这边把定位发你」这种残句。

    实现：先按中文标点切句，句子里有未填占位符就整句丢掉；全丢光返回空串，
    由调用方决定退回哪句兜底。
    """
    job = job or {}
    location = location or {}

    values: dict[str, str] = {
        "employer": employer_name or str(job.get("factory_name") or ""),
        "address": str(location.get("address") or job.get("place") or ""),
        "walk_guide": str(location.get("walk_guide") or ""),
        "interview_time": str(job.get("interview_time") or ""),
    }
    # 岗位动态字段里的任意键都能直接当占位符用（{wage_text} 也成立）
    for key, value in job.items():
        if isinstance(value, (str, int, float)) and str(value).strip():
            values.setdefault(str(key), str(value))
    # 短名占位符映射到岗位字段键
    for short, field in _PLACEHOLDER_KEYS.items():
        if short not in values:
            raw = job.get(field)
            if isinstance(raw, (str, int, float)) and str(raw).strip():
                values[short] = str(raw)

    text = str(answer or "")
    if not text:
        return ""

    def resolve(match: re.Match[str]) -> str | None:
        """返回替换值；None 表示这个占位符填不上（整句要丢）。"""
        name = match.group(1)
        fallback = (match.group(2) or "").strip()
        value = values.get(name, "").strip()
        if value:
            return value
        # 有兜底文案就用兜底：客户问了必须有答，空着不如给个不含数字的通用说法
        return fallback or None

    sentences = re.split(r"(?<=[。！？；\n])", text)
    kept: list[str] = []
    for sentence in sentences:
        if not sentence.strip():
            continue
        placeholders = list(_PLACEHOLDER.finditer(sentence))
        if not placeholders:
            kept.append(sentence)
            continue
        # 句子里每个占位符都要能填上（有值或有兜底），否则整句丢
        replacements: list[tuple[re.Match[str], str]] = []
        dropped = False
        for match in placeholders:
            value = resolve(match)
            if value is None:
                dropped = True
                break
            replacements.append((match, value))
        if dropped:
            continue
        rendered = sentence
        for match, value in reversed(replacements):
            rendered = rendered[: match.start()] + value + rendered[match.end() :]
        kept.append(rendered)
    return "".join(kept).strip()


async def resolve_context(
    session: AsyncSession,
    *,
    employer_id: int | None = None,
    location_id: int | None = None,
) -> tuple[dict[str, Any], str]:
    """取渲染占位符需要的上下文：位置信息、招工方名。

    返回 (location_dict, employer_display_name)。查不到就返回空，不抛。
    """
    location: dict[str, Any] = {}
    employer_name = ""
    if location_id:
        row = (
            await session.execute(select(Location).where(Location.id == location_id))
        ).scalar_one_or_none()
        if row is not None:
            location = {
                "address": str(row.address or ""),
                "walk_guide": str(row.walk_guide or ""),
                "image_key": str(row.image_key or ""),
                "name": str(row.name or ""),
            }
    if employer_id:
        row = (
            await session.execute(select(Employer).where(Employer.id == employer_id))
        ).scalar_one_or_none()
        if row is not None:
            employer_name = str(row.short_name or row.display_name or "")
    return location, employer_name


__all__ = [
    "FaqHit",
    "SCOPE_ORDER",
    "looks_like_question",
    "lookup",
    "match_keywords",
    "render",
    "resolve_context",
]

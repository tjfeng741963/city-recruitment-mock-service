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
    provider: LLMProvider,
    *,
    city: str | None = None,
    limit: int = 3,
) -> Answer:
    """生成一条回复。任何异常都不外抛，最差也给模板。"""
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
    """降级模板：直接回事实块的摘要。安全，但不如模型口语化。"""
    if not facts.block:
        return TEMPLATE_FALLBACK
    first = facts.block.splitlines()[0]
    return f"{first}，你看合适不？"

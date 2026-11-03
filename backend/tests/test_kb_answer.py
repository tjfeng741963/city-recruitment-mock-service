"""编排层测试：四条路径都要覆盖，尤其是降级。

核心验收：LLM 编造数字 → 不许发给客户；LLM 挂了 → 客户也要收到回复。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete

from app.db import SessionLocal
from app.models_kb import KbEntry
from app.services.kb_answer import NO_MATCH_REPLY, answer
from app.services.llm_provider import ChatMessage, LLMUnavailable


class _ScriptedProvider:
    """按顺序返回预设回复；None 表示抛 LLMUnavailable。"""

    def __init__(self, *replies: str | None) -> None:
        self.replies = list(replies)
        self.calls: list[list[ChatMessage]] = []

    async def complete(self, messages: list[ChatMessage], **kwargs: object) -> str:
        del kwargs
        self.calls.append(list(messages))
        if not self.replies:
            raise LLMUnavailable("no more scripted replies")
        nxt = self.replies.pop(0)
        if nxt is None:
            raise LLMUnavailable("scripted failure")
        return nxt


@pytest.fixture
async def one_job(client) -> None:  # noqa: ARG001
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        await session.execute(delete(KbEntry))
        await session.commit()
        session.add(
            KbEntry(
                id=1,
                tenant_id=1,
                kind="job",
                title="广州电子厂",
                city="广州",
                age_min=18,
                age_max=45,
                wage_min=22,
                wage_max=25,
                wage_unit="hour",
                has_meal=True,
                has_dorm=True,
                body="18-45岁 22-25元/小时 包吃住",
                search_text="广州电子厂 18-45岁 22-25元/小时",
                status="enabled",
                valid_until=now + timedelta(days=30),
            )
        )
        await session.commit()


class TestHappyPath:
    async def test_llm_reply_used_when_valid(self, one_job: None) -> None:
        provider = _ScriptedProvider("这个厂 18-45 岁，22-25 块一小时，包吃住")
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", provider, city="广州")
        assert result.source == "llm"
        assert result.validation_passed is True
        assert result.matched_entry_ids == (1,)

    async def test_no_match_skips_llm(self, one_job: None) -> None:
        provider = _ScriptedProvider()
        async with SessionLocal() as session:
            result = await answer(session, "深圳有没有岗位", provider, city="深圳")
        assert result.source == "no_match"
        assert result.reply == NO_MATCH_REPLY
        assert provider.calls == []  # 没调模型，省钱也防瞎编


class TestFabrication:
    async def test_fabricated_number_triggers_retry(self, one_job: None) -> None:
        provider = _ScriptedProvider(
            "这个厂 30 块一小时",  # 编造
            "这个厂 22-25 块一小时",  # 重生成，合规
        )
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", provider, city="广州")
        assert result.source == "llm"
        assert result.validation_passed is True
        assert len(provider.calls) == 2

    async def test_persistent_fabrication_falls_back(self, one_job: None) -> None:
        provider = _ScriptedProvider("这个厂 30 块一小时", "这个厂 35 块一小时")
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", provider, city="广州")
        assert result.source == "template"
        assert result.validation_passed is False
        assert result.llm_fallback is True
        assert "30" not in result.reply and "35" not in result.reply


class TestFallback:
    async def test_llm_unavailable_still_replies(self, one_job: None) -> None:
        provider = _ScriptedProvider(None)
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", provider, city="广州")
        assert result.source == "template"
        assert result.llm_fallback is True
        assert result.reply  # 客户必须收到点什么
        assert "22" in result.reply  # 模板用事实块，数字安全

    async def test_retry_unavailable_falls_back(self, one_job: None) -> None:
        provider = _ScriptedProvider("这个厂 30 块一小时", None)
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", provider, city="广州")
        assert result.source == "template"
        assert result.llm_fallback is True


class TestPromptSeparation:
    async def test_prompt_contains_fact_block(self, one_job: None) -> None:
        provider = _ScriptedProvider("好的")
        async with SessionLocal() as session:
            await answer(session, "广州电子厂多少一小时", provider, city="广州")
        system_prompt = provider.calls[0][0].content
        assert "禁止改写" in system_prompt
        assert "18-45" in system_prompt
        assert "22-25" in system_prompt

    async def test_age_detected_from_question(self, one_job: None) -> None:
        """52 岁问 18-45 的厂：检索层就该排除，无需模型判断。"""
        provider = _ScriptedProvider("好的")
        async with SessionLocal() as session:
            result = await answer(session, "我52了还能去吗", provider, city="广州")
        assert result.source == "no_match"
        assert result.matched_entry_ids == ()


class TestNoLLMMode:
    """不配大模型是正式运行模式：检索照做，回复用模板，不发起任何外部调用。"""

    async def test_provider_none_uses_template(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", None, city="广州")
        assert result.source == "template"
        assert result.matched_entry_ids == (1,)
        # 不是"降级失败"，而是正常路径
        assert result.llm_fallback is False

    async def test_template_mentions_real_facts(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", None, city="广州")
        assert "广州电子厂" in result.reply
        assert "22-25" in result.reply
        assert "18" in result.reply and "45" in result.reply
        assert "包吃" in result.reply and "包住" in result.reply

    async def test_template_speaks_like_a_person(self, one_job: None) -> None:
        """不能把数据库字段名或【事实】这类内部标记贴给客户。"""
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", None, city="广州")
        for forbidden in ("【", "】", "age_min", "wage", "事实", "原文"):
            assert forbidden not in result.reply

    async def test_over_age_gets_clear_answer(self, one_job: None) -> None:
        """52 岁问 18-45 的厂：模板要直接说进不去，不能含糊。"""
        async with SessionLocal() as session:
            result = await answer(session, "我52了还能去吗", None, city="广州")
        # 检索层就该排除这个岗位
        assert result.source == "no_match"

    async def test_template_numbers_all_from_database(self, one_job: None) -> None:
        """模板回复里的数字必须都能在条目里找到——和 LLM 一样的红线。"""
        from app.services.kb_reply import extract_numbers

        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂多少一小时", None, city="广州")
        allowed = {"18", "45", "22", "25"}
        assert extract_numbers(result.reply) <= allowed


class TestCityContext:
    """客户常说"我在广州"，下一句只问"工价多少"。丢掉上下文就会乱答。"""

    async def test_city_from_history(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(
                session, "工价多少一个小时", None, history=["我在广州，想找个厂"]
            )
        assert result.source == "template"
        assert result.matched_entry_ids == (1,)

    async def test_current_message_beats_history(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(
                session, "深圳有厂吗", None, history=["我在广州"]
            )
        assert result.source == "no_match"

    async def test_nearest_history_wins(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(
                session, "工价多少", None, history=["我在广州", "现在在深圳"]
            )
        # 最近一条说深圳，应该按深圳查
        assert result.matched_entry_ids == ()

    async def test_explicit_city_param_wins(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(
                session, "工价多少", None, city="广州", history=["我在深圳"]
            )
        assert result.matched_entry_ids == (1,)


class TestClarification:
    """没城市又要问条件时，先反问，不要随便挑一个城市回答。"""

    async def test_asks_city_when_condition_without_city(self, one_job: None) -> None:
        from app.services.kb_answer import CLARIFY_CITY_REPLY

        async with SessionLocal() as session:
            result = await answer(session, "工价多少一个小时", None)
        assert result.source == "clarify"
        assert result.reply == CLARIFY_CITY_REPLY

    async def test_no_repeat_question(self, one_job: None) -> None:
        """上一轮刚问过城市，这一轮没答，也别再重复问。"""
        from app.services.kb_answer import CLARIFY_CITY_REPLY

        async with SessionLocal() as session:
            result = await answer(
                session, "工价多少", None, history=[CLARIFY_CITY_REPLY]
            )
        assert result.source != "clarify"

    async def test_greeting_does_not_trigger_clarify(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(session, "你好", None)
        assert result.source != "clarify"

    async def test_specific_factory_does_not_trigger_clarify(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(session, "广州电子厂工价多少", None)
        assert result.source != "clarify"

    async def test_city_known_no_clarify(self, one_job: None) -> None:
        async with SessionLocal() as session:
            result = await answer(session, "工价多少一个小时", None, city="广州")
        assert result.source == "template"

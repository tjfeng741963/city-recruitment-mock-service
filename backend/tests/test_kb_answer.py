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
                body="18-45岁 22-25元/小时",
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

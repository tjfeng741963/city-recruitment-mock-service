"""知识库占位命中 + 未命中记账。

两条路径都要能跑：
- 命中 kb_entry(kind='script') → 返回条目正文
- 未命中 → 返回 None（调用方走兜底话术并写 unknown_questions）
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models_kb import DEFAULT_TENANT_ID, KbEntry
from app.services import kb_placeholder, unknown_questions


@pytest_asyncio.fixture
async def session() -> AsyncSession:
    from app.db import SessionLocal, init_db

    await init_db()
    async with SessionLocal() as db:
        yield db


async def _entry(session: AsyncSession, title: str, body: str, kind: str = "script", status: str = "enabled") -> KbEntry:
    entry = KbEntry(
        tenant_id=DEFAULT_TENANT_ID,
        kind=kind,
        title=title,
        body=body,
        status=status,
        search_text=title,
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


def test_keywords_cover_short_phrases() -> None:
    words = kb_placeholder.keywords_of("体检要自己出钱吗")
    assert "体检" in words
    assert "体检要自己出钱吗" in words
    assert kb_placeholder.match("体检要花钱吗", "体检要自己出钱吗") is True
    assert kb_placeholder.match("工资多少", "体检要自己出钱吗") is False


@pytest.mark.asyncio
async def test_hit_returns_answer(session: AsyncSession) -> None:
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"体检报销吗{marker}", "体检费先自己出，满一个月厂里报销。")
    try:
        answer = await kb_placeholder.lookup(session, f"体检报销吗{marker}要多少钱")
        assert answer == "体检费先自己出，满一个月厂里报销。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_miss_returns_none(session: AsyncSession) -> None:
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"体检报销吗{marker}", "体检费先自己出。")
    try:
        assert await kb_placeholder.lookup(session, f"网吧能上网吗{marker}") is None
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_disabled_and_job_entries_are_ignored(session: AsyncSession) -> None:
    marker = uuid.uuid4().hex[:6]
    disabled = await _entry(session, f"住宿条件{marker}", "四人间。", status="disabled")
    job = await _entry(session, f"住宿条件{marker}岗位", "包住。", kind="job")
    try:
        assert await kb_placeholder.lookup(session, f"住宿条件{marker}怎么样") is None
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id.in_([disabled.id, job.id])))
        await session.commit()


def test_normalize_question() -> None:
    assert unknown_questions.normalize_question("  宿舍有没有空调 ？ ") == "宿舍有没有空调"
    assert unknown_questions.normalize_question("宿舍   有没有 空调?") == "宿舍 有没有 空调"
    assert unknown_questions.normalize_question("   ") == ""


@pytest.mark.asyncio
async def test_record_needs_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FLOW_PROFILE_TOKEN", raising=False)
    called: list[Any] = []

    class Boom:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            called.append((args, kwargs))

    monkeypatch.setattr(unknown_questions.httpx, "AsyncClient", Boom)
    assert await unknown_questions.record("宿舍有没有空调") is False
    assert called == []


@pytest.mark.asyncio
async def test_record_body_and_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok-u")
    captured: dict[str, Any] = {}

    class Resp:
        status_code = 200

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            captured["timeout"] = kwargs.get("timeout")

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict) -> Resp:
            captured.update({"url": url, "json": json, "headers": headers})
            return Resp()

    monkeypatch.setattr(unknown_questions.httpx, "AsyncClient", FakeClient)
    ok = await unknown_questions.record(
        " 宿舍有没有空调？ ", device_code="pc-office-01", session_key="s-9"
    )
    assert ok is True
    assert captured["url"].endswith("/api/v1/agent/unknown-questions")
    assert captured["headers"]["X-Profile-Token"] == "tok-u"
    assert captured["json"] == {
        "question": "宿舍有没有空调",
        "device_code": "pc-office-01",
        "external_conversation_id": "s-9",
    }

    class BoomClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("4222 挂了")

    monkeypatch.setattr(unknown_questions.httpx, "AsyncClient", BoomClient)
    assert await unknown_questions.record("宿舍有没有空调") is False

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


async def _entry(
    session: AsyncSession,
    title: str,
    body: str,
    kind: str = "script",
    status: str = "enabled",
    city: str | None = None,
    factory_name: str | None = None,
) -> KbEntry:
    entry = KbEntry(
        tenant_id=DEFAULT_TENANT_ID,
        kind=kind,
        title=title,
        body=body,
        status=status,
        city=city,
        factory_name=factory_name,
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


def test_generic_connector_words_never_match():
    """回归：话术标题里混着「还有法定节假日…」时，客户问「还有什么岗位」不许命中。"""
    title = "这边长期/短期做都可以，能做一个月以上都行，这边属于国企还是比较不错的，你如果能长期做的话，转正之后我们都是入编制的，还有法定节假日三倍工资，有意向可以直接找我报名面试"
    kws = kb_placeholder.keywords_of(title)
    assert "还有" not in kws
    assert kb_placeholder.match("还有什么岗位", title) is False


def test_lookup_prefers_most_relevant(monkeypatch):
    """多条命中时选关键词覆盖最长的，而不是库里第一条。"""
    import asyncio
    import sys
    import types

    from app.services import kb_placeholder as mod

    class Row:
        def __init__(self, title, body):
            self.title, self.body = title, body
            self.status = "enabled"
            self.kind = "script"
            self.tenant_id = 1

    rows = [Row("体检", "短答"), Row("体检报销多少钱一个月", "长答")]

    class Scalars:
        def scalars(self):
            return self

        def all(self):
            return rows

    class FakeSession:
        async def execute(self, *_a, **_k):
            return Scalars()

    out = asyncio.run(mod.lookup(FakeSession(), "体检报销多少钱一个月"))
    assert out == "长答", out


@pytest.mark.parametrize("question", ["体检多少钱，能报销吗？", "体检费从工资扣吗？"])
async def test_named_expense_does_not_fall_back_to_same_factory_wage_script(session, question):
    marker = uuid.uuid4().hex
    factory = "费用隔离测试厂" + marker
    wage = await _entry(session, "工资多少钱" + marker, "本厂工资260元每天", factory_name=factory)
    money = await _entry(session, "多少钱", "本厂工资260元每天", factory_name=factory)
    ids = [wage.id, money.id]
    try:
        assert await kb_placeholder.lookup_entry(session, question, factory=factory, require_factory=True) is None
        medical = await _entry(session, "体检费用" + marker, "本测试厂体检费用待现场确认", factory_name=factory)
        ids.append(medical.id)
        hit = await kb_placeholder.lookup_entry(session, question, factory=factory, require_factory=True)
        assert hit and hit["id"] == str(medical.id)
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id.in_(ids)))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_city_same_city_beats_wildcard(session: AsyncSession) -> None:
    """同城加权：标题关键词打平时，带城市的那条 +3 胜出。"""
    marker = uuid.uuid4().hex[:6]
    local = await _entry(session, f"住宿条件{marker}", "同城答：厂区宿舍。", city="广州")
    wildcard = await _entry(session, f"住宿条件{marker}", "通配答：有宿舍。")
    try:
        assert await kb_placeholder.lookup(session, f"住宿条件{marker}怎么样", city="广州") == "同城答：厂区宿舍。"
        # 换个城市：同城条目被排除，只剩通配条目
        assert await kb_placeholder.lookup(session, f"住宿条件{marker}怎么样", city="深圳") == "通配答：有宿舍。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id.in_([local.id, wildcard.id])))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_city_mismatch_is_excluded(session: AsyncSession) -> None:
    """异城排除：城市不符不许命中，宁可答不上来也不答错城市的事。"""
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"体检报销{marker}", "深圳的规则。", city="深圳")
    try:
        assert await kb_placeholder.lookup(session, f"体检报销{marker}吗", city="广州") is None
        # 没传城市（客户还没说城市）时，带城市的话术也不命中
        assert await kb_placeholder.lookup(session, f"体检报销{marker}吗", city=None) is None
        assert await kb_placeholder.lookup(session, f"体检报销{marker}吗", city="深圳") == "深圳的规则。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_city_empty_is_wildcard(session: AsyncSession) -> None:
    """空 city 通配：任何城市（包括不传）都能命中，无加权。"""
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"工资发放{marker}", "每月 15 号发。")
    try:
        assert await kb_placeholder.lookup(session, f"工资发放{marker}时间", city="广州") == "每月 15 号发。"
        assert await kb_placeholder.lookup(session, f"工资发放{marker}时间", city=None) == "每月 15 号发。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


# ---- 工厂加权（契约 docs/对齐-设备工厂绑定与资料导入.md §2）----

FULL_NAME = "松下万宝(广州)压缩机有限公司"


@pytest.mark.asyncio
async def test_lookup_factory_same_beats_wildcard(session: AsyncSession) -> None:
    """同厂 +5：关键词打平时，带工厂名的那条胜出。"""
    marker = uuid.uuid4().hex[:6]
    own = await _entry(session, f"住宿条件{marker}", "本厂答：万宝宿舍。", factory_name=FULL_NAME)
    wildcard = await _entry(session, f"住宿条件{marker}", "通配答：有宿舍。")
    try:
        assert await kb_placeholder.lookup(
            session, f"住宿条件{marker}怎么样", factory=FULL_NAME
        ) == "本厂答：万宝宿舍。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id.in_([own.id, wildcard.id])))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_factory_abbreviation_containment_hits(session: AsyncSession) -> None:
    """简称双向包含：绑定值是简称也按同厂算 +5。"""
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"宿舍几人间{marker}", "万宝宿舍四人间。", factory_name=FULL_NAME)
    try:
        assert await kb_placeholder.lookup(
            session, f"宿舍几人间{marker}", factory="松下万宝"
        ) == "万宝宿舍四人间。"
        # 反向也行：条目存简称、绑定值是全称
        assert await kb_placeholder.lookup(
            session, f"宿舍几人间{marker}", factory=FULL_NAME
        ) == "万宝宿舍四人间。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_factory_mismatch_is_excluded(session: AsyncSession) -> None:
    """异厂排除：互不包含不许命中，别家的厂规不能发给本厂客户。"""
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"体检报销{marker}", "富士康的规则。", factory_name="富士康深圳")
    try:
        assert await kb_placeholder.lookup(session, f"体检报销{marker}吗", factory="松下万宝") is None
        # 没绑工厂（factory 为空）→ 通配，条目照样命中
        assert await kb_placeholder.lookup(session, f"体检报销{marker}吗") == "富士康的规则。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_factory_empty_entry_is_wildcard(session: AsyncSession) -> None:
    """条目 factory_name 为空 → 通配：绑了工厂的设备也能命中通用话术。"""
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"工资发放{marker}", "每月 15 号发。")
    try:
        assert await kb_placeholder.lookup(session, f"工资发放{marker}时间", factory="松下万宝") == "每月 15 号发。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_lookup_city_and_factory_both_empty_all_wildcard(session: AsyncSession) -> None:
    """兼容：city/factory 都为空 → factory 维度全部通配（原行为）。

    city 维度沿用既有规则：没传城市时带城市条目不命中（见上面的异城排除用例），
    所以这里条目不带 city，只验 factory_name 不拦路。
    """
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"体检报销{marker}", "通用规则。", factory_name="富士康")
    try:
        assert await kb_placeholder.lookup(session, f"体检报销{marker}吗") == "通用规则。"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_strict_lookup_without_factory_excludes_named_factory(session: AsyncSession) -> None:
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"体检报销{marker}", "甲厂体检规则", factory_name="甲厂")
    try:
        assert await kb_placeholder.lookup_entry(session, f"体检报销{marker}吗", require_factory=True) is None
        own = await kb_placeholder.lookup_entry(session, f"体检报销{marker}吗", factory="甲厂", require_factory=True)
        assert own and own["body"] == "甲厂体检规则"
        assert await kb_placeholder.lookup_entry(session, f"体检报销{marker}吗", factory="乙厂", require_factory=True) is None
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()


@pytest.mark.asyncio
async def test_strict_lookup_keeps_unscoped_entry(session: AsyncSession) -> None:
    marker = uuid.uuid4().hex[:6]
    entry = await _entry(session, f"资料咨询{marker}", "你想了解哪方面？")
    try:
        hit = await kb_placeholder.lookup_entry(session, f"资料咨询{marker}", require_factory=True)
        assert hit and hit["body"] == "你想了解哪方面？"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id == entry.id))
        await session.commit()

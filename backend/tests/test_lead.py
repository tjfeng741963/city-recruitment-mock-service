"""谈单状态抽取与线索接口。

重点验证"不许虚报约面"：判 booked 必须有可解析的时间，否则降级为 intent。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models import ChannelAccount, Conversation, Customer
from app.models_lead import Lead, LeadEvent
from app.services.lead_extract import (
    MIN_CONFIDENCE,
    build_messages,
    extract,
    normalize,
    parse_json_loose,
)

NOW = datetime(2026, 11, 4, 10, 0, tzinfo=timezone(timedelta(hours=8)))


class FakeProvider:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls = 0

    async def complete(self, messages, **kwargs):  # noqa: ANN001, ANN003
        self.calls += 1
        return self.reply


# ─────────────────────── JSON 容错 ───────────────────────
def test_parse_json_plain() -> None:
    assert parse_json_loose('{"stage":"intent"}') == {"stage": "intent"}


def test_parse_json_with_fence() -> None:
    raw = '```json\n{"stage": "asking", "confidence": 0.9}\n```'
    assert parse_json_loose(raw)["stage"] == "asking"


def test_parse_json_with_chatter() -> None:
    raw = '好的，分析如下：\n{"stage": "booked", "confidence": 0.8}\n以上。'
    assert parse_json_loose(raw)["stage"] == "booked"


def test_parse_json_invalid() -> None:
    assert parse_json_loose("我不知道该怎么判断") is None
    assert parse_json_loose("") is None


# ─────────────────────── 核心规则 ───────────────────────
def test_booked_requires_time() -> None:
    """判了 booked 但没给时间 —— 必须降级为 intent，不许虚报约面。"""
    rec, why = normalize(
        {"stage": "booked", "confidence": 0.9, "interview_at": None},
        "asking",
        now=NOW,
    )
    assert why == ""
    assert rec is not None
    assert rec["stage"] == "intent"
    assert rec["interview_at"] is None
    assert "降级" in rec["note"]


def test_booked_time_unparseable_downgraded() -> None:
    rec, _ = normalize(
        {"stage": "booked", "confidence": 0.9, "interview_at": "明天上午"},
        "intent",
        now=NOW,
    )
    assert rec["stage"] == "intent"


def test_booked_past_time_downgraded() -> None:
    """时间已经过去 8 小时，不能算约面。"""
    rec, _ = normalize(
        {"stage": "booked", "confidence": 0.9, "interview_at": "2026-11-04T01:00:00+08:00"},
        "intent",
        now=NOW,
    )
    assert rec["stage"] == "intent"


def test_booked_valid() -> None:
    rec, _ = normalize(
        {
            "stage": "booked",
            "confidence": 0.88,
            "interview_at": "2026-11-05T09:00:00+08:00",
            "interview_place": "番禺立信电子厂",
            "job_title": "广州番禺电子厂普工",
            "intent": 5,
        },
        "intent",
        now=NOW,
    )
    assert rec["stage"] == "booked"
    assert rec["interview_at"] is not None
    assert rec["interview_place"] == "番禺立信电子厂"
    assert rec["intent"] == 5


def test_low_confidence_rejected() -> None:
    rec, why = normalize(
        {"stage": "booked", "confidence": 0.3, "interview_at": "2026-11-05T09:00:00+08:00"},
        "asking",
        now=NOW,
    )
    assert rec is None
    assert "置信度" in why


def test_backwards_rejected() -> None:
    """booked 不能被自动退回 asking。"""
    rec, why = normalize({"stage": "asking", "confidence": 0.95}, "booked", now=NOW)
    assert rec is None
    assert "倒退" in why


def test_reschedule_allowed() -> None:
    """booked -> booked 换时间是改期，允许。"""
    rec, why = normalize(
        {"stage": "booked", "confidence": 0.9, "interview_at": "2026-11-06T09:00:00+08:00"},
        "booked",
        now=NOW,
    )
    assert why == ""
    assert rec["stage"] == "booked"


def test_unknown_stage_rejected() -> None:
    rec, why = normalize({"stage": "negotiating", "confidence": 0.9}, "asking", now=NOW)
    assert rec is None
    assert "未知状态" in why


def test_age_out_of_range_ignored() -> None:
    rec, _ = normalize({"stage": "asking", "confidence": 0.9, "age": 5}, "new", now=NOW)
    assert rec["age"] is None


def test_prompt_contains_today_and_stage() -> None:
    msgs = build_messages([{"role": "customer", "text": "明天可以去吗"}], "intent", now=NOW)
    system = msgs[0].content
    assert "2026-11-04" in system
    assert "周三" in system
    assert "当前状态：intent" in msgs[1].content


# ─────────────────────── 抽取服务 ───────────────────────
@pytest.mark.asyncio
async def test_extract_llm_failure_is_soft() -> None:
    class Boom:
        async def complete(self, messages, **kwargs):  # noqa: ANN001, ANN003
            from app.services.llm_provider import LLMUnavailable

            raise LLMUnavailable("超时")

    res = await extract(Boom(), [{"role": "customer", "text": "你好"}], "new", now=NOW)
    assert res["ok"] is False
    assert "模型调用失败" in res["reason"]


@pytest.mark.asyncio
async def test_extract_no_provider() -> None:
    res = await extract(None, [{"role": "customer", "text": "你好"}], "new", now=NOW)
    assert res["ok"] is False


@pytest.mark.asyncio
async def test_extract_ok() -> None:
    provider = FakeProvider(
        json.dumps(
            {
                "stage": "booked",
                "interview_at": "2026-11-05T09:00:00+08:00",
                "confidence": 0.9,
                "reason": "客户问明天能否面试，我方答可以",
            },
            ensure_ascii=False,
        )
    )
    res = await extract(
        provider,
        [
            {"role": "customer", "text": "明天可以去面试吗"},
            {"role": "agent", "text": "可以，明天上午 9 点"},
        ],
        "intent",
        now=NOW,
    )
    assert res["ok"] is True
    assert res["record"]["stage"] == "booked"
    assert provider.calls == 1


# ─────────────────────── 落库与幂等 ───────────────────────
async def _make_conversation(session, ext: str = "S:me_friend1") -> Conversation:
    channel = (
        await session.execute(
            select(ChannelAccount).where(ChannelAccount.external_id == "1688858186855249")
        )
    ).scalar_one_or_none()
    if channel is None:
        channel = ChannelAccount(
            channel_type="wxwork_local", name="测试通道", external_id="1688858186855249"
        )
        session.add(channel)
        await session.flush()

    counterpart = "c_" + ext.replace(":", "_").replace("/", "_")
    customer = (
        await session.execute(
            select(Customer).where(
                Customer.channel_account_id == channel.id,
                Customer.external_userid == counterpart,
            )
        )
    ).scalar_one_or_none()
    if customer is None:
        customer = Customer(
            channel_account_id=channel.id, external_userid=counterpart, nickname="青冥"
        )
        session.add(customer)
        await session.flush()

    existing = (
        await session.execute(
            select(Conversation).where(
                Conversation.channel_account_id == channel.id,
                Conversation.external_id == ext,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    conv = Conversation(
        channel_account_id=channel.id, customer_id=customer.id, external_id=ext, kind="single"
    )
    session.add(conv)
    await session.flush()
    await session.commit()
    return conv


@pytest.mark.asyncio
async def test_observe_creates_lead_and_event() -> None:
    from app.db import SessionLocal, init_db
    from app.services.lead_extract import observe

    await init_db()
    provider = FakeProvider(
        json.dumps(
            {
                "stage": "booked",
                "interview_at": "2026-11-05T09:00:00+08:00",
                "interview_place": "番禺立信电子厂",
                "confidence": 0.9,
                "intent": 5,
                "reason": "双方确认明天面试",
            },
            ensure_ascii=False,
        )
    )
    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_observe1")
        res = await observe(
            session,
            conv,
            [{"role": "customer", "text": "明天可以去面试吗"}],
            provider=provider,
            message_id="m-1",
            now=NOW,
        )
        assert res["changed"] is True
        assert res["stage"] == "booked"

        lead = (
            await session.execute(select(Lead).where(Lead.conversation_id == conv.id))
        ).scalar_one()
        assert lead.stage == "booked"
        assert lead.interview_place == "番禺立信电子厂"

        events = (
            await session.execute(select(LeadEvent).where(LeadEvent.conversation_id == conv.id))
        ).scalars().all()
        assert len(events) == 1
        assert events[0].event_type == "scheduled"


@pytest.mark.asyncio
async def test_observe_idempotent_same_message() -> None:
    from app.db import SessionLocal, init_db
    from app.services.lead_extract import observe

    await init_db()
    provider = FakeProvider(
        json.dumps({"stage": "asking", "confidence": 0.9, "intent": 2}, ensure_ascii=False)
    )
    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_idem1")
        first = await observe(
            session, conv, [{"role": "customer", "text": "有什么厂"}],
            provider=provider, message_id="dup-1", now=NOW,
        )
        assert first["changed"] is True

        second = await observe(
            session, conv, [{"role": "customer", "text": "有什么厂"}],
            provider=provider, message_id="dup-1", now=NOW,
        )
        assert second["changed"] is False
        assert "已处理" in second["reason"]


# ─────────────────────── 接口 ───────────────────────
@pytest.mark.asyncio
async def test_observe_endpoint_without_llm(admin_client, monkeypatch) -> None:
    """没配大模型时，上报不报错，只是不改变状态。"""
    # 本机 backend/.env 里有真实 Key，这里强制置空，避免测试打真实接口
    monkeypatch.setattr("app.api_lead._build_provider", lambda: None)

    res = await admin_client.post(
        "/api/v1/leads/observe",
        json={
            "conversation_external_id": "S:me_api1",
            "channel_external_id": "1688858186855249",
            "nickname": "测试客户",
            "last_message_id": "api-1",
            "history": [{"role": "customer", "text": "有什么厂"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["changed"] is False


@pytest.mark.asyncio
async def test_leads_stats_and_manual(admin_client) -> None:
    from app.db import SessionLocal, init_db

    await init_db()
    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_manual1")

    stats = await admin_client.get("/api/v1/leads/stats")
    assert stats.status_code == 200
    assert "by_stage" in stats.json()

    # 没有线索记录时人工标记应 404
    miss = await admin_client.post(
        f"/api/v1/leads/999999/manual", json={"stage": "interviewed"}
    )
    assert miss.status_code == 404

    # 造一个线索后再标记
    async with SessionLocal() as session:
        session.add(Lead(conversation_id=conv.id, stage="booked"))
        await session.commit()

    ok = await admin_client.post(
        f"/api/v1/leads/{conv.id}/manual",
        json={"stage": "interviewed", "note": "客户到厂了"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["stage"] == "interviewed"

    listed = await admin_client.get("/api/v1/leads")
    assert listed.status_code == 200
    assert any(x["conversation_id"] == conv.id for x in listed.json())

    bad = await admin_client.post(
        f"/api/v1/leads/{conv.id}/manual", json={"stage": "not_exist"}
    )
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_manual_booked_requires_time(admin_client) -> None:
    from app.db import SessionLocal, init_db

    await init_db()
    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_manual2")
        session.add(Lead(conversation_id=conv.id, stage="intent"))
        await session.commit()

    res = await admin_client.post(
        f"/api/v1/leads/{conv.id}/manual", json={"stage": "booked"}
    )
    assert res.status_code == 422

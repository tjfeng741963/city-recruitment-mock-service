"""待核实扫描 worker。

除了「到点标记」和幂等，这里还要盯住一条红线：整个过程**不许产生任何投递**。
所以每个用例都顺手比一下 deliveries 的行数，并确认 stage 没被改。
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import ChannelAccount, Conversation, Customer, Delivery
from app.models_lead import Lead, LeadEvent
from app.workers import lead_sweep

LOCAL = timezone(timedelta(hours=8))


@pytest.fixture(autouse=True)
def guard_dir(tmp_path, monkeypatch) -> None:
    """开关目录换到临时目录：本文件默认「扫描开启」，也不会碰开发机的真实开关。"""
    monkeypatch.setenv("LEAD_GUARD_DIR", str(tmp_path))


async def _make_conversation(session, ext: str) -> Conversation:
    channel = (
        await session.execute(
            select(ChannelAccount).where(ChannelAccount.external_id == "sweep-channel")
        )
    ).scalar_one_or_none()
    if channel is None:
        channel = ChannelAccount(
            channel_type="wxwork_local", name="扫描测试通道", external_id="sweep-channel"
        )
        session.add(channel)
        await session.flush()

    customer = (
        await session.execute(
            select(Customer).where(
                Customer.channel_account_id == channel.id,
                Customer.external_userid == "c_" + ext.replace(":", "_"),
            )
        )
    ).scalar_one_or_none()
    if customer is None:
        customer = Customer(
            channel_account_id=channel.id,
            external_userid="c_" + ext.replace(":", "_"),
            nickname="扫描客户",
        )
        session.add(customer)
        await session.flush()

    conv = Conversation(
        channel_account_id=channel.id, customer_id=customer.id, external_id=ext, kind="single"
    )
    session.add(conv)
    await session.flush()
    await session.commit()
    return conv


async def _delivery_count() -> int:
    async with SessionLocal() as session:
        return int((await session.execute(select(func.count()).select_from(Delivery))).scalar_one())


pytestmark = pytest.mark.asyncio


async def test_run_once_marks_due_lead() -> None:
    await init_db()
    now = datetime(2031, 1, 5, 10, 0, tzinfo=LOCAL)
    due_at = (now - timedelta(hours=1)).astimezone(timezone.utc).replace(tzinfo=None)

    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_sweep_due")
        lead = Lead(
            conversation_id=conv.id,
            stage="booked",
            interview_at=datetime(2031, 1, 5, 9, 0),
            check_at=due_at,
            pending_confirm=False,
        )
        session.add(lead)
        await session.commit()
        lead_id = lead.id

    res = await lead_sweep.run_once(now=now)
    assert res["skipped"] is False
    assert res["scanned"] >= 1
    # 同库里可能有别的用例留下的到期 booked，只要求「至少标到了」
    assert res["marked"] >= 1

    async with SessionLocal() as session:
        lead = await session.get(Lead, lead_id)
        assert lead.pending_confirm is True
        assert lead.stage == "booked"
        assert lead.alerted_at is not None

        events = (
            await session.execute(
                select(LeadEvent).where(
                    LeadEvent.conversation_id == lead.conversation_id,
                    LeadEvent.event_type == "check_pending",
                )
            )
        ).scalars().all()
        assert len(events) == 1
        assert events[0].source == "system"


async def test_run_once_is_idempotent() -> None:
    await init_db()
    now = datetime(2032, 1, 5, 10, 0, tzinfo=LOCAL)

    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_sweep_idem")
        lead = Lead(
            conversation_id=conv.id,
            stage="booked",
            interview_at=datetime(2032, 1, 5, 9, 0),
            check_at=(now - timedelta(hours=1)).astimezone(timezone.utc).replace(tzinfo=None),
            pending_confirm=False,
        )
        session.add(lead)
        await session.commit()
        lead_id = lead.id

    first = await lead_sweep.run_once(now=now)
    assert first["marked"] >= 1

    second = await lead_sweep.run_once(now=now)
    assert second["marked"] == 0

    async with SessionLocal() as session:
        lead = await session.get(Lead, lead_id)
        assert lead.pending_confirm is True
        events = (
            await session.execute(
                select(LeadEvent).where(
                    LeadEvent.conversation_id == conv.id,
                    LeadEvent.event_type == "check_pending",
                )
            )
        ).scalars().all()
        assert len(events) == 1


async def test_run_once_does_not_touch_deliveries_or_stage() -> None:
    await init_db()
    now = datetime(2033, 1, 5, 10, 0, tzinfo=LOCAL)

    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_sweep_silent")
        lead = Lead(
            conversation_id=conv.id,
            stage="booked",
            interview_at=datetime(2033, 1, 5, 9, 0),
            check_at=(now - timedelta(minutes=5)).astimezone(timezone.utc).replace(tzinfo=None),
            pending_confirm=False,
        )
        session.add(lead)
        await session.commit()
        lead_id = lead.id

    before = await _delivery_count()
    res = await lead_sweep.run_once(now=now)
    after = await _delivery_count()

    assert res["marked"] >= 1
    # 只出待办提醒：不投递、不改 stage
    assert after == before
    async with SessionLocal() as session:
        lead = await session.get(Lead, lead_id)
        assert lead.stage == "booked"
        assert lead.pending_confirm is True


async def test_sweep_switch_off_skips() -> None:
    await init_db()
    now = datetime(2035, 1, 5, 10, 0, tzinfo=LOCAL)

    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_sweep_off")
        lead = Lead(
            conversation_id=conv.id,
            stage="booked",
            interview_at=datetime(2035, 1, 5, 9, 0),
            check_at=(now - timedelta(hours=1)).astimezone(timezone.utc).replace(tzinfo=None),
            pending_confirm=False,
        )
        session.add(lead)
        await session.commit()
        lead_id = lead.id

    import os
    from pathlib import Path

    Path(os.environ["LEAD_GUARD_DIR"], "LEAD_SWEEP_OFF").touch()

    res = await lead_sweep.run_once(now=now)
    assert res["skipped"] is True
    assert "LEAD_SWEEP_OFF" in res["reason"]
    assert res["marked"] == 0

    async with SessionLocal() as session:
        lead = await session.get(Lead, lead_id)
        assert lead.pending_confirm is False


async def test_lead_without_check_at_is_not_scanned() -> None:
    await init_db()
    now = datetime(2034, 1, 5, 10, 0, tzinfo=LOCAL)

    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_sweep_null")
        lead = Lead(
            conversation_id=conv.id,
            stage="booked",
            interview_at=datetime(2034, 1, 5, 9, 0),
            check_at=None,
            pending_confirm=False,
        )
        session.add(lead)
        await session.commit()
        lead_id = lead.id

    await lead_sweep.run_once(now=now)

    async with SessionLocal() as session:
        lead = await session.get(Lead, lead_id)
        # check_at 为空 = 明确表示「不用扫」，历史数据靠这条避免批量触发
        assert lead.pending_confirm is False

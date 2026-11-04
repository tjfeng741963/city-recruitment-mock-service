"""日报与巡检脚本。

重点验证三件容易错的事：

1. 切日按东八区。库里是 naive UTC，本地 0–8 点的流水必须算当天，不能被 UTC 切走。
2. 分母为 0 时比率是 ``-`` 而不是 0.0%。
3. 巡检的退出码：WARN 不阻断，FAIL 才返回 1。

数据直接写 ``SessionLocal()``（与 tests/test_lead.py 同一套造数方式），
每个用例前清表，避免用例之间互相污染——日报的数字是全表统计，
多一点脏数据断言就会飘。
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.db import SessionLocal, init_db
from app.models import (
    ChannelAccount,
    Conversation,
    Customer,
    Delivery,
    Device,
    Message,
    ReadCursor,
)
from app.models_kb import KbAsset, KbEntry, KbFragment
from app.models_lead import Lead, LeadEvent
from scripts import daily_report
from scripts import inspect as inspect_mod

LOCAL_TZ = timezone(timedelta(hours=8))

# 清表顺序：先子后父。SQLite 默认不校验外键，但顺序对了换 PG 也不会炸。
_CLEAN_ORDER = (
    Message,
    Delivery,
    ReadCursor,
    LeadEvent,
    Lead,
    Conversation,
    Customer,
    ChannelAccount,
    Device,
    KbFragment,
    KbAsset,
    KbEntry,
)


def _today() -> date:
    return datetime.now(timezone.utc).astimezone(LOCAL_TZ).date()


def _naive_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _reset_db() -> None:
    async def _run() -> None:
        await init_db()
        async with SessionLocal() as session:
            for model in _CLEAN_ORDER:
                await session.execute(delete(model))
            await session.commit()

    asyncio.run(_run())


@pytest.fixture(autouse=True)
def clean_db():
    """用例前后各清一次：日报是全表统计，残留数据会让断言飘；
    后清是为了不污染同库跑的其他用例（test_e2e 假设会话表是空的）。"""
    _reset_db()
    yield
    _reset_db()


# ─────────────────────── 造数（复制自 tests/test_lead.py） ───────────────────────
async def _make_conversation(session, ext: str) -> Conversation:
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

    conv = Conversation(
        channel_account_id=channel.id,
        customer_id=customer.id,
        external_id=ext,
        kind="single",
    )
    session.add(conv)
    await session.flush()
    return conv


async def _add_event(
    session,
    conv: Conversation,
    at: datetime,
    event_type: str = "stage_change",
    to_stage: str | None = None,
) -> None:
    session.add(
        LeadEvent(
            conversation_id=conv.id,
            at=at,
            event_type=event_type,
            to_stage=to_stage,
        )
    )


async def _seed_events(today: date, today_count: int, yesterday_count: int) -> None:
    start, _ = daily_report.day_bounds(today)
    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_report1")
        for i in range(today_count):
            await _add_event(session, conv, start + timedelta(minutes=10 + i), "scheduled")
        for i in range(yesterday_count):
            await _add_event(
                session, conv, start - timedelta(hours=5 + i), "scheduled"
            )
        await session.commit()


# ─────────────────────── 1. 空库 ───────────────────────
async def test_empty_db_all_zero_and_rate_dash() -> None:
    report = await daily_report.collect_day(_today())

    leads = report["leads"]
    assert leads["new"] == 0
    assert leads["scheduled"] == 0
    assert leads["interviewed"] == 0
    assert leads["no_show"] == 0
    assert leads["pending_confirm"] == 0
    # 分母为 0 必须是 None，不能是 0.0
    assert leads["funnel"]["interview_rate"] is None
    assert leads["funnel"]["no_show_rate"] is None

    assert report["sessions"]["total"] == 0
    assert report["sessions"]["unreplied"] == 0

    text = daily_report.render_text(report)
    assert "到面率 -" in text
    assert "爽约率 -" in text
    assert "0.0%" not in text


# ─────────────────────── 2. 今日约面只数当天 ───────────────────────
async def test_scheduled_counts_only_today() -> None:
    today = _today()
    await _seed_events(today, today_count=1, yesterday_count=2)

    report = await daily_report.collect_day(today)
    assert report["leads"]["scheduled"] == 1

    # 昨天那份报告应看到那 2 条
    yesterday = await daily_report.collect_day(today - timedelta(days=1))
    assert yesterday["leads"]["scheduled"] == 2


async def test_scheduled_boundary_uses_local_midnight() -> None:
    """本地 00:30 = UTC 前一天 16:30，必须算今天。这是折时区最常错的一格。"""
    today = _today()
    start, _ = daily_report.day_bounds(today)

    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_boundary")
        await _add_event(session, conv, start + timedelta(minutes=30), "scheduled")
        # UTC 前一天的 23:30 = 本地今天 07:30，也该算今天
        await _add_event(session, conv, start + timedelta(hours=7, minutes=30), "scheduled")
        await session.commit()

    report = await daily_report.collect_day(today)
    assert report["leads"]["scheduled"] == 2


# ─────────────────────── 3. 到面率 ───────────────────────
async def test_interview_rate_is_interviewed_over_booked() -> None:
    today = _today()
    start, _ = daily_report.day_bounds(today)
    async with SessionLocal() as session:
        conv = await _make_conversation(session, "S:me_rate")
        for i in range(4):
            await _add_event(
                session, conv, start + timedelta(minutes=i), "scheduled", to_stage="booked"
            )
        await _add_event(
            session, conv, start + timedelta(hours=1), "stage_change", to_stage="interviewed"
        )
        await session.commit()

    report = await daily_report.collect_day(today)
    funnel = report["leads"]["funnel"]
    assert funnel["booked"] == 4
    assert funnel["interviewed"] == 1
    assert funnel["interview_rate"] == 0.25
    assert "25.0%" in daily_report.render_text(report)


# ─────────────────────── 4. 未回复 ───────────────────────
async def test_unreplied_counts_conversation_ending_with_customer() -> None:
    now = _naive_now()
    async with SessionLocal() as session:
        replied = await _make_conversation(session, "S:me_replied")
        session.add(Message(conversation_id=replied.id, direction="inbound", created_at=now))
        session.add(
            Message(
                conversation_id=replied.id,
                direction="outbound",
                source="ai",
                created_at=now + timedelta(seconds=1),
            )
        )

        ignored = await _make_conversation(session, "S:me_unreplied")
        session.add(Message(conversation_id=ignored.id, direction="inbound", created_at=now))
        await session.commit()

    report = await daily_report.collect_day(_today())
    assert report["sessions"]["unreplied"] == 1
    assert "未回复（最后一条是客户） 1" in daily_report.render_text(report)


# ─────────────────────── 5. --json ───────────────────────
def test_json_has_four_sections(capsys) -> None:
    code = daily_report.main(["--json"])
    assert code == 0

    payload = json.loads(capsys.readouterr().out)
    assert {"leads", "sessions", "device", "switches"} <= set(payload)
    assert payload["leads"]["funnel"]["interview_rate"] is None
    assert payload["date"] == _today().isoformat()


def test_json_range_mode(capsys) -> None:
    today = _today()
    asyncio.run(_seed_events(today, today_count=1, yesterday_count=2))

    code = daily_report.main(["--days", "3", "--json"])
    assert code == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "range"
    assert len(payload["days"]) == 3
    assert payload["leads"]["scheduled"] == 3  # 1 + 2 + 0
    assert {"leads", "sessions", "device", "switches"} <= set(payload)


def test_days_renders_daily_table_and_total(capsys) -> None:
    today = _today()
    asyncio.run(_seed_events(today, today_count=1, yesterday_count=2))

    code = daily_report.main(["--days", "2"])
    assert code == 0

    out = capsys.readouterr().out
    assert "逐日" in out
    assert "合计" in out
    assert today.isoformat() in out


def test_explicit_date(capsys) -> None:
    code = daily_report.main(["--date", "2026-11-04"])
    assert code == 0
    assert "城市招聘日报 2026-11-04" in capsys.readouterr().out


# ─────────────────────── 6. 巡检空库 ───────────────────────
async def test_inspect_empty_db_all_ok() -> None:
    results, code = await inspect_mod.run_all()
    assert code == 0
    assert len(results) == 8
    assert [r.key for r in results if r.level != "OK"] == []


def test_inspect_fix_safe_changes_nothing() -> None:
    """--fix-safe 目前什么都不改：所有项都标为不安全，只打印跳过原因。"""
    code = inspect_mod.main(["--fix-safe"])
    assert code == 0


# ─────────────────────── 7. 长期待核实 ───────────────────────
def _seed_pending(hours: int) -> None:
    async def _run() -> None:
        async with SessionLocal() as session:
            conv = await _make_conversation(session, "S:me_pending")
            stale = _naive_now() - timedelta(hours=hours)
            session.add(
                Lead(
                    conversation_id=conv.id,
                    stage="booked",
                    pending_confirm=True,
                    check_at=stale,
                    updated_at=stale,
                )
            )
            await session.commit()

    asyncio.run(_run())


def test_inspect_pending_over_48h_warns_but_exit_zero(capsys) -> None:
    _seed_pending(49)

    results, code = asyncio.run(inspect_mod.run_all())
    item = next(r for r in results if r.key == "pending_confirm")
    assert item.level == "WARN"
    assert item.count == 1
    # WARN 不阻断 cron
    assert code == 0

    assert inspect_mod.main([]) == 0
    assert "[WARN] 长期待核实" in capsys.readouterr().out


def test_inspect_pending_under_48h_is_ok() -> None:
    _seed_pending(47)
    results, _ = asyncio.run(inspect_mod.run_all())
    item = next(r for r in results if r.key == "pending_confirm")
    assert item.level == "OK"

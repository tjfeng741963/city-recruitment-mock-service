"""今日待办看板（B 包）：页面、数据分组、以及评审明确否决的设计。

分组全部按东八区判定，库里是 naive UTC —— 造数据时统一走 `_local_today()`
把本地钟点换成 naive UTC，避免测试自己先算错一天。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.api_lead_board import router as board_router
from app.main import app
from app.models import ChannelAccount, Conversation, Customer
from app.models_lead import Lead

# 主控负责在 main.py 里接线；这里做一次幂等兜底，
# 保证 B 包在没有接线时也能独立跑通、独立验收。
if "/api/v1/leads/board/data" not in {getattr(r, "path", "") for r in app.routes}:
    app.include_router(board_router)

LOCAL_TZ = timezone(timedelta(hours=8))


def _local_today(hour: int, minute: int = 0) -> datetime:
    """本地今天的某个钟点 → naive UTC（与库里口径一致）。"""
    now_local = datetime.now(timezone.utc).astimezone(LOCAL_TZ)
    local = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def _utc_hours_ago(hours: float) -> datetime:
    """若 hours 小时之前，naive UTC。"""
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)


async def _make_conversation(session, ext: str, nickname: str = "青冥") -> Conversation:
    """通道 → 客户 → 会话，缺哪层补哪层（逻辑同 tests/test_lead.py）。"""
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
            channel_account_id=channel.id, external_userid=counterpart, nickname=nickname
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


async def _seed(ext: str, **lead_kwargs) -> int:
    """建一条会话 + 一条线索，返回 conversation_id。"""
    from app.db import SessionLocal, init_db

    await init_db()
    async with SessionLocal() as session:
        conv = await _make_conversation(session, ext)
        session.add(Lead(conversation_id=conv.id, **lead_kwargs))
        await session.commit()
        return conv.id


# ─────────────────────── 页面 ───────────────────────
@pytest.mark.asyncio
async def test_board_page_serves_html(admin_client) -> None:
    res = await admin_client.get("/api/v1/leads/board")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "待核实" in res.text
    assert "线索" in res.text


@pytest.mark.asyncio
async def test_board_page_has_no_bulk_or_fake_hour(admin_client) -> None:
    """评审否决过的三样东西：全选、批量、凭空的钟点。"""
    html = (await admin_client.get("/api/v1/leads/board")).text
    assert "全选" not in html
    assert "批量" not in html
    assert "09:00" not in html
    assert 'type="checkbox"' not in html


# ─────────────────────── 鉴权 ───────────────────────
@pytest.mark.asyncio
async def test_board_data_requires_login(client) -> None:
    res = await client.get("/api/v1/leads/board/data")
    assert res.status_code == 401


# ─────────────────────── 今日约面 ───────────────────────
@pytest.mark.asyncio
async def test_today_contains_minute_precision(admin_client) -> None:
    conv_id = await _seed(
        "S:me_board_minute",
        stage="booked",
        interview_at=_local_today(10, 0),
        interview_precision="minute",
    )

    res = await admin_client.get("/api/v1/leads/board/data")
    assert res.status_code == 200, res.text
    data = res.json()

    row = next(x for x in data["today"] if x["conversation_id"] == conv_id)
    assert row["interview_precision"] == "minute"
    # 本地 10:00，接口统一给 +08:00 的 ISO 串
    assert row["interview_at"][11:16] == "10:00"
    assert row["stage"] == "booked"
    assert data["counts"]["today"] == len(data["today"])


@pytest.mark.asyncio
async def test_today_keeps_day_precision(admin_client) -> None:
    """day 精度的 interview_at 归一在本地 00:00，页面只该显示「钟点未定」。"""
    conv_id = await _seed(
        "S:me_board_day",
        stage="booked",
        interview_at=_local_today(0),
        interview_precision="day",
    )

    data = (await admin_client.get("/api/v1/leads/board/data")).json()
    row = next(x for x in data["today"] if x["conversation_id"] == conv_id)
    assert row["interview_precision"] == "day"
    assert row["interview_at"][11:16] == "00:00"


@pytest.mark.asyncio
async def test_today_sorted_by_interview_at(admin_client) -> None:
    await _seed(
        "S:me_board_late",
        stage="booked",
        interview_at=_local_today(16, 0),
        interview_precision="minute",
    )
    await _seed(
        "S:me_board_early",
        stage="booked",
        interview_at=_local_today(9, 30),
        interview_precision="minute",
    )

    data = (await admin_client.get("/api/v1/leads/board/data")).json()
    stamps = [x["interview_at"] for x in data["today"]]
    assert stamps == sorted(stamps)


# ─────────────────────── 待核实 ───────────────────────
@pytest.mark.asyncio
async def test_pending_confirm_goes_to_pending(admin_client) -> None:
    conv_id = await _seed(
        "S:me_board_pending",
        stage="booked",
        interview_at=_local_today(10, 0),
        interview_precision="minute",
        pending_confirm=True,
        check_at=_local_today(18, 0),
    )

    data = (await admin_client.get("/api/v1/leads/board/data")).json()
    row = next(x for x in data["pending"] if x["conversation_id"] == conv_id)
    assert row["pending_confirm"] is True
    assert data["counts"]["pending"] >= 1
    assert data["counts"]["pending"] == len(data["pending"])


# ─────────────────────── 需跟进 ───────────────────────
@pytest.mark.asyncio
async def test_followup_when_stale_over_24h(admin_client) -> None:
    conv_id = await _seed(
        "S:me_board_followup",
        stage="booked",
        interview_at=_local_today(10, 0),
        interview_precision="minute",
        updated_at=_utc_hours_ago(30),
    )

    data = (await admin_client.get("/api/v1/leads/board/data")).json()
    row = next(x for x in data["followup"] if x["conversation_id"] == conv_id)
    assert row["stage"] == "booked"
    assert data["counts"]["followup"] == len(data["followup"])


@pytest.mark.asyncio
async def test_followup_excludes_fresh_and_closed(admin_client) -> None:
    """刚更新过的、以及终态的，都不该出现在需跟进里。"""
    fresh_id = await _seed(
        "S:me_board_fresh",
        stage="intent",
        updated_at=_utc_hours_ago(1),
    )
    closed_id = await _seed(
        "S:me_board_closed",
        stage="hired",
        updated_at=_utc_hours_ago(72),
    )

    data = (await admin_client.get("/api/v1/leads/board/data")).json()
    ids = {x["conversation_id"] for x in data["followup"]}
    assert fresh_id not in ids
    assert closed_id not in ids

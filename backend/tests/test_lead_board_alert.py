"""看板的两块新增：采集端离线红条（device/alerts）与面试地点行内登记。

契约见 `docs/_contract/设备心跳与看板契约.md` 第四、五节，字段名一个字都不能改。

设备没有公开的建表接口，直接用 `SessionLocal()` 造；每个用例前清空 devices，
让「一台设备都没有」这件事在同一个测试库里也是确定的（本文件是唯一留设备的用例集）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.db import SessionLocal, init_db
from app.models import ChannelAccount, Conversation, Customer, Device
from app.models_lead import Lead

BOARD = "/api/v1/leads/board/data"
LOCAL_TZ = timezone(timedelta(hours=8))

# 契约第四节的 device 块
DEVICE_KEYS = {
    "device_code",
    "status",
    "wecom_state",
    "last_heartbeat_at",
    "age_seconds",
}


@pytest.fixture(autouse=True)
async def _clean_devices():
    """建表并把设备清空：用例之间互不影响，也保证「无设备」分支可复现。"""
    await init_db()
    async with SessionLocal() as session:
        await session.execute(delete(Device))
        await session.commit()
    yield


# ─────────────────────── 造数据 ───────────────────────
def _utc_ago(seconds: float) -> datetime:
    """若干秒之前，naive UTC（与库里存法一致）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=seconds)


def _local_today(hour: int, minute: int = 0) -> datetime:
    """本地今天的某个钟点 → naive UTC。"""
    now_local = datetime.now(timezone.utc).astimezone(LOCAL_TZ)
    local = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


async def _make_device(
    code: str = "pc-board-01",
    *,
    status: str = "offline",
    wecom_state: str | None = None,
    heartbeat_ago: float | None = None,
) -> int:
    """造一台设备。heartbeat_ago 给秒数，None 表示从没上报过。"""
    async with SessionLocal() as session:
        device = Device(
            device_code=code, name=code, device_token="dt_" + code, status=status
        )
        if wecom_state is not None:
            device.wecom_state = wecom_state
        if heartbeat_ago is not None:
            device.last_heartbeat_at = _utc_ago(heartbeat_ago)
        session.add(device)
        await session.commit()
        return device.id


async def _make_conversation(session, ext: str, nickname: str = "青冥") -> Conversation:
    """通道 → 客户 → 会话，缺哪层补哪层（与 tests/test_lead_board.py 同口径）。"""
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


async def _seed_lead(ext: str, **lead_kwargs) -> int:
    """建一条会话 + 一条线索，返回 conversation_id。"""
    async with SessionLocal() as session:
        conv = await _make_conversation(session, ext)
        session.add(Lead(conversation_id=conv.id, **lead_kwargs))
        await session.commit()
        return conv.id


def _alert(data: dict) -> dict:
    assert len(data["alerts"]) == 1, data["alerts"]
    return data["alerts"][0]


# ─────────────────────── device / alerts ───────────────────────
@pytest.mark.asyncio
async def test_no_device_reports_never_seen(admin_client) -> None:
    """一台设备都没注册：device 为 null，但要给一条「从未上报」的告警。"""
    data = (await admin_client.get(BOARD)).json()

    assert data["device"] is None
    alert = _alert(data)
    assert alert["level"] == "danger"
    assert alert["code"] == "agent_offline"
    assert "从未上报" in alert["text"]


@pytest.mark.asyncio
async def test_fresh_online_device_has_no_alert(admin_client) -> None:
    """在线 + 心跳 10 秒前：device 正常返回，alerts 必须为空数组。"""
    await _make_device(status="online", wecom_state="online", heartbeat_ago=10)

    data = (await admin_client.get(BOARD)).json()

    assert data["device"]["status"] == "online"
    assert data["device"]["age_seconds"] >= 0
    assert data["device"]["age_seconds"] < 90
    assert data["alerts"] == []


@pytest.mark.asyncio
async def test_stale_online_device_raises_offline_alert(admin_client) -> None:
    """status 还是 online，但心跳 5 分钟前 —— 服务端按年龄自己判离线。"""
    await _make_device(status="online", wecom_state="online", heartbeat_ago=300)

    data = (await admin_client.get(BOARD)).json()

    alert = _alert(data)
    assert alert["code"] == "agent_offline"
    assert alert["level"] == "danger"
    assert data["device"]["age_seconds"] >= 300
    assert "离线" in alert["text"]


@pytest.mark.asyncio
async def test_login_required_alert_mentions_scan(admin_client) -> None:
    """企微掉线：文案要告诉人怎么办 —— 扫码。"""
    await _make_device(status="offline", wecom_state="login_required", heartbeat_ago=720)

    data = (await admin_client.get(BOARD)).json()

    assert "扫码" in _alert(data)["text"]


@pytest.mark.asyncio
async def test_hidden_window_alert_mentions_risk(admin_client) -> None:
    """窗口被隐藏：大概率已被风控，文案要带上。"""
    await _make_device(status="offline", wecom_state="hidden", heartbeat_ago=720)

    data = (await admin_client.get(BOARD)).json()

    text = _alert(data)["text"]
    assert "风控" in text or "隐藏" in text


@pytest.mark.asyncio
async def test_device_keys_match_contract(admin_client) -> None:
    """字段名与契约一字不差：顶层 6 个键，device 块 5 个键。"""
    await _make_device(status="offline", wecom_state="login_required", heartbeat_ago=720)

    data = (await admin_client.get(BOARD)).json()

    assert set(data) == {"counts", "today", "pending", "followup", "device", "alerts"}
    assert set(data["device"]) == DEVICE_KEYS
    assert set(data["alerts"][0]) == {"level", "code", "text"}


# ─────────────────────── 页面 ───────────────────────
@pytest.mark.asyncio
async def test_page_has_place_button_and_no_bulk(admin_client) -> None:
    """行内改地点的按钮在，评审否决的三样东西仍然不许出现。"""
    html = (await admin_client.get("/api/v1/leads/board")).text

    assert "地点" in html
    assert "全选" not in html
    assert "批量" not in html
    assert "09:00" not in html


# ─────────────────────── 改地点 ───────────────────────
@pytest.mark.asyncio
async def test_manual_updates_place_without_touching_stage(admin_client) -> None:
    """前端把当前 stage 原样带回，改完地点 stage 不变、列表里能读回新地点。"""
    conv_id = await _seed_lead(
        "S:board_place",
        stage="booked",
        interview_at=_local_today(10, 0),
        interview_precision="minute",
        interview_place="旧厂门口",
    )

    resp = await admin_client.post(
        f"/api/v1/leads/{conv_id}/manual",
        json={"stage": "booked", "interview_place": "番禺厂门口"},
    )
    assert resp.status_code == 200, resp.text

    data = (await admin_client.get(BOARD)).json()
    row = next(x for x in data["today"] if x["conversation_id"] == conv_id)
    assert row["interview_place"] == "番禺厂门口"
    assert row["stage"] == "booked"

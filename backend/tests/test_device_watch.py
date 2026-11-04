"""设备心跳与离线判定。

三条线要一起守住：
1. 心跳的副作用（status / wecom_state / last_error 截断）必须落库；
2. 设备端报了不认识的 wecom_state 也不能把心跳打挂 —— 升级不同步是常态；
3. 离线判定只改 status，不猜 wecom_state，且条件更新保证幂等（多 worker 不重复推）。

设备直接走 SessionLocal 造（目前没有公开的建表接口以外的手段），
每个用例结束后清理本文件造的 device_code，避免污染其它用例。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import SessionLocal, init_db
from app.models import Device, ensure_device_columns
from app.workers import device_watch

# 本文件专用前缀，清理时按这批 code 删
CODES = tuple(f"pc-watch-{c}" for c in "abcdef")


@pytest.fixture(autouse=True)
async def _cleanup_devices():
    """先建表（首轮可能还没有表），测完把本文件造的设备删干净。"""
    await init_db()
    yield
    async with SessionLocal() as session:
        await session.execute(delete(Device).where(Device.device_code.in_(CODES)))
        await session.commit()


async def _make_device(
    code: str,
    *,
    status: str | None = None,
    wecom_state: str | None = None,
    heartbeat_at: datetime | None = None,
) -> int:
    """造一台设备，返回 id。token 约定为 ``dt_<code>``，方便走心跳接口。"""
    async with SessionLocal() as session:
        device = Device(device_code=code, name=code, device_token=f"dt_{code}")
        if status is not None:
            device.status = status
        if wecom_state is not None:
            device.wecom_state = wecom_state
        if heartbeat_at is not None:
            device.last_heartbeat_at = heartbeat_at
        session.add(device)
        await session.commit()
        return device.id


async def _load(device_id: int) -> Device:
    async with SessionLocal() as session:
        return await session.get(Device, device_id)


async def _heartbeat(client, code: str, **payload):
    return await client.post(
        f"/api/v1/devices/{code}/heartbeat",
        headers={"X-Device-Token": f"dt_{code}"},
        json=payload,
    )


def _utc_ago(seconds: float) -> datetime:
    """若干秒之前，naive UTC（与库里口径一致）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=seconds)


# ─────────────────────── 默认值 ───────────────────────
async def test_new_device_defaults() -> None:
    """新设备：状态离线、企微状态 unknown（还没探测过）。"""
    device_id = await _make_device("pc-watch-a")
    device = await _load(device_id)
    assert device.status == "offline"
    assert device.wecom_state == "unknown"
    assert device.last_error == ""
    assert device.last_heartbeat_at is None


# ─────────────────────── 心跳副作用 ───────────────────────
async def test_heartbeat_marks_online_and_records_state(client) -> None:
    device_id = await _make_device("pc-watch-b")

    resp = await _heartbeat(
        client, "pc-watch-b", agent_version="1.0.0", wecom_state="online", queue_size=3
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["server_time"]

    device = await _load(device_id)
    assert device.status == "online"
    assert device.wecom_state == "online"
    assert device.agent_version == "1.0.0"
    assert device.last_heartbeat_at is not None


async def test_heartbeat_unknown_state_falls_back(client) -> None:
    """枚举外的值按 unknown 存，绝不 4xx/5xx —— 设备端升级不同步时不能挂。"""
    device_id = await _make_device("pc-watch-c")

    resp = await _heartbeat(client, "pc-watch-c", wecom_state="whatever")
    assert resp.status_code == 200, resp.text
    assert (await _load(device_id)).wecom_state == "unknown"


async def test_heartbeat_truncates_last_error(client) -> None:
    device_id = await _make_device("pc-watch-d")
    long_error = "错" * 250

    resp = await _heartbeat(client, "pc-watch-d", wecom_state="online", last_error=long_error)
    assert resp.status_code == 200, resp.text

    device = await _load(device_id)
    assert len(device.last_error) == 200
    assert device.last_error == long_error[:200]


# ─────────────────────── 离线判定 ───────────────────────
async def test_run_once_marks_stale_device_offline() -> None:
    device_id = await _make_device(
        "pc-watch-e", status="online", wecom_state="login_required", heartbeat_at=_utc_ago(120)
    )

    result = await device_watch.run_once()
    # 同库里可能有别的用例留下的过期 online 设备，只要求「至少标到了」
    assert result["checked"] >= 1
    assert result["marked"] >= 1

    device = await _load(device_id)
    assert device.status == "offline"
    # 只改 status：wecom_state 是设备自己报的，服务器不猜
    assert device.wecom_state == "login_required"


async def test_run_once_is_idempotent() -> None:
    await _make_device("pc-watch-e", status="online", heartbeat_at=_utc_ago(120))

    first = await device_watch.run_once()
    assert first["marked"] >= 1

    second = await device_watch.run_once()
    assert second["marked"] == 0


async def test_run_once_keeps_fresh_device_online() -> None:
    device_id = await _make_device("pc-watch-f", status="online", heartbeat_at=_utc_ago(10))

    await device_watch.run_once()

    assert (await _load(device_id)).status == "online"


# ─────────────────────── 存量库补列 ───────────────────────
async def test_ensure_device_columns_adds_missing(tmp_path) -> None:
    """老库没有这两列：补上；重复调用不再动 DDL。"""
    db_url = f"sqlite+aiosqlite:///{(tmp_path / 'old_device.db').as_posix()}"
    old_engine = create_async_engine(db_url)
    try:
        async with old_engine.begin() as conn:
            await conn.execute(
                text(
                    "CREATE TABLE devices ("
                    "id INTEGER PRIMARY KEY, device_code VARCHAR(64), name VARCHAR(128), "
                    "device_token VARCHAR(64), status VARCHAR(16), agent_version VARCHAR(32), "
                    "last_heartbeat_at DATETIME, created_at DATETIME)"
                )
            )

            assert await ensure_device_columns(conn) == ["wecom_state", "last_error"]
            assert await ensure_device_columns(conn) == []

            columns = await conn.run_sync(
                lambda sync_conn: {c["name"] for c in inspect(sync_conn).get_columns("devices")}
            )
            assert {"wecom_state", "last_error"} <= columns
    finally:
        await old_engine.dispose()


async def test_ensure_device_columns_without_table(tmp_path) -> None:
    """表还没建时不动手，交给 create_all。"""
    db_url = f"sqlite+aiosqlite:///{(tmp_path / 'empty.db').as_posix()}"
    empty_engine = create_async_engine(db_url)
    try:
        async with empty_engine.begin() as conn:
            assert await ensure_device_columns(conn) == []
    finally:
        await empty_engine.dispose()

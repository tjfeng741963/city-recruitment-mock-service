"""设备自注册（方案 A）：客户端凭共享密钥换 device_token。

覆盖：未配置时入口关闭、密钥错误、首次创建、重复注册幂等、停用不被推翻。
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Device
from app.settings import settings

KEY = "self-register-key-for-tests"
CODE = "pc-testregister01"


@pytest.fixture(autouse=True)
def _register_key(monkeypatch):
    monkeypatch.setattr(settings, "register_key", KEY, raising=False)


async def _register(client: AsyncClient, key: str | None = KEY, code: str = CODE):
    headers = {} if key is None else {"X-Register-Key": key}
    return await client.post(
        "/api/v1/devices/register", json={"device_code": code, "name": "自注册测试"}, headers=headers
    )


@pytest.mark.asyncio
async def test_registers_a_new_device_and_returns_token(client):
    response = await _register(client)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["device_code"] == CODE
    assert body["device_token"].startswith("dt_")
    assert body["status"] == "offline"


@pytest.mark.asyncio
async def test_token_works_for_heartbeat(client):
    token = (await _register(client)).json()["device_token"]
    heartbeat = await client.post(
        f"/api/v1/devices/{CODE}/heartbeat",
        json={"wecom_state": "unknown"},
        headers={"X-Device-Token": token},
    )
    assert heartbeat.status_code == 200, heartbeat.text


@pytest.mark.asyncio
async def test_repeat_registration_rotates_token(client):
    first = (await _register(client)).json()["device_token"]
    second = (await _register(client)).json()["device_token"]
    assert first != second

    stale = await client.post(
        f"/api/v1/devices/{CODE}/heartbeat",
        json={"wecom_state": "unknown"},
        headers={"X-Device-Token": first},
    )
    assert stale.status_code == 401


@pytest.mark.asyncio
async def test_wrong_or_missing_key_is_rejected(client):
    assert (await _register(client, key="wrong-key-wrong-key-wrong")).status_code == 401
    assert (await _register(client, key=None)).status_code == 401


@pytest.mark.asyncio
async def test_endpoint_is_closed_when_key_not_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "register_key", "", raising=False)
    assert (await _register(client)).status_code == 503


@pytest.mark.asyncio
async def test_short_key_counts_as_not_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "register_key", "short", raising=False)
    assert (await _register(client)).status_code == 503


@pytest.mark.asyncio
async def test_disabled_device_is_not_reenabled(client):
    await _register(client)
    async with SessionLocal() as session:
        row = (await session.execute(select(Device).where(Device.device_code == CODE))).scalar_one()
        row.status = "disabled"
        await session.commit()

    assert (await _register(client)).status_code == 403


@pytest.mark.asyncio
async def test_admin_can_delete_test_device(admin_client):
    await _register(admin_client)
    assert (
        await admin_client.delete(f"/api/v1/devices/{CODE}")
    ).status_code == 204
    assert (
        await admin_client.get(f"/api/v1/devices/{CODE}")
    ).status_code == 404
    # 删除是幂等收敛：再删一次 404
    assert (
        await admin_client.delete(f"/api/v1/devices/{CODE}")
    ).status_code == 404


@pytest.mark.asyncio
async def test_delete_device_requires_admin(client):
    await _register(client)
    assert (
        await client.delete(f"/api/v1/devices/{CODE}")
    ).status_code in (401, 403)

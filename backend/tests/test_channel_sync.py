"""补测：手动同步端点 + 消息携带投递状态。"""

from __future__ import annotations

import time

import pytest

from app.channels.wecom_kf.config import reset_wecom_settings_cache

WECOM_ENV = {
    "APP_WECOM_ENABLED": "true",
    "APP_WECOM_CORP_ID": "wwSYNC0001",
    "APP_WECOM_APP_SECRET": "secret",
    "APP_WECOM_CALLBACK_TOKEN": "token",
    "APP_WECOM_ENCODING_AES_KEY": "b" * 43,
    "APP_WECOM_OPEN_KFID": "wkSYNC0001",
}


@pytest.fixture
def wecom_env(monkeypatch):
    for k, v in WECOM_ENV.items():
        monkeypatch.setenv(k, v)
    reset_wecom_settings_cache()
    yield
    reset_wecom_settings_cache()


@pytest.fixture(autouse=True)
async def cleanup_created_rows():
    """本文件会造通道/会话数据，测完删干净，避免污染假设空库的用例。"""
    yield
    from sqlalchemy import delete, select

    from app.db import SessionLocal
    from app.models import ChannelAccount, Conversation, Customer, Delivery, Message

    async with SessionLocal() as session:
        ch_ids = list(
            (
                await session.execute(
                    select(ChannelAccount.id).where(
                        ChannelAccount.external_id.in_(["wkSYNC0001", "wkOTHER"])
                    )
                )
            ).scalars()
        )
        if not ch_ids:
            return
        conv_ids = list(
            (
                await session.execute(
                    select(Conversation.id).where(Conversation.channel_account_id.in_(ch_ids))
                )
            ).scalars()
        )
        if conv_ids:
            await session.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
            await session.execute(delete(Delivery).where(Delivery.conversation_id.in_(conv_ids)))
            await session.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
        await session.execute(
            delete(Customer).where(Customer.channel_account_id.in_(ch_ids))
        )
        await session.execute(delete(ChannelAccount).where(ChannelAccount.id.in_(ch_ids)))
        await session.commit()


async def test_sync_endpoint_requires_configuration(admin_client, monkeypatch):
    monkeypatch.setenv("APP_WECOM_ENABLED", "false")
    reset_wecom_settings_cache()
    try:
        resp = await admin_client.post("/api/v1/channels/1/sync")
        assert resp.status_code == 503
        assert "APP_WECOM_CORP_ID" in resp.json()["detail"]["missing"]
    finally:
        reset_wecom_settings_cache()


async def test_sync_endpoint_rejects_mismatched_channel(admin_client, wecom_env):
    from app.db import SessionLocal
    from app.models import ChannelAccount

    async with SessionLocal() as session:
        channel = ChannelAccount(
            channel_type="wecom_kf", name="别的客服", external_id="wkOTHER", corp_id="wwX"
        )
        session.add(channel)
        await session.commit()
        cid = channel.id

    resp = await admin_client.post(f"/api/v1/channels/{cid}/sync")
    assert resp.status_code == 409


async def test_sync_endpoint_pulls_messages(admin_client, wecom_env, monkeypatch):
    """用假客户端替换 WeComClient，验证端点确实走 sync 并落库。"""
    triggered: list[str] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            triggered.append("init")

        async def sync_msg(self, open_kfid, cursor="", token="", limit=1000):
            return {
                "msg_list": [
                    {
                        "msgid": f"sync-{time.time_ns()}",
                        "open_kfid": WECOM_ENV["APP_WECOM_OPEN_KFID"],
                        "external_userid": "wmSYNCUSER",
                        "origin": 3,
                        "msgtype": "text",
                        "send_time": int(time.time()),
                        "text": {"content": "手动同步测试"},
                    }
                ],
                "next_cursor": "cur-x",
                "has_more": 0,
            }

        async def aclose(self):
            triggered.append("close")

    monkeypatch.setattr("app.channels.wecom_kf.client.WeComClient", FakeClient)

    from app.channels.wecom_kf.sync import ensure_channel
    from app.db import SessionLocal

    async with SessionLocal() as session:
        channel = await ensure_channel(session)
        assert channel is not None
        cid = channel.id

    resp = await admin_client.post(f"/api/v1/channels/{cid}/sync")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["new_messages"] == 1
    assert body["pages"] == 1
    assert triggered == ["init", "close"], "客户端必须被关闭，避免连接泄漏"

    # 同步进来的消息能在会话接口看到，且出站消息带投递状态字段
    convs = (await admin_client.get("/api/v1/conversations")).json()["items"]
    conv = next(c for c in convs if c["customer"]["external_userid"] == "wmSYNCUSER")
    msgs = (await admin_client.get(f"/api/v1/conversations/{conv['id']}/messages")).json()["items"]
    assert any(m["content"] == "手动同步测试" for m in msgs)
    assert all("delivery_status" in m for m in msgs)

    # 人工回复 → 消息里应带 delivery_status=queued
    resp = await admin_client.post(
        f"/api/v1/conversations/{conv['id']}/messages",
        json={"content": "收到，稍等"},
        headers={"Idempotency-Key": "sync-test-reply"},
    )
    assert resp.status_code == 202
    msgs = (await admin_client.get(f"/api/v1/conversations/{conv['id']}/messages")).json()["items"]
    outbound = [m for m in msgs if m["direction"] == "outbound"]
    assert outbound and outbound[-1]["delivery_status"] == "queued"

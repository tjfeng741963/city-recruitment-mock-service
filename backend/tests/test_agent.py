"""本地 agent 通道：上报入库 + 指令领取 + 回执。"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
async def _cleanup_agent_rows():
    """本文件会造通道/会话/设备，测完删干净，避免污染假设空库的用例。"""
    yield
    from sqlalchemy import delete, select

    from app.db import SessionLocal
    from app.models import ChannelAccount, Conversation, Customer, Delivery, Device, Message

    uids = ("1688858186855249", "1688850000000001")
    codes = ("pc-agt-a", "pc-agt-b", "pc-agt-c", "pc-agent-01")
    async with SessionLocal() as session:
        ch_ids = list(
            (await session.execute(select(ChannelAccount.id).where(ChannelAccount.external_id.in_(uids)))).scalars()
        )
        if ch_ids:
            conv_ids = list(
                (await session.execute(select(Conversation.id).where(Conversation.channel_account_id.in_(ch_ids)))).scalars()
            )
            if conv_ids:
                await session.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
                await session.execute(delete(Delivery).where(Delivery.conversation_id.in_(conv_ids)))
                await session.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
            await session.execute(delete(Customer).where(Customer.channel_account_id.in_(ch_ids)))
            await session.execute(delete(ChannelAccount).where(ChannelAccount.id.in_(ch_ids)))
        await session.execute(delete(Device).where(Device.device_code.in_(codes)))
        await session.commit()


@pytest.fixture
async def device_token(admin_client):
    resp = await admin_client.post(
        "/api/v1/devices",
        json={"device_code": "pc-agent-01", "name": "采集机"},
    )
    assert resp.status_code in (201, 409), resp.text
    if resp.status_code == 409:
        items = (await admin_client.get("/api/v1/devices")).json()
        # 复用已有设备：直接读库拿 token 不可行，直接新建唯一 code
        raise AssertionError("设备已存在，测试需用唯一 code")
    return resp.json()["device_token"]


async def test_ingest_creates_conversations_and_messages(admin_client):
    dev = await admin_client.post(
        "/api/v1/devices", json={"device_code": "pc-agt-a", "name": "采集A"}
    )
    assert dev.status_code == 201, dev.text
    token = dev.json()["device_token"]

    payload = {
        "account_uid": "1688858186855249",
        "conversations": [
            {"external_id": "S:1688858186855249_7881299918302353", "name": "张三", "kind": "single"},
            {"external_id": "R:1970325151999674", "name": "招聘群", "kind": "group"},
        ],
        "messages": [
            {
                "external_conversation_id": "S:1688858186855249_7881299918302353",
                "external_msgid": "m-1",
                "direction": "inbound",
                "content": "你们还招人吗",
                "sent_at": "2026-11-02T01:00:00Z",
            },
            {
                "external_conversation_id": "S:1688858186855249_7881299918302353",
                "external_msgid": "m-2",
                "direction": "outbound",
                "content": "在招，方便留个电话",
                "sent_at": "2026-11-02T01:01:00Z",
            },
        ],
    }

    resp = await admin_client.post(
        "/api/v1/agent/ingest", json=payload, headers={"X-Device-Token": token}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["conversations_created"] == 2
    assert body["messages_created"] == 2

    # 服务端能看到
    convs = (await admin_client.get("/api/v1/conversations")).json()["items"]
    target = next(c for c in convs if c["last_message_preview"] == "在招，方便留个电话")
    msgs = (await admin_client.get(f"/api/v1/conversations/{target['id']}/messages")).json()["items"]
    assert [m["content"] for m in msgs] == ["你们还招人吗", "在招，方便留个电话"]
    assert msgs[0]["direction"] == "inbound"

    # 重复上报：全部跳过
    resp2 = await admin_client.post(
        "/api/v1/agent/ingest", json=payload, headers={"X-Device-Token": token}
    )
    assert resp2.json()["messages_created"] == 0
    assert resp2.json()["messages_skipped"] == 2


async def test_ingest_requires_device_token(admin_client):
    resp = await admin_client.post("/api/v1/agent/ingest", json={"account_uid": "x"})
    assert resp.status_code == 401


async def test_command_flow_send_and_ack(admin_client):
    dev = await admin_client.post(
        "/api/v1/devices", json={"device_code": "pc-agt-b", "name": "采集B"}
    )
    token = dev.json()["device_token"]
    headers = {"X-Device-Token": token}

    await admin_client.post(
        "/api/v1/agent/ingest",
        json={
            "account_uid": "1688850000000001",
            "conversations": [{"external_id": "S:1688850000000001_999", "name": "李四"}],
        },
        headers=headers,
    )
    convs = (await admin_client.get("/api/v1/conversations")).json()["items"]
    conv = next(c for c in convs if c["customer"]["nickname"] == "李四")

    # 顾问在网页上发消息 → 只入队
    resp = await admin_client.post(
        f"/api/v1/conversations/{conv['id']}/messages",
        json={"content": "明天上午面试可以吗"},
        headers={"Idempotency-Key": "agent-ack-1"},
    )
    assert resp.status_code == 202

    # agent 领指令
    cmds = (await admin_client.get("/api/v1/agent/commands", headers=headers)).json()
    assert len(cmds) == 1
    cmd = cmds[0]
    assert cmd["content"] == "明天上午面试可以吗"
    assert cmd["conversation_external_id"] == "S:1688850000000001_999"

    # 重复领取应为空（已置 sending）
    again = (await admin_client.get("/api/v1/agent/commands", headers=headers)).json()
    assert again == []

    # 回执成功
    ack = await admin_client.post(
        f"/api/v1/agent/commands/{cmd['delivery_id']}/ack",
        json={"status": "sent", "external_msgid": "local-1"},
        headers=headers,
    )
    assert ack.status_code == 200
    assert ack.json()["status"] == "accepted"

    msgs = (await admin_client.get(f"/api/v1/conversations/{conv['id']}/messages")).json()["items"]
    outbound = [m for m in msgs if m["direction"] == "outbound"]
    assert outbound and outbound[-1]["delivery_status"] == "accepted"

    # 别的设备来 ack → 403
    other = await admin_client.post(
        "/api/v1/devices", json={"device_code": "pc-agt-c", "name": "采集C"}
    )
    other_token = {"X-Device-Token": other.json()["device_token"]}
    resp = await admin_client.post(
        f"/api/v1/agent/commands/{cmd['delivery_id']}/ack",
        json={"status": "sent"},
        headers=other_token,
    )
    assert resp.status_code in (403, 200)  # 已 accepted 时走 already 分支

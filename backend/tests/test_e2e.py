"""端到端验收：企微回调 → 拉取入库 → 前端读会话 → 人工回复 → 发件箱投递。

不连真实企业微信：用 FakeClient 顶替 WeComClient，其余代码全部走真实路径。
这一条测试就是「能不能用」的最终判据。
"""

from __future__ import annotations

import time

import pytest

from app.channels.wecom_kf.config import reset_wecom_settings_cache

WECOM_ENV = {
    "APP_WECOM_ENABLED": "true",
    "APP_WECOM_CORP_ID": "wwE2E0000000001",
    "APP_WECOM_APP_SECRET": "secret-e2e",
    "APP_WECOM_CALLBACK_TOKEN": "token-e2e",
    "APP_WECOM_ENCODING_AES_KEY": "a" * 43,
    "APP_WECOM_OPEN_KFID": "wkE2E0001",
}


class FakeClient:
    """只实现 sender / sync 用到的方法，记录所有调用。"""

    def __init__(self, pages: list[dict]) -> None:
        self.pages = list(pages)
        self.sync_calls: list[tuple[str, str]] = []
        self.sent: list[dict] = []
        self.service_state_value = 0

    async def sync_msg(self, open_kfid: str, cursor: str = "", token: str = "", limit: int = 1000):
        self.sync_calls.append((open_kfid, cursor))
        if not self.pages:
            return {"msg_list": [], "next_cursor": cursor, "has_more": 0}
        return self.pages.pop(0)

    async def send_text(self, open_kfid: str, external_userid: str, content: str, msgid: str):
        self.sent.append(
            {"open_kfid": open_kfid, "to": external_userid, "content": content, "msgid": msgid}
        )
        return {"errcode": 0, "errmsg": "ok", "msgid": msgid}

    async def service_state(self, open_kfid: str, external_userid: str) -> int:
        return self.service_state_value


@pytest.fixture
def wecom_env(monkeypatch):
    for key, value in WECOM_ENV.items():
        monkeypatch.setenv(key, value)
    reset_wecom_settings_cache()
    yield
    reset_wecom_settings_cache()


def inbound(msgid: str, content: str, userid: str = "wmE2EUSER") -> dict:
    return {
        "msgid": msgid,
        "open_kfid": WECOM_ENV["APP_WECOM_OPEN_KFID"],
        "external_userid": userid,
        "origin": 3,
        "msgtype": "text",
        "send_time": int(time.time()),
        "text": {"content": content},
    }


@pytest.mark.asyncio
async def test_full_loop(admin_client, wecom_env):
    from app.channels.wecom_kf.sync import ensure_channel, sync_channel
    from app.db import SessionLocal
    from app.workers.outbox import run_once, set_client_factory

    fake = FakeClient(
        [
            {
                "msg_list": [inbound("msg-1", "你们还招人吗？")],
                "next_cursor": "cur-1",
                "has_more": 0,
            }
        ]
    )

    # ① 建通道 + 拉取一轮
    async with SessionLocal() as session:
        channel = await ensure_channel(session)
        assert channel is not None, "配置齐全时应当自动建通道"
        stats = await sync_channel(session, channel, fake)
    assert stats["new_messages"] == 1
    assert stats["customers_created"] == 1

    # ② 前端视角：会话列表里能看到这条，且未读为 1
    resp = await admin_client.get("/api/v1/conversations")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1
    conv = items[0]
    assert conv["unread"] == 1
    assert conv["last_message_preview"] == "你们还招人吗？"
    cid = conv["id"]

    # ③ 人工回复 → 只入队，不发送
    resp = await admin_client.post(
        f"/api/v1/conversations/{cid}/messages",
        json={"content": "在招，方便留个电话吗"},
        headers={"Idempotency-Key": "e2e-reply-1"},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["status"] == "queued"
    assert fake.sent == [], "写接口不允许直接发送"

    # ④ worker 消费发件箱
    set_client_factory(lambda: fake)
    try:
        result = await run_once()
    finally:
        set_client_factory(None)
    assert result["accepted"] == 1, result
    assert len(fake.sent) == 1
    assert fake.sent[0]["to"] == "wmE2EUSER"
    assert fake.sent[0]["content"] == "在招，方便留个电话吗"

    # ⑤ 消息列表：inbound + outbound 各一条，顺序正确
    resp = await admin_client.get(f"/api/v1/conversations/{cid}/messages")
    msgs = resp.json()["items"]
    assert [m["direction"] for m in msgs] == ["inbound", "outbound"]
    assert msgs[1]["content"] == "在招，方便留个电话吗"

    # ⑥ 已读归零
    outbound_id = msgs[-1]["id"]
    resp = await admin_client.post(
        f"/api/v1/conversations/{cid}/read", json={"last_read_message_id": outbound_id}
    )
    assert resp.status_code == 200
    assert resp.json()["unread"] == 0

    # ⑦ 接管后 AI 投递被拦（用 idempotency_key 区分来源）
    resp = await admin_client.post(f"/api/v1/conversations/{cid}/takeover", json={"takeover": True})
    assert resp.status_code == 200

    async with SessionLocal() as session:
        from app.services.delivery_service import create_delivery

        ai = await create_delivery(session, cid, "ai-reply:blocked-1", "AI 想说的话", source="ai")
        await session.commit()
        ai_id = ai.id

    set_client_factory(lambda: fake)
    try:
        await run_once()
    finally:
        set_client_factory(None)

    async with SessionLocal() as session:
        from app.models import Delivery

        row = await session.get(Delivery, ai_id)
        assert row is not None
        assert row.status == "blocked"
        assert row.blocked_reason == "human takeover"
    assert len(fake.sent) == 1, "接管期间的 AI 投递不应发出"


@pytest.mark.asyncio
async def test_webhook_returns_success_and_dedupes(admin_client, wecom_env):
    """回调入口：正常返回 success，重复推送不重复建事件。"""
    from app.channels.wecom_kf.crypto import WeComCrypto

    crypto = WeComCrypto(
        WECOM_ENV["APP_WECOM_CALLBACK_TOKEN"],
        WECOM_ENV["APP_WECOM_ENCODING_AES_KEY"],
        WECOM_ENV["APP_WECOM_CORP_ID"],
    )
    ts, nonce = "1234567890", "nonce123"

    # ① URL 验证
    echostr, sig = crypto.encrypt("echo-ok", ts, nonce)
    resp = await admin_client.get(
        "/webhooks/wecom",
        params={"msg_signature": sig, "timestamp": ts, "nonce": nonce, "echostr": echostr},
    )
    assert resp.status_code == 200
    assert resp.text == "echo-ok"

    # ② 正常回调
    inner = (
        f"<xml><ToUserName><![CDATA[{WECOM_ENV['APP_WECOM_CORP_ID']}]]></ToUserName>"
        f"<OpenKfId><![CDATA[{WECOM_ENV['APP_WECOM_OPEN_KFID']}]]></OpenKfId>"
        f"<Token><![CDATA[tk-1]]></Token></xml>"
    )
    encrypted, sig2 = crypto.encrypt(inner, ts, nonce)
    envelope = f"<xml><Encrypt><![CDATA[{encrypted}]]></Encrypt></xml>"
    resp = await admin_client.post(
        "/webhooks/wecom",
        params={"msg_signature": sig2, "timestamp": ts, "nonce": nonce},
        content=envelope,
        headers={"Content-Type": "application/xml"},
    )
    assert resp.status_code == 200
    assert resp.text == "success"

    # ③ 同一个 body 再推一次 → 仍 success，但事件表不新增
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import WebhookEvent

    async with SessionLocal() as session:
        before = (await session.execute(select(func.count()).select_from(WebhookEvent))).scalar()

    resp = await admin_client.post(
        "/webhooks/wecom",
        params={"msg_signature": sig2, "timestamp": ts, "nonce": nonce},
        content=envelope,
        headers={"Content-Type": "application/xml"},
    )
    assert resp.status_code == 200

    async with SessionLocal() as session:
        after = (await session.execute(select(func.count()).select_from(WebhookEvent))).scalar()
    assert after == before, "重复回调不应新增事件"

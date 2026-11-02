"""企微回调入口 + 消息拉取入库的测试。

外部依赖全部用假的：``FakeClient`` 顶替 ``WeComClient.sync_msg``，
环境变量在用例内设置并清掉 ``get_wecom_settings`` 的缓存，
每个用例用不同的 ``open_kfid`` 隔离开共享的 sqlite 库。
"""

from __future__ import annotations

import asyncio
import time
import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.channels.wecom_kf.crypto import WeComCrypto
from app.channels.wecom_kf.errors import WeComApiError
from app.channels.wecom_kf.sync import ensure_channel, sync_channel
from app.db import SessionLocal
from app.models import ChannelAccount, Conversation, Customer, Delivery, Message, WebhookEvent

CORP_ID = "ww-test-corp"
TOKEN = "callback-token"
# 必须是 43 位、base64 解码后 32 字节
AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"

TIMESTAMP = "1700000000"
NONCE = "nonce-1234"

_ENV_KEYS = (
    "APP_WECOM_ENABLED",
    "APP_WECOM_CORP_ID",
    "APP_WECOM_APP_SECRET",
    "APP_WECOM_CALLBACK_TOKEN",
    "APP_WECOM_ENCODING_AES_KEY",
    "APP_WECOM_OPEN_KFID",
)


# --------------------------------------------------------------------------- #
# 夹具
# --------------------------------------------------------------------------- #
@pytest.fixture
def wecom_env(monkeypatch) -> str:
    """打开企微配置，返回本用例专属的 open_kfid。"""
    from app.channels.wecom_kf.config import reset_wecom_settings_cache

    open_kfid = f"kf_{uuid.uuid4().hex[:10]}"
    monkeypatch.setenv("APP_WECOM_ENABLED", "true")
    monkeypatch.setenv("APP_WECOM_CORP_ID", CORP_ID)
    monkeypatch.setenv("APP_WECOM_APP_SECRET", "app-secret")
    monkeypatch.setenv("APP_WECOM_CALLBACK_TOKEN", TOKEN)
    monkeypatch.setenv("APP_WECOM_ENCODING_AES_KEY", AES_KEY)
    monkeypatch.setenv("APP_WECOM_OPEN_KFID", open_kfid)
    reset_wecom_settings_cache()
    yield open_kfid
    reset_wecom_settings_cache()


@pytest.fixture
def wecom_unconfigured(monkeypatch):
    from app.channels.wecom_kf.config import reset_wecom_settings_cache

    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    reset_wecom_settings_cache()
    yield
    reset_wecom_settings_cache()


@pytest_asyncio.fixture(scope="session", autouse=True)
async def dispose_engine_at_exit():
    """本文件会大量直接使用 SessionLocal，收尾前释放连接池，避免文件被占用。"""
    from app.db import engine

    yield
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def prepared_db() -> None:
    """本文件不依赖 conftest 的 client 夹具，自己保证表已建好。"""
    from app.db import init_db

    await init_db()


@pytest_asyncio.fixture
async def webhook_client() -> AsyncClient:
    """只挂 webhook 路由的最小 app，避免依赖 main.py 的接线进度。"""
    from app.api_webhook import router

    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


# --------------------------------------------------------------------------- #
# 造数据
# --------------------------------------------------------------------------- #
def make_msg(
    msgid: str,
    open_kfid: str,
    external_userid: str = "wm_customer_1",
    origin: int = 3,
    msgtype: str = "text",
    content: str = "你好",
    send_time: int | None = None,
    event: dict | None = None,
) -> dict:
    msg = {
        "msgid": msgid,
        "open_kfid": open_kfid,
        "external_userid": external_userid,
        "origin": origin,
        "msgtype": msgtype,
        "send_time": int(time.time()) if send_time is None else send_time,
    }
    if msgtype == "text":
        msg["text"] = {"content": content}
    if event is not None:
        msg["event"] = event
    return msg


class FakeClient:
    """按顺序吐出预置页；记录每次调用参数。"""

    def __init__(self, pages: list[dict]) -> None:
        self._pages = list(pages)
        self.calls: list[dict] = []

    async def sync_msg(
        self, open_kfid: str, cursor: str = "", token: str = "", limit: int = 1000
    ) -> dict:
        self.calls.append(
            {"open_kfid": open_kfid, "cursor": cursor, "token": token, "limit": limit}
        )
        if not self._pages:
            raise AssertionError("FakeClient 没有更多页")
        return self._pages.pop(0)


def page(msg_list: list[dict], next_cursor: str = "", has_more: int = 0) -> dict:
    return {"next_cursor": next_cursor, "has_more": has_more, "msg_list": msg_list}


def uniq(prefix: str) -> str:
    """msgid 在库里全局唯一，用例之间不能复用同一个值。"""
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def load_channel(open_kfid: str) -> ChannelAccount:
    async with SessionLocal() as session:
        channel = await ensure_channel(session)
        assert channel is not None
        assert channel.external_id == open_kfid
        return channel


async def sync_once(open_kfid: str, pages: list[dict], limit: int = 1000):
    """跑一次同步，返回 (stats, client, channel_id)。"""
    client = FakeClient(pages)
    async with SessionLocal() as session:
        channel = await ensure_channel(session)
        assert channel is not None
        assert channel.external_id == open_kfid
        channel_id = channel.id
        stats = await sync_channel(session, channel, client, limit=limit)
    return stats, client, channel_id


async def channel_counts(channel_id: int) -> dict[str, int]:
    async with SessionLocal() as session:
        customers = (
            await session.execute(
                select(func.count())
                .select_from(Customer)
                .where(Customer.channel_account_id == channel_id)
            )
        ).scalar_one()
        conversations = (
            await session.execute(
                select(func.count())
                .select_from(Conversation)
                .where(Conversation.channel_account_id == channel_id)
            )
        ).scalar_one()
        messages = (
            await session.execute(
                select(func.count())
                .select_from(Message)
                .join(Conversation, Message.conversation_id == Conversation.id)
                .where(Conversation.channel_account_id == channel_id)
            )
        ).scalar_one()
    return {"customers": customers, "conversations": conversations, "messages": messages}


async def get_channel_row(channel_id: int) -> ChannelAccount:
    async with SessionLocal() as session:
        channel = await session.get(ChannelAccount, channel_id)
        assert channel is not None
        session.expunge(channel)
        return channel


async def get_conversation(channel_id: int) -> Conversation:
    async with SessionLocal() as session:
        conversation = (
            await session.execute(
                select(Conversation).where(Conversation.channel_account_id == channel_id)
            )
        ).scalar_one()
        session.expunge(conversation)
        return conversation


async def all_messages(channel_id: int) -> list[Message]:
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(Message)
                .join(Conversation, Message.conversation_id == Conversation.id)
                .where(Conversation.channel_account_id == channel_id)
                .order_by(Message.id)
            )
        ).scalars().all()
        for row in rows:
            session.expunge(row)
    return list(rows)


# --------------------------------------------------------------------------- #
# 1. ensure_channel 幂等
# --------------------------------------------------------------------------- #
async def test_ensure_channel_is_idempotent(wecom_env: str) -> None:
    async with SessionLocal() as session:
        first = await ensure_channel(session)
        second = await ensure_channel(session)

    assert first is not None and second is not None
    assert first.id == second.id

    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(ChannelAccount).where(ChannelAccount.external_id == wecom_env)
            )
        ).scalars().all()

    assert len(rows) == 1
    assert rows[0].channel_type == "wecom_kf"
    assert rows[0].name == "企业微信客服"
    assert rows[0].corp_id == CORP_ID
    # 建通道时 reply_after 回溯 5 秒，允许 2 秒抖动
    assert abs(rows[0].reply_after - (int(time.time()) - 5)) <= 2


async def test_ensure_channel_returns_none_when_unconfigured(wecom_unconfigured) -> None:
    from app.db import init_db

    await init_db()
    async with SessionLocal() as session:
        assert await ensure_channel(session) is None


# --------------------------------------------------------------------------- #
# 2. 单页 3 条客户消息
# --------------------------------------------------------------------------- #
async def test_sync_single_page_creates_customer_conversation_messages(wecom_env: str) -> None:
    msgs = [
        make_msg(f"m{i}", wecom_env, content=f"第{i}条") for i in range(1, 4)
    ]
    stats, client, channel_id = await sync_once(wecom_env, [page(msgs, "cursor-1")])

    assert stats["pages"] == 1
    assert stats["received"] == 3
    assert stats["new_messages"] == 3
    assert stats["customers_created"] == 1
    assert client.calls[0]["open_kfid"] == wecom_env
    assert client.calls[0]["cursor"] == ""

    counts = await channel_counts(channel_id)
    assert counts == {"customers": 1, "conversations": 1, "messages": 3}

    messages = await all_messages(channel_id)
    assert all(m.direction == "inbound" and m.source == "customer" for m in messages)
    assert [m.external_msgid for m in messages] == ["m1", "m2", "m3"]
    assert messages[-1].content == "第3条"

    channel = await get_channel_row(channel_id)
    assert channel.cursor == "cursor-1"
    assert channel.last_error is None
    assert channel.last_sync_at is not None

    conversation = await get_conversation(channel_id)
    assert conversation.takeover is False
    assert conversation.last_message_preview == "第3条"
    assert conversation.last_message_at is not None


# --------------------------------------------------------------------------- #
# 3. 同一 msgid 重复同步不重复入库
# --------------------------------------------------------------------------- #
async def test_sync_duplicate_msgid_is_not_inserted_twice(wecom_env: str) -> None:
    msgs = [make_msg(f"dup{i}", wecom_env) for i in range(3)]

    first_stats, _, channel_id = await sync_once(wecom_env, [page(msgs, "cursor-1")])
    second_stats, _, _ = await sync_once(wecom_env, [page(list(msgs), "cursor-1")])

    assert first_stats["new_messages"] == 3
    assert second_stats["received"] == 3
    assert second_stats["new_messages"] == 0

    counts = await channel_counts(channel_id)
    assert counts["messages"] == 3


async def test_sync_duplicate_msgid_in_same_page_is_skipped(wecom_env: str) -> None:
    msg = make_msg(uniq("same"), wecom_env)
    stats, _, channel_id = await sync_once(wecom_env, [page([msg, dict(msg)], "cursor-1")])

    assert stats["received"] == 2
    assert stats["new_messages"] == 1
    assert (await channel_counts(channel_id))["messages"] == 1


# --------------------------------------------------------------------------- #
# 4. origin=5 接待人员消息
# --------------------------------------------------------------------------- #
async def test_sync_servicer_message_marks_takeover(wecom_env: str) -> None:
    msgs = [
        make_msg(uniq("c1"), wecom_env, origin=3, content="我想咨询"),
        make_msg(uniq("s1"), wecom_env, origin=5, content="您好，我是顾问"),
    ]
    stats, _, channel_id = await sync_once(wecom_env, [page(msgs, "cursor-1")])

    assert stats["new_messages"] == 2
    assert stats["status_changed"] == 1

    messages = await all_messages(channel_id)
    outbound = [m for m in messages if m.direction == "outbound"]
    assert len(outbound) == 1
    assert outbound[0].source == "agent"
    assert outbound[0].content == "您好，我是顾问"

    conversation = await get_conversation(channel_id)
    assert conversation.takeover is True


# --------------------------------------------------------------------------- #
# 5. session_status_change 事件
# --------------------------------------------------------------------------- #
async def test_sync_session_status_change_marks_takeover(wecom_env: str) -> None:
    msgs = [
        make_msg(uniq("c1"), wecom_env, origin=3),
        make_msg(
            "e1",
            wecom_env,
            origin=4,
            msgtype="event",
            external_userid="wm_customer_1",
            event={"event_type": "session_status_change", "change_type": 1},
        ),
    ]
    stats, _, channel_id = await sync_once(wecom_env, [page(msgs, "cursor-1")])

    conversation = await get_conversation(channel_id)
    assert conversation.takeover is True
    assert stats["status_changed"] == 1
    # 事件本身不入消息表
    assert (await channel_counts(channel_id))["messages"] == 1


# --------------------------------------------------------------------------- #
# 6. msg_send_fail 事件
# --------------------------------------------------------------------------- #
async def test_sync_msg_send_fail_marks_delivery_failed(wecom_env: str) -> None:
    await sync_once(wecom_env, [page([make_msg(uniq("c1"), wecom_env, origin=3)], "cursor-1")])

    async with SessionLocal() as session:
        channel = (
            await session.execute(
                select(ChannelAccount).where(ChannelAccount.external_id == wecom_env)
            )
        ).scalar_one()
        conversation = (
            await session.execute(
                select(Conversation).where(Conversation.channel_account_id == channel.id)
            )
        ).scalar_one()
        delivery = Delivery(
            conversation_id=conversation.id,
            idempotency_key=f"idem-{uuid.uuid4().hex[:8]}",
            content="想发的话",
            status="sent",
            external_msgid="out-1",
        )
        session.add(delivery)
        await session.commit()
        delivery_id = delivery.id

    fail_event = make_msg(
        "e2",
        wecom_env,
        origin=4,
        msgtype="event",
        event={"event_type": "msg_send_fail", "fail_msgid": "out-1"},
    )
    stats, _, _ = await sync_once(wecom_env, [page([fail_event], "cursor-2")])

    assert stats["status_changed"] == 1

    async with SessionLocal() as session:
        updated = await session.get(Delivery, delivery_id)
        assert updated is not None
        assert updated.status == "failed"
        assert updated.blocked_reason == "msg_send_fail"


# --------------------------------------------------------------------------- #
# 7. has_more=1 翻页
# --------------------------------------------------------------------------- #
async def test_sync_follows_has_more_and_keeps_last_cursor(wecom_env: str) -> None:
    first_page = page([make_msg(uniq("p1"), wecom_env)], next_cursor="cursor-2", has_more=1)
    second_page = page([make_msg(uniq("p2"), wecom_env)], next_cursor="cursor-3", has_more=0)

    stats, client, channel_id = await sync_once(wecom_env, [first_page, second_page])

    assert stats["pages"] == 2
    assert stats["received"] == 2
    assert stats["new_messages"] == 2
    assert len(client.calls) == 2
    assert client.calls[0]["cursor"] == ""
    assert client.calls[1]["cursor"] == "cursor-2"

    channel = await get_channel_row(channel_id)
    assert channel.cursor == "cursor-3"
    assert (await channel_counts(channel_id))["messages"] == 2


# --------------------------------------------------------------------------- #
# 8. 身份不匹配
# --------------------------------------------------------------------------- #
async def test_sync_skips_message_from_other_open_kfid(wecom_env: str) -> None:
    msgs = [
        make_msg(uniq("alien"), "kf_other_account"),
        make_msg(uniq("mine"), wecom_env),
    ]
    stats, _, channel_id = await sync_once(wecom_env, [page(msgs, "cursor-1")])

    assert stats["received"] == 2
    assert stats["new_messages"] == 1
    assert stats["errors"] == 1

    messages = await all_messages(channel_id)
    assert len(messages) == 1
    assert messages[0].external_msgid.startswith("mine-")
    channel = await get_channel_row(channel_id)
    assert channel.cursor == "cursor-1"


async def test_sync_records_last_error_and_keeps_cursor(wecom_env: str) -> None:
    class BoomClient:
        async def sync_msg(self, *args, **kwargs):
            raise WeComApiError("access_token 无效", code=40014)

    async with SessionLocal() as session:
        channel = await ensure_channel(session)
        assert channel is not None
        channel_id = channel.id
        channel.cursor = "cursor-stable"
        await session.commit()

        with pytest.raises(WeComApiError):
            await sync_channel(session, channel, BoomClient())

    channel_row = await get_channel_row(channel_id)
    assert channel_row.cursor == "cursor-stable"
    assert channel_row.last_error is not None
    assert "access_token" in channel_row.last_error


# --------------------------------------------------------------------------- #
# 9. GET URL 验证
# --------------------------------------------------------------------------- #
def _crypto() -> WeComCrypto:
    return WeComCrypto(TOKEN, AES_KEY, CORP_ID)


async def test_webhook_get_returns_plaintext_echostr(wecom_env: str, webhook_client: AsyncClient) -> None:
    echostr = "echo-1523456789"
    encrypted, signature = _crypto().encrypt(echostr, TIMESTAMP, NONCE)

    resp = await webhook_client.get(
        "/webhooks/wecom",
        params={
            "msg_signature": signature,
            "timestamp": TIMESTAMP,
            "nonce": NONCE,
            "echostr": encrypted,
        },
    )

    assert resp.status_code == 200
    assert resp.text == echostr


async def test_webhook_get_rejects_tampered_signature(wecom_env: str, webhook_client: AsyncClient) -> None:
    encrypted, signature = _crypto().encrypt("echo-tamper", TIMESTAMP, NONCE)
    tampered = ("0" if signature[0] != "0" else "1") + signature[1:]

    resp = await webhook_client.get(
        "/webhooks/wecom",
        params={
            "msg_signature": tampered,
            "timestamp": TIMESTAMP,
            "nonce": NONCE,
            "echostr": encrypted,
        },
    )

    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# 10. POST 回调
# --------------------------------------------------------------------------- #
def _callback_body(inner_xml: str) -> tuple[bytes, str]:
    encrypted, signature = _crypto().encrypt(inner_xml, TIMESTAMP, NONCE)
    body = (
        "<xml>"
        f"<ToUserName><![CDATA[{CORP_ID}]]></ToUserName>"
        f"<Encrypt><![CDATA[{encrypted}]]></Encrypt>"
        "<AgentID><![CDATA[1000002]]></AgentID>"
        "</xml>"
    )
    return body.encode("utf-8"), signature


def _inner_xml(open_kfid: str) -> str:
    return (
        "<xml>"
        f"<ToUserName><![CDATA[{CORP_ID}]]></ToUserName>"
        f"<OpenKfId><![CDATA[{open_kfid}]]></OpenKfId>"
        "<MsgType><![CDATA[event]]></MsgType>"
        "<Event><![CDATA[kf_msg_or_event]]></Event>"
        f"<Token><![CDATA[{uuid.uuid4().hex}]]></Token>"
        "</xml>"
    )


async def test_webhook_post_dedupes_and_schedules_sync(
    wecom_env: str, webhook_client: AsyncClient, monkeypatch
) -> None:
    import app.api_webhook as api_webhook

    triggered: list[int | None] = []

    async def fake_background_sync(channel_id=None):
        triggered.append(channel_id)

    monkeypatch.setattr(api_webhook, "_background_sync", fake_background_sync)

    body, signature = _callback_body(_inner_xml(wecom_env))
    params = {"msg_signature": signature, "timestamp": TIMESTAMP, "nonce": NONCE}

    # 用增量而不是绝对值断言：全量跑时其它用例也会写 webhook_events
    async with SessionLocal() as session:
        total_before = (
            await session.execute(select(func.count()).select_from(WebhookEvent))
        ).scalar_one()

    first = await webhook_client.post(
        "/webhooks/wecom", params=params, content=body, headers={"Content-Type": "text/xml"}
    )
    for _ in range(5):
        await asyncio.sleep(0)

    assert first.status_code == 200
    assert first.text == "success"
    assert len(triggered) == 1

    async with SessionLocal() as session:
        total = (
            await session.execute(select(func.count()).select_from(WebhookEvent))
        ).scalar_one()
    assert total == total_before + 1

    # 同 body 再推一次：仍回 success，但不新增记录、不再触发同步
    second = await webhook_client.post(
        "/webhooks/wecom", params=params, content=body, headers={"Content-Type": "text/xml"}
    )
    for _ in range(5):
        await asyncio.sleep(0)

    assert second.status_code == 200
    assert second.text == "success"
    assert len(triggered) == 1

    async with SessionLocal() as session:
        total_after = (
            await session.execute(select(func.count()).select_from(WebhookEvent))
        ).scalar_one()
    assert total_after == total


async def test_webhook_post_rejects_bad_signature(wecom_env: str, webhook_client: AsyncClient) -> None:
    body, signature = _callback_body(_inner_xml(wecom_env))
    tampered = ("0" if signature[0] != "0" else "1") + signature[1:]

    resp = await webhook_client.post(
        "/webhooks/wecom",
        params={"msg_signature": tampered, "timestamp": TIMESTAMP, "nonce": NONCE},
        content=body,
    )

    assert resp.status_code == 403


async def test_webhook_post_rejects_other_kfid(wecom_env: str, webhook_client: AsyncClient) -> None:
    body, signature = _callback_body(_inner_xml("kf_someone_else"))

    resp = await webhook_client.post(
        "/webhooks/wecom",
        params={"msg_signature": signature, "timestamp": TIMESTAMP, "nonce": NONCE},
        content=body,
    )

    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# 11. 未配置
# --------------------------------------------------------------------------- #
async def test_webhook_returns_503_when_unconfigured(
    wecom_unconfigured, webhook_client: AsyncClient, monkeypatch
) -> None:
    import app.api_webhook as api_webhook

    triggered: list[int | None] = []

    async def fake_background_sync(channel_id=None):  # pragma: no cover - 不应被调用
        triggered.append(channel_id)

    monkeypatch.setattr(api_webhook, "_background_sync", fake_background_sync)

    get_resp = await webhook_client.get(
        "/webhooks/wecom",
        params={"msg_signature": "x", "timestamp": TIMESTAMP, "nonce": NONCE, "echostr": "x"},
    )
    post_resp = await webhook_client.post(
        "/webhooks/wecom",
        params={"msg_signature": "x", "timestamp": TIMESTAMP, "nonce": NONCE},
        content=b"<xml></xml>",
    )

    assert get_resp.status_code == 503
    assert post_resp.status_code == 503
    assert triggered == []

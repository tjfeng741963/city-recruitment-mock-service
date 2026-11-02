"""会话 / 消息 / 客户接口测试。

数据用 SessionLocal 直接造（目前还没有创建会话的公开接口），每个用例结束后清表，
避免 data/test.db 里残留数据互相污染。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select

from app.api_v1_conversations import router as conversations_router
from app.db import SessionLocal, engine, init_db
from app.main import app
from app.models import (
    ChannelAccount,
    Conversation,
    Customer,
    Delivery,
    Message,
    ReadCursor,
    User,
)
from app.security import create_access_token, hash_password

# main.py 由负责人统一接线；测试里先临时挂载，已挂过则不重复挂，方便日后切换。
if not any(getattr(r, "path", "") == "/api/v1/conversations" for r in app.routes):
    app.include_router(conversations_router)


BASE_TIME = datetime(2026, 1, 1, 9, 0, tzinfo=timezone.utc)


# ─────────────────────────── 夹具 ───────────────────────────
@pytest_asyncio.fixture(autouse=True)
async def _isolate_db():
    await init_db()
    yield
    async with SessionLocal() as session:
        for model in (Message, Delivery, ReadCursor, Conversation, Customer, ChannelAccount):
            await session.execute(delete(model))
        await session.execute(delete(User).where(User.role != "admin"))
        await session.commit()
    await engine.dispose()


# ─────────────────────────── 造数工具 ───────────────────────────
async def _mk_channel(session, name: str = "企业微信客服") -> ChannelAccount:
    channel = ChannelAccount(
        channel_type="wecom_kf",
        name=name,
        external_id=f"wk{uuid.uuid4().hex[:20]}",
        corp_id="ww-corp",
    )
    session.add(channel)
    await session.flush()
    return channel


async def _mk_conversation(
    session,
    channel: ChannelAccount,
    *,
    nickname: str,
    last_message_at: datetime | None = None,
    takeover: bool = False,
    preview: str = "",
    assigned_user_id: int | None = None,
) -> Conversation:
    customer = Customer(
        channel_account_id=channel.id,
        external_userid=f"wm{uuid.uuid4().hex[:16]}",
        nickname=nickname,
        avatar="",
    )
    session.add(customer)
    await session.flush()
    conv = Conversation(
        channel_account_id=channel.id,
        customer_id=customer.id,
        assigned_user_id=assigned_user_id,
        takeover=takeover,
        last_message_at=last_message_at,
        last_message_preview=preview,
    )
    session.add(conv)
    await session.flush()
    return conv


async def _mk_message(
    session,
    conv: Conversation,
    *,
    direction: str = "inbound",
    source: str = "customer",
    content: str = "你好",
) -> Message:
    msg = Message(
        conversation_id=conv.id,
        direction=direction,
        source=source,
        content_type="text",
        content=content,
    )
    session.add(msg)
    await session.flush()
    return msg


async def _mk_user(session, username: str) -> User:
    user = User(
        username=username,
        password_hash=hash_password("pw-for-test"),
        display_name=username,
        role="recruiter",
    )
    session.add(user)
    await session.flush()
    return user


def _auth_headers(user: User) -> dict[str, str]:
    token, _ = create_access_token(str(user.id), {"role": user.role, "username": user.username})
    return {"Authorization": f"Bearer {token}"}


# ─────────────────────────── 列表 ───────────────────────────
async def test_list_conversations_empty(admin_client) -> None:
    resp = await admin_client.get("/api/v1/conversations")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "next_cursor": None}


async def test_list_conversations_sorted_and_paginated(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        first = await _mk_conversation(
            session, channel, nickname="客户A", last_message_at=BASE_TIME, preview="A"
        )
        second = await _mk_conversation(
            session, channel, nickname="客户B", last_message_at=BASE_TIME + timedelta(minutes=1), preview="B"
        )
        third = await _mk_conversation(
            session, channel, nickname="客户C", last_message_at=BASE_TIME + timedelta(minutes=2), preview="C"
        )
        await session.commit()

    expected = [third.id, second.id, first.id]

    page1 = await admin_client.get("/api/v1/conversations", params={"limit": 2})
    assert page1.status_code == 200
    body1 = page1.json()
    assert [item["id"] for item in body1["items"]] == expected[:2]
    assert body1["next_cursor"] == expected[1]
    # 每项字段齐全
    item = body1["items"][0]
    assert set(item) == {
        "id",
        "channel_account_id",
        "channel_name",
        "customer",
        "takeover",
        "state",
        "unread",
        "last_message_at",
        "last_message_preview",
    }
    assert set(item["customer"]) == {"id", "nickname", "avatar", "external_userid"}
    assert item["channel_name"] == "企业微信客服"
    assert item["last_message_preview"] == "C"

    page2 = await admin_client.get(
        "/api/v1/conversations", params={"limit": 2, "cursor": body1["next_cursor"]}
    )
    assert page2.status_code == 200
    body2 = page2.json()
    assert [item["id"] for item in body2["items"]] == expected[2:]
    assert body2["next_cursor"] is None


async def test_list_conversations_takeover_filter(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        human = await _mk_conversation(
            session, channel, nickname="人工中", last_message_at=BASE_TIME, takeover=True
        )
        auto = await _mk_conversation(
            session, channel, nickname="AI中", last_message_at=BASE_TIME + timedelta(minutes=1)
        )
        await session.commit()

    bot_resp = await admin_client.get("/api/v1/conversations", params={"takeover": "false"})
    assert bot_resp.status_code == 200
    assert [i["id"] for i in bot_resp.json()["items"]] == [auto.id]

    human_resp = await admin_client.get("/api/v1/conversations", params={"takeover": "true"})
    assert human_resp.status_code == 200
    assert [i["id"] for i in human_resp.json()["items"]] == [human.id]
    assert human_resp.json()["items"][0]["takeover"] is True


async def test_takeover_toggle_persists(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户", last_message_at=BASE_TIME)
        await session.commit()
        conv_id = conv.id

    resp = await admin_client.post(f"/api/v1/conversations/{conv_id}/takeover", json={"takeover": True})
    assert resp.status_code == 200
    assert resp.json()["takeover"] is True

    detail = await admin_client.get(f"/api/v1/conversations/{conv_id}")
    assert detail.status_code == 200
    assert detail.json()["takeover"] is True

    off = await admin_client.post(f"/api/v1/conversations/{conv_id}/takeover", json={"takeover": False})
    assert off.status_code == 200
    assert off.json()["takeover"] is False


# ─────────────────────────── 未读数 ───────────────────────────
async def test_unread_counts_per_user_and_mark_read(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户", last_message_at=BASE_TIME)
        m1 = await _mk_message(session, conv, content="1")
        m2 = await _mk_message(session, conv, content="2")
        m3 = await _mk_message(session, conv, content="3")
        await _mk_message(session, conv, direction="outbound", source="agent", content="回复")
        reader = await _mk_user(session, f"reader-{uuid.uuid4().hex[:8]}")
        # 该用户读到第一条，只算后面两条未读
        session.add(
            ReadCursor(user_id=reader.id, conversation_id=conv.id, last_read_message_id=m1.id)
        )
        await session.commit()
        conv_id, reader_headers, reader_id = conv.id, _auth_headers(reader), reader.id
        first_id, last_id = m1.id, m3.id

    # 管理员没有任何 read_cursor：3 条入向全未读
    admin_list = await admin_client.get("/api/v1/conversations")
    assert admin_list.json()["items"][0]["unread"] == 3

    reader_list = await admin_client.get("/api/v1/conversations", headers=reader_headers)
    assert reader_list.json()["items"][0]["unread"] == 2

    read_resp = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/read",
        json={"last_read_message_id": last_id},
        headers=reader_headers,
    )
    assert read_resp.status_code == 200
    assert read_resp.json() == {
        "conversation_id": conv_id,
        "last_read_message_id": last_id,
        "unread": 0,
    }

    # 两个用户的已读位置互不影响
    assert (await admin_client.get("/api/v1/conversations", headers=reader_headers)).json()["items"][0][
        "unread"
    ] == 0
    assert (await admin_client.get("/api/v1/conversations")).json()["items"][0]["unread"] == 3

    async with SessionLocal() as session:
        cursor = await session.get(ReadCursor, (reader_id, conv_id))
        assert cursor is not None
        assert cursor.last_read_message_id == last_id
        assert first_id < last_id


async def test_mark_read_upsert_creates_cursor(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户", last_message_at=BASE_TIME)
        msg = await _mk_message(session, conv)
        await session.commit()
        conv_id, msg_id = conv.id, msg.id

    resp = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/read", json={"last_read_message_id": msg_id}
    )
    assert resp.status_code == 200
    assert resp.json()["unread"] == 0

    again = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/read", json={"last_read_message_id": msg_id}
    )
    assert again.status_code == 200
    assert (await admin_client.get(f"/api/v1/conversations/{conv_id}")).json()["unread"] == 0


# ─────────────────────────── 消息列表 ───────────────────────────
async def test_list_messages_after_and_before_id(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户", last_message_at=BASE_TIME)
        msgs = [await _mk_message(session, conv, content=f"m{i}") for i in range(5)]
        await session.commit()
        conv_id = conv.id
        ids = [m.id for m in msgs]

    all_resp = await admin_client.get(f"/api/v1/conversations/{conv_id}/messages")
    assert all_resp.status_code == 200
    assert [m["id"] for m in all_resp.json()["items"]] == ids
    assert all_resp.json()["items"][0]["direction"] == "inbound"

    after = await admin_client.get(
        f"/api/v1/conversations/{conv_id}/messages", params={"after_id": ids[1], "limit": 2}
    )
    assert [m["id"] for m in after.json()["items"]] == ids[2:4]

    before = await admin_client.get(
        f"/api/v1/conversations/{conv_id}/messages", params={"before_id": ids[3], "limit": 2}
    )
    # 向上翻页仍按正序返回
    assert [m["id"] for m in before.json()["items"]] == ids[1:3]


# ─────────────────────────── 人工发消息 ───────────────────────────
async def test_send_message_queues_delivery_and_is_idempotent(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户")
        await session.commit()
        conv_id = conv.id

    key = f"key-{uuid.uuid4().hex}"
    payload = {"content": "您好，这个岗位还在招"}

    first = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/messages", json=payload, headers={"Idempotency-Key": key}
    )
    assert first.status_code == 202
    body = first.json()
    assert body["status"] == "queued"
    assert isinstance(body["delivery_id"], int)

    async with SessionLocal() as session:
        delivery = await session.get(Delivery, body["delivery_id"])
        assert delivery is not None
        assert delivery.status == "queued"
        assert delivery.idempotency_key == key
        assert delivery.content == payload["content"]

        outbound = (
            await session.execute(
                select(Message).where(
                    Message.conversation_id == conv_id, Message.direction == "outbound"
                )
            )
        ).scalars().all()
        assert len(outbound) == 1
        assert outbound[0].source == "agent"
        assert outbound[0].delivery_id == delivery.id
        assert outbound[0].content == payload["content"]

        conv_row = await session.get(Conversation, conv_id)
        assert conv_row.last_message_preview == payload["content"]
        assert conv_row.last_message_at is not None

    # 同 key 同内容：返回上次结果，不产生第二条消息
    repeat = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/messages", json=payload, headers={"Idempotency-Key": key}
    )
    assert repeat.status_code == 202
    assert repeat.json()["delivery_id"] == body["delivery_id"]

    async with SessionLocal() as session:
        count = (
            await session.execute(
                select(func.count(Message.id)).where(Message.conversation_id == conv_id)
            )
        ).scalar_one()
        deliveries = (
            await session.execute(select(func.count(Delivery.id)))
        ).scalar_one()
    assert count == 1
    assert deliveries == 1

    # 同 key 不同内容：409
    conflict = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/messages",
        json={"content": "换一句内容"},
        headers={"Idempotency-Key": key},
    )
    assert conflict.status_code == 409

    # 换 key 可以再发一条
    another = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/messages",
        json={"content": "第二条"},
        headers={"Idempotency-Key": f"{key}-2"},
    )
    assert another.status_code == 202
    assert another.json()["delivery_id"] != body["delivery_id"]


async def test_send_message_content_validation(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户")
        await session.commit()
        conv_id = conv.id

    url = f"/api/v1/conversations/{conv_id}/messages"

    empty = await admin_client.post(url, json={"content": ""}, headers={"Idempotency-Key": "k-empty"})
    assert empty.status_code == 422

    blank = await admin_client.post(url, json={"content": "   "}, headers={"Idempotency-Key": "k-blank"})
    assert blank.status_code == 422

    too_long = await admin_client.post(
        url, json={"content": "a" * 2049}, headers={"Idempotency-Key": "k-long"}
    )
    assert too_long.status_code == 422

    # 按 UTF-8 字节数算：683 个汉字 = 2049 字节
    multibyte = await admin_client.post(
        url, json={"content": "汉" * 683}, headers={"Idempotency-Key": "k-mb"}
    )
    assert multibyte.status_code == 422

    # 边界 2048 字节应通过
    boundary = await admin_client.post(
        url, json={"content": "a" * 2048}, headers={"Idempotency-Key": "k-edge"}
    )
    assert boundary.status_code == 202

    async with SessionLocal() as session:
        count = (
            await session.execute(
                select(func.count(Message.id)).where(Message.conversation_id == conv_id)
            )
        ).scalar_one()
    assert count == 1


async def test_send_message_requires_idempotency_key(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="客户")
        await session.commit()
        conv_id = conv.id

    resp = await admin_client.post(
        f"/api/v1/conversations/{conv_id}/messages", json={"content": "hi"}
    )
    assert resp.status_code == 422

    async with SessionLocal() as session:
        count = (await session.execute(select(func.count(Message.id)))).scalar_one()
    assert count == 0


# ─────────────────────────── 404 / 客户 ───────────────────────────
@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/v1/conversations/999999", {}),
        ("get", "/api/v1/conversations/999999/messages", {}),
        ("post", "/api/v1/conversations/999999/takeover", {"json": {"takeover": True}}),
        ("post", "/api/v1/conversations/999999/read", {"json": {"last_read_message_id": 1}}),
        (
            "post",
            "/api/v1/conversations/999999/messages",
            {"json": {"content": "hi"}, "headers": {"Idempotency-Key": "k-404"}},
        ),
        ("get", "/api/v1/customers/999999", {}),
    ],
)
async def test_not_found(admin_client, method: str, path: str, kwargs: dict) -> None:
    resp = await getattr(admin_client, method)(path, **kwargs)
    assert resp.status_code == 404


async def test_get_customer(admin_client) -> None:
    async with SessionLocal() as session:
        channel = await _mk_channel(session)
        conv = await _mk_conversation(session, channel, nickname="张三", last_message_at=BASE_TIME)
        customer = await session.get(Customer, conv.customer_id)
        await session.commit()
        customer_id, external_userid, channel_id = customer.id, customer.external_userid, channel.id

    resp = await admin_client.get(f"/api/v1/customers/{customer_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == customer_id
    assert body["nickname"] == "张三"
    assert body["external_userid"] == external_userid
    assert body["channel_account_id"] == channel_id

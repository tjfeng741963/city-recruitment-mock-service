"""会话 / 消息 / 客户的读取与人工操作。

设计要点：
- 未读数是「算」出来的，按 (user, conversation) 的 read_cursors 逐会话计算，
  不用单一计数器，多端登录也不会串。
- 人工发消息走事务性发件箱：Delivery 与 Message 同事务落库，worker 负责真正的投递。
  本模块绝不调用任何发送逻辑。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ChannelAccount, Conversation, Customer, Delivery, Message, ReadCursor

MAX_MESSAGE_BYTES = 2048
IDEMPOTENCY_KEY_MAX = 128
PREVIEW_LIMIT = 255


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────── 出参构造 ───────────────────────────
def _customer_brief(customer: Customer) -> dict:
    return {
        "id": customer.id,
        "nickname": customer.nickname,
        "avatar": customer.avatar,
        "external_userid": customer.external_userid,
    }


def _conversation_item(
    conv: Conversation, customer: Customer, channel: ChannelAccount, unread: int
) -> dict:
    return {
        "id": conv.id,
        "channel_account_id": conv.channel_account_id,
        "channel_name": channel.name,
        "customer": _customer_brief(customer),
        "takeover": conv.takeover,
        "state": conv.state,
        "unread": unread,
        "last_message_at": conv.last_message_at,
        "last_message_preview": conv.last_message_preview,
    }


def _message_item(msg: Message, delivery: Delivery | None = None) -> dict:
    """消息项。出站消息带上投递状态，前端才能显示"发送中/已受理/失败原因"。"""
    return {
        "id": msg.id,
        "conversation_id": msg.conversation_id,
        "direction": msg.direction,
        "source": msg.source,
        "content_type": msg.content_type,
        "content": msg.content,
        "delivery_id": msg.delivery_id,
        "delivery_status": delivery.status if delivery else None,
        "delivery_error": (delivery.blocked_reason or None) if delivery else None,
        "created_at": msg.created_at,
    }


def _customer_item(customer: Customer) -> dict:
    return {
        "id": customer.id,
        "channel_account_id": customer.channel_account_id,
        "external_userid": customer.external_userid,
        "nickname": customer.nickname,
        "avatar": customer.avatar,
        "created_at": customer.created_at,
    }


# ─────────────────────────── 未读数 ───────────────────────────
async def unread_counts(session: AsyncSession, user_id: int, conversation_ids: list[int]) -> dict[int, int]:
    """返回 {conversation_id: unread}。

    unread = 该会话内 direction='inbound' 且 id > 该用户 last_read_message_id 的消息数；
    没有 read_cursors 记录时 last_read_message_id 视作 0（全量未读）。
    """
    if not conversation_ids:
        return {}
    stmt = (
        select(Message.conversation_id, func.count(Message.id))
        .outerjoin(
            ReadCursor,
            (ReadCursor.conversation_id == Message.conversation_id)
            & (ReadCursor.user_id == user_id),
        )
        .where(
            Message.conversation_id.in_(conversation_ids),
            Message.direction == "inbound",
            Message.id > func.coalesce(ReadCursor.last_read_message_id, 0),
        )
        .group_by(Message.conversation_id)
    )
    rows = (await session.execute(stmt)).all()
    counts = {cid: 0 for cid in conversation_ids}
    counts.update({int(cid): int(n) for cid, n in rows})
    return counts


# ─────────────────────────── 读取 ───────────────────────────
async def get_conversation(session: AsyncSession, conversation_id: int) -> Conversation:
    conv = await session.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")
    return conv


async def _conversation_with_relations(
    session: AsyncSession, conversation_id: int
) -> tuple[Conversation, Customer, ChannelAccount]:
    row = (
        await session.execute(
            select(Conversation, Customer, ChannelAccount)
            .join(Customer, Customer.id == Conversation.customer_id)
            .join(ChannelAccount, ChannelAccount.id == Conversation.channel_account_id)
            .where(Conversation.id == conversation_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")
    return row[0], row[1], row[2]


async def list_conversations(
    session: AsyncSession,
    user_id: int,
    *,
    channel_id: int | None = None,
    takeover: bool | None = None,
    assigned_user_id: int | None = None,
    limit: int = 20,
    cursor: int | None = None,
) -> dict:
    stmt = (
        select(Conversation, Customer, ChannelAccount)
        .join(Customer, Customer.id == Conversation.customer_id)
        .join(ChannelAccount, ChannelAccount.id == Conversation.channel_account_id)
    )
    if channel_id is not None:
        stmt = stmt.where(Conversation.channel_account_id == channel_id)
    if takeover is not None:
        stmt = stmt.where(Conversation.takeover.is_(takeover))
    if assigned_user_id is not None:
        stmt = stmt.where(Conversation.assigned_user_id == assigned_user_id)
    if cursor is not None:
        stmt = stmt.where(Conversation.id < cursor)
    stmt = stmt.order_by(
        Conversation.last_message_at.desc().nulls_last(), Conversation.id.desc()
    ).limit(limit + 1)

    rows = (await session.execute(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    counts = await unread_counts(session, user_id, [r[0].id for r in rows])
    items = [
        _conversation_item(conv, customer, channel, counts.get(conv.id, 0))
        for conv, customer, channel in rows
    ]
    return {"items": items, "next_cursor": items[-1]["id"] if has_more and items else None}


async def get_conversation_detail(session: AsyncSession, user_id: int, conversation_id: int) -> dict:
    conv, customer, channel = await _conversation_with_relations(session, conversation_id)
    counts = await unread_counts(session, user_id, [conv.id])
    return _conversation_item(conv, customer, channel, counts.get(conv.id, 0))


async def list_messages(
    session: AsyncSession,
    conversation_id: int,
    *,
    after_id: int = 0,
    before_id: int | None = None,
    limit: int = 50,
) -> dict:
    await get_conversation(session, conversation_id)
    stmt = select(Message).where(Message.conversation_id == conversation_id)
    if before_id is not None:
        # 向上翻页：取 before_id 之前最近的 limit 条，再翻回正序
        stmt = stmt.where(Message.id < before_id).order_by(Message.id.desc()).limit(limit)
        rows = list((await session.execute(stmt)).scalars().all())
        rows.reverse()
        return {"items": await _with_deliveries(session, rows)}
    stmt = stmt.where(Message.id > after_id).order_by(Message.id.asc()).limit(limit)
    rows = list((await session.execute(stmt)).scalars().all())
    return {"items": await _with_deliveries(session, rows)}


async def _with_deliveries(session: AsyncSession, rows: list[Message]) -> list[dict]:
    """一次查询补齐所有出站消息的投递状态，避免 N+1。"""
    ids = {m.delivery_id for m in rows if m.delivery_id}
    if not ids:
        return [_message_item(m) for m in rows]
    deliveries = (
        (await session.execute(select(Delivery).where(Delivery.id.in_(ids)))).scalars().all()
    )
    by_id = {d.id: d for d in deliveries}
    return [_message_item(m, by_id.get(m.delivery_id) if m.delivery_id else None) for m in rows]


async def get_customer(session: AsyncSession, customer_id: int) -> dict:
    customer = await session.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "客户不存在")
    return _customer_item(customer)


# ─────────────────────────── 人工操作 ───────────────────────────
async def set_takeover(session: AsyncSession, user_id: int, conversation_id: int, takeover: bool) -> dict:
    conv, customer, channel = await _conversation_with_relations(session, conversation_id)
    conv.takeover = takeover
    await session.commit()
    await session.refresh(conv)
    counts = await unread_counts(session, user_id, [conv.id])
    return _conversation_item(conv, customer, channel, counts.get(conv.id, 0))


async def mark_read(
    session: AsyncSession, user_id: int, conversation_id: int, last_read_message_id: int
) -> dict:
    await get_conversation(session, conversation_id)
    row = await session.get(ReadCursor, (user_id, conversation_id))
    if row is None:
        row = ReadCursor(
            user_id=user_id,
            conversation_id=conversation_id,
            last_read_message_id=last_read_message_id,
        )
        session.add(row)
    elif last_read_message_id > row.last_read_message_id:
        # 已读位置只前进不后退，避免旧客户端把未读重新顶起来
        row.last_read_message_id = last_read_message_id
        row.updated_at = _utcnow()
    await session.commit()
    counts = await unread_counts(session, user_id, [conversation_id])
    return {
        "conversation_id": conversation_id,
        "last_read_message_id": row.last_read_message_id,
        "unread": counts.get(conversation_id, 0),
    }


def _validate_content(content: str) -> str:
    if not content.strip():
        raise HTTPException(422, "消息内容不能为空")
    if len(content.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise HTTPException(
            422,
            f"消息内容超过 {MAX_MESSAGE_BYTES} 字节上限",
        )
    return content


async def enqueue_message(
    session: AsyncSession,
    conversation_id: int,
    *,
    idempotency_key: str,
    content: str,
) -> dict:
    """人工发消息：只入队不发送。同 (conversation, key) 幂等。"""
    content = _validate_content(content)
    key = idempotency_key.strip()
    if not key:
        raise HTTPException(422, "Idempotency-Key 不能为空")
    if len(key) > IDEMPOTENCY_KEY_MAX:
        raise HTTPException(
            422,
            f"Idempotency-Key 长度不能超过 {IDEMPOTENCY_KEY_MAX}",
        )

    conv = await get_conversation(session, conversation_id)

    duplicate = (
        await session.execute(
            select(Delivery).where(
                Delivery.conversation_id == conversation_id,
                Delivery.idempotency_key == key,
            )
        )
    ).scalar_one_or_none()
    if duplicate is not None:
        if duplicate.content != content:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "该 Idempotency-Key 已用于不同内容的消息"
            )
        return {"delivery_id": duplicate.id, "status": duplicate.status}

    now = _utcnow()
    delivery = Delivery(
        conversation_id=conversation_id,
        idempotency_key=key,
        content=content,
        status="queued",
    )
    session.add(delivery)
    try:
        await session.flush()
    except IntegrityError:
        # 并发下同一 key 抢先落库：回滚后按幂等语义返回或报冲突
        await session.rollback()
        existing = (
            await session.execute(
                select(Delivery).where(
                    Delivery.conversation_id == conversation_id,
                    Delivery.idempotency_key == key,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            raise
        if existing.content != content:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "该 Idempotency-Key 已用于不同内容的消息"
            ) from None
        return {"delivery_id": existing.id, "status": existing.status}

    session.add(
        Message(
            conversation_id=conversation_id,
            direction="outbound",
            source="agent",
            content_type="text",
            content=content,
            delivery_id=delivery.id,
            created_at=now,
        )
    )
    conv.last_message_at = now
    conv.last_message_preview = content[:PREVIEW_LIMIT]
    await session.commit()
    return {"delivery_id": delivery.id, "status": "queued"}

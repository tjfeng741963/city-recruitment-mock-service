"""本地 agent 上报的入库逻辑（通道类型 wxwork_local）。

设计要点：
- 幂等：以 (channel_account, external_id) 定位会话，以 external_msgid 去重消息
- 会话/客户按需创建，不要求 agent 先注册
- 只做 upsert，不做删除；本地删掉的会话服务端保留（审计需要）
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ChannelAccount, Conversation, Customer, Message

CHANNEL_TYPE = "wxwork_local"


def _naive_utc(value: datetime | None) -> datetime | None:
    """SQLite 没有时区类型，读出来是 naive；比较前必须统一，否则 aware/naive 相减会抛异常。"""
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value



@dataclass(slots=True)
class IngestConversation:
    external_id: str
    name: str = ""
    kind: str = "single"
    last_message_at: datetime | None = None


@dataclass(slots=True)
class IngestMessage:
    external_conversation_id: str
    external_msgid: str
    direction: str          # inbound / outbound
    content: str
    content_type: str = "text"
    sender_name: str = ""
    sent_at: datetime | None = None


async def ensure_channel_account(
    session: AsyncSession, device_id: int | None, account_uid: str, account_name: str = "企业微信(本机)"
) -> ChannelAccount:
    channel = (
        await session.execute(
            select(ChannelAccount).where(
                ChannelAccount.channel_type == CHANNEL_TYPE,
                ChannelAccount.external_id == account_uid,
            )
        )
    ).scalar_one_or_none()
    if channel:
        if device_id and channel.device_id != device_id:
            channel.device_id = device_id
        return channel
    channel = ChannelAccount(
        device_id=device_id,
        channel_type=CHANNEL_TYPE,
        name=account_name,
        external_id=account_uid,
        status="enabled",
    )
    session.add(channel)
    await session.flush()
    return channel


async def _get_or_create_conversation(
    session: AsyncSession, channel: ChannelAccount, item: IngestConversation, self_uid: str = ""
) -> Conversation:
    conv = (
        await session.execute(
            select(Conversation).where(
                Conversation.channel_account_id == channel.id,
                Conversation.external_id == item.external_id,
            )
        )
    ).scalar_one_or_none()
    if conv:
        incoming = _naive_utc(item.last_message_at)
        if incoming and (conv.last_message_at is None or incoming > _naive_utc(conv.last_message_at)):
            conv.last_message_at = incoming
        return conv

    external_userid = _counterpart(item.external_id, self_uid)

    customer = (
        await session.execute(
            select(Customer).where(
                Customer.channel_account_id == channel.id,
                Customer.external_userid == external_userid,
            )
        )
    ).scalar_one_or_none()
    if customer is None:
        customer = Customer(
            channel_account_id=channel.id,
            external_userid=external_userid,
            nickname=item.name or None,
        )
        session.add(customer)
        await session.flush()
    elif item.name and not customer.nickname:
        customer.nickname = item.name

    # 同一客户可能已经有会话（例如早期用会话 id 当客户 id 建过），直接复用并纠正
    existing = (
        await session.execute(
            select(Conversation).where(
                Conversation.channel_account_id == channel.id,
                Conversation.customer_id == customer.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if not existing.external_id:
            existing.external_id = item.external_id
        if item.kind and existing.kind != item.kind:
            existing.kind = item.kind
        return existing

    conv = Conversation(
        channel_account_id=channel.id,
        customer_id=customer.id,
        external_id=item.external_id,
        kind=item.kind,
        last_message_at=_naive_utc(item.last_message_at),
    )
    session.add(conv)
    await session.flush()
    return conv


def _counterpart(external_id: str, self_uid: str) -> str:
    """从会话 id 推出"对方"标识。

    企微单聊 id 形如 S:<A>_<B>，A/B 的顺序并不固定（有时自己在前面，有时在后面），
    不能按固定位置取，否则多个会话会映射到同一个客户。
    """
    if external_id.startswith("S:") and "_" in external_id:
        left, right = external_id[2:].split("_", 1)
        if self_uid and left == self_uid:
            return right
        if self_uid and right == self_uid:
            return left
        return right
    # 群聊 / 系统会话：用会话 id 本身做客户标识，天然唯一
    return external_id


async def ingest_batch(
    session: AsyncSession,
    *,
    device_id: int | None,
    account_uid: str,
    conversations: list[IngestConversation],
    messages: list[IngestMessage],
) -> dict:
    channel = await ensure_channel_account(session, device_id, account_uid)

    conv_map: dict[str, Conversation] = {}
    created_convs = 0
    for item in conversations:
        before = (
            await session.execute(
                select(Conversation.id).where(
                    Conversation.channel_account_id == channel.id,
                    Conversation.external_id == item.external_id,
                )
            )
        ).scalar_one_or_none()
        conv = await _get_or_create_conversation(session, channel, item, account_uid)
        conv_map[item.external_id] = conv
        if before is None:
            created_convs += 1

    created_msgs = 0
    skipped = 0
    touched: set[int] = set()
    for msg in messages:
        conv = conv_map.get(msg.external_conversation_id)
        if conv is None:
            conv = await _get_or_create_conversation(
                session,
                channel,
                IngestConversation(external_id=msg.external_conversation_id),
                account_uid,
            )
            conv_map[msg.external_conversation_id] = conv

        if msg.external_msgid:
            exists = (
                await session.execute(
                    select(Message.id).where(
                        Message.conversation_id == conv.id,
                        Message.external_msgid == msg.external_msgid,
                    )
                )
            ).scalar_one_or_none()
            if exists:
                skipped += 1
                continue

        sent_at = _naive_utc(msg.sent_at) or datetime.now(timezone.utc).replace(tzinfo=None)
        session.add(
            Message(
                conversation_id=conv.id,
                direction=msg.direction,
                source="customer" if msg.direction == "inbound" else "agent",
                content_type=msg.content_type,
                content=msg.content,
                external_msgid=msg.external_msgid or None,
                created_at=sent_at,
            )
        )
        created_msgs += 1
        touched.add(conv.id)
        if conv.last_message_at is None or sent_at > _naive_utc(conv.last_message_at):
            conv.last_message_at = sent_at
            conv.last_message_preview = msg.content[:255]

    await session.commit()
    return {
        "conversations_created": created_convs,
        "messages_created": created_msgs,
        "messages_skipped": skipped,
        "conversations_touched": len(touched),
        "channel_id": channel.id,
    }

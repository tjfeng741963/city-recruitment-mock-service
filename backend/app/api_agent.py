"""本地 agent 通道：上报会话/消息 + 领取发送指令 + 回执。

鉴权用设备 token（X-Device-Token），不是用户 JWT——这台电脑代表一个采集端，
不应该持有任何顾问账号的凭据。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from .deps import DeviceDep, SessionDep
from .models import ChannelAccount, Conversation, Delivery, Message
from .services.agent_ingest import (
    CHANNEL_TYPE,
    IngestConversation,
    IngestMessage,
    ingest_batch,
)

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


# ─────────────────────────── 上报 ───────────────────────────
class ConvIn(BaseModel):
    external_id: str = Field(min_length=1, max_length=128)
    name: str = ""
    kind: str = "single"
    last_message_at: datetime | None = None


class MsgIn(BaseModel):
    external_conversation_id: str = Field(min_length=1, max_length=128)
    external_msgid: str = ""
    direction: Literal["inbound", "outbound"] = "inbound"
    content: str = ""
    content_type: str = "text"
    sender_name: str = ""
    sent_at: datetime | None = None


class IngestIn(BaseModel):
    account_uid: str = Field(min_length=1, max_length=64)
    account_name: str = "企业微信(本机)"
    conversations: list[ConvIn] = Field(default_factory=list)
    messages: list[MsgIn] = Field(default_factory=list)


@router.post("/ingest")
async def ingest(payload: IngestIn, device: DeviceDep, session: SessionDep) -> dict:
    return await ingest_batch(
        session,
        device_id=device.id,
        account_uid=payload.account_uid,
        conversations=[
            IngestConversation(
                external_id=c.external_id, name=c.name, kind=c.kind, last_message_at=c.last_message_at
            )
            for c in payload.conversations
        ],
        messages=[
            IngestMessage(
                external_conversation_id=m.external_conversation_id,
                external_msgid=m.external_msgid,
                direction=m.direction,
                content=m.content,
                content_type=m.content_type,
                sender_name=m.sender_name,
                sent_at=m.sent_at,
            )
            for m in payload.messages
        ],
    )


# ─────────────────────────── 指令 ───────────────────────────
class CommandOut(BaseModel):
    id: int
    delivery_id: int
    conversation_external_id: str
    content: str
    idempotency_key: str


async def _pull_one(session, device_id: int) -> Delivery | None:
    """领一条待发指令，并立刻置为 sending（防重复领取）。"""
    rows = (
        await session.execute(
            select(Delivery, Conversation)
            .join(Conversation, Conversation.id == Delivery.conversation_id)
            .join(ChannelAccount, ChannelAccount.id == Conversation.channel_account_id)
            .where(
                ChannelAccount.device_id == device_id,
                ChannelAccount.channel_type == CHANNEL_TYPE,
                ChannelAccount.status == "enabled",
                Delivery.status == "queued",
            )
            .order_by(Delivery.id)
            .limit(5)
        )
    ).all()
    for delivery, _conv in rows:
        claimed = await session.execute(
            Delivery.__table__.update()
            .where(Delivery.id == delivery.id, Delivery.status == "queued")
            .values(status="sending", attempts=Delivery.attempts + 1)
        )
        if claimed.rowcount:
            await session.commit()
            return delivery
    await session.rollback()
    return None


@router.get("/commands", response_model=list[CommandOut])
async def get_commands(
    device: DeviceDep,
    session: SessionDep,
    wait: Annotated[int, Query(ge=0, le=25)] = 0,
) -> list[CommandOut]:
    deadline = asyncio.get_event_loop().time() + wait
    while True:
        delivery = await _pull_one(session, device.id)
        if delivery:
            conv = await session.get(Conversation, delivery.conversation_id)
            return [
                CommandOut(
                    id=delivery.id,
                    delivery_id=delivery.id,
                    conversation_external_id=conv.external_id if conv else "",
                    content=delivery.content,
                    idempotency_key=delivery.idempotency_key,
                )
            ]
        if asyncio.get_event_loop().time() >= deadline:
            return []
        await asyncio.sleep(1.0)


class AckIn(BaseModel):
    status: Literal["sent", "failed"]
    external_msgid: str = ""
    error: str = ""


@router.post("/commands/{delivery_id}/ack")
async def ack_command(delivery_id: int, payload: AckIn, device: DeviceDep, session: SessionDep) -> dict:
    delivery = await session.get(Delivery, delivery_id)
    if not delivery:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "指令不存在")
    conv = await session.get(Conversation, delivery.conversation_id)
    if not conv:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")
    channel = await session.get(ChannelAccount, conv.channel_account_id)
    if not channel or channel.device_id != device.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "指令不属于该设备")
    if delivery.status not in ("sending", "queued"):
        return {"ok": True, "already": delivery.status}

    if payload.status == "sent":
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        delivery.status = "accepted"
        delivery.external_msgid = payload.external_msgid or delivery.external_msgid
        session.add(
            Message(
                conversation_id=conv.id,
                direction="outbound",
                source="agent",
                content=delivery.content,
                external_msgid=payload.external_msgid or None,
                delivery_id=delivery.id,
                created_at=now,
            )
        )
        conv.last_message_at = now
        conv.last_message_preview = delivery.content[:255]
    else:
        delivery.status = "failed"
        delivery.blocked_reason = payload.error[:300] or "agent 发送失败"

    await session.commit()
    return {"ok": True, "status": delivery.status}

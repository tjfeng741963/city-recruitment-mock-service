"""会话 / 消息 / 客户接口（P2）。

只做读取与人工操作；真正的消息投递由 worker 消费 deliveries 完成。
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Header, Query, status
from pydantic import BaseModel, Field

from .deps import CurrentUser, SessionDep
from .services import conversation_service as svc

router = APIRouter(prefix="/api/v1", tags=["conversations"])


# ─────────────────────────── 出参模型 ───────────────────────────
class CustomerBrief(BaseModel):
    id: int
    nickname: str | None = None
    avatar: str | None = None
    external_userid: str


class ConversationOut(BaseModel):
    id: int
    channel_account_id: int
    channel_name: str
    customer: CustomerBrief
    takeover: bool
    state: str
    unread: int
    last_message_at: datetime | None = None
    last_message_preview: str


class ConversationListOut(BaseModel):
    items: list[ConversationOut]
    next_cursor: int | None = None


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    direction: str
    source: str
    content_type: str
    content: str
    delivery_id: int | None = None
    delivery_status: str | None = None
    delivery_error: str | None = None
    created_at: datetime


class MessageListOut(BaseModel):
    items: list[MessageOut]


class CustomerOut(BaseModel):
    id: int
    channel_account_id: int
    external_userid: str
    nickname: str | None = None
    avatar: str | None = None
    created_at: datetime


class TakeoverIn(BaseModel):
    takeover: bool


class ReadIn(BaseModel):
    last_read_message_id: int = Field(ge=0)


class ReadOut(BaseModel):
    conversation_id: int
    last_read_message_id: int
    unread: int


class SendMessageIn(BaseModel):
    content: str


class DeliveryQueuedOut(BaseModel):
    delivery_id: int
    status: str


# ─────────────────────────── 会话 ───────────────────────────
@router.get("/conversations", response_model=ConversationListOut)
async def list_conversations(
    user: CurrentUser,
    session: SessionDep,
    channel_id: Annotated[int | None, Query()] = None,
    takeover: Annotated[bool | None, Query()] = None,
    assigned_user_id: Annotated[int | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[int | None, Query(ge=1)] = None,
) -> dict:
    return await svc.list_conversations(
        session,
        user.id,
        channel_id=channel_id,
        takeover=takeover,
        assigned_user_id=assigned_user_id,
        limit=limit,
        cursor=cursor,
    )


@router.get("/conversations/{cid}", response_model=ConversationOut)
async def get_conversation(cid: int, user: CurrentUser, session: SessionDep) -> dict:
    return await svc.get_conversation_detail(session, user.id, cid)


@router.get("/conversations/{cid}/messages", response_model=MessageListOut)
async def list_messages(
    cid: int,
    user: CurrentUser,
    session: SessionDep,
    after_id: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_id: Annotated[int | None, Query(ge=1)] = None,
) -> dict:
    return await svc.list_messages(
        session, cid, after_id=after_id, before_id=before_id, limit=limit
    )


@router.post("/conversations/{cid}/takeover", response_model=ConversationOut)
async def set_takeover(cid: int, payload: TakeoverIn, user: CurrentUser, session: SessionDep) -> dict:
    return await svc.set_takeover(session, user.id, cid, payload.takeover)


@router.post("/conversations/{cid}/read", response_model=ReadOut)
async def mark_read(cid: int, payload: ReadIn, user: CurrentUser, session: SessionDep) -> dict:
    return await svc.mark_read(session, user.id, cid, payload.last_read_message_id)


@router.post(
    "/conversations/{cid}/messages",
    response_model=DeliveryQueuedOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def send_message(
    cid: int,
    payload: SendMessageIn,
    user: CurrentUser,
    session: SessionDep,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
) -> dict:
    # 只写 deliveries + messages，不触发任何发送；投递交给 worker
    return await svc.enqueue_message(
        session, cid, idempotency_key=idempotency_key, content=payload.content
    )


# ─────────────────────────── 客户 ───────────────────────────
@router.get("/customers/{customer_id}", response_model=CustomerOut)
async def get_customer(customer_id: int, user: CurrentUser, session: SessionDep) -> dict:
    return await svc.get_customer(session, customer_id)

"""数据模型：Device / ChannelAccount / Customer / Conversation / Message / Delivery。

这三层的意义见 docs/后端架构设计-企业微信单通道与多端客户端.md 第 3 节：
设备是主机，通道是收发身份，会话是客户在某通道上的对话。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(16), default="recruiter")  # admin / recruiter
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Device(Base):
    """一台主机。device_code 是业务标识，device_token 是设备自证身份用。"""

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    device_token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="offline")  # online/offline/disabled
    agent_version: Mapped[str] = mapped_column(String(32), default="")
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    channels: Mapped[list[ChannelAccount]] = relationship(back_populates="device")


class ChannelAccount(Base):
    """一个具体的收发身份，例如一个企业微信客服账号（open_kfid）。"""

    __tablename__ = "channel_accounts"
    __table_args__ = (UniqueConstraint("channel_type", "external_id", name="uq_channel_external"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    channel_type: Mapped[str] = mapped_column(String(32), default="wecom_kf")
    name: Mapped[str] = mapped_column(String(128), default="")
    external_id: Mapped[str] = mapped_column(String(128))  # open_kfid
    corp_id: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(16), default="enabled")
    cursor: Mapped[str] = mapped_column(String(128), default="")
    sync_token: Mapped[str] = mapped_column(String(256), default="")
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reply_after: Mapped[int] = mapped_column(BigInteger, default=0)  # 只回该时间戳之后的新消息
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    device: Mapped[Device | None] = relationship(back_populates="channels")


class WebhookEvent(Base):
    """回调去重表：企微在网络抖动时会重复推送同一条通知。"""

    __tablename__ = "webhook_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    dedupe_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    channel_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("channel_accounts.id"), nullable=True
    )
    event_type: Mapped[str] = mapped_column(String(32), default="")
    payload: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Customer(Base):
    __tablename__ = "customers"
    __table_args__ = (
        UniqueConstraint("channel_account_id", "external_userid", name="uq_customer_external"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_account_id: Mapped[int] = mapped_column(ForeignKey("channel_accounts.id"))
    external_userid: Mapped[str] = mapped_column(String(128), index=True)  # wm...
    nickname: Mapped[str | None] = mapped_column(String(128), nullable=True)
    avatar: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("channel_account_id", "customer_id", name="uq_conversation_customer"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_account_id: Mapped[int] = mapped_column(ForeignKey("channel_accounts.id"))
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    # 通道侧的会话标识（企微：S:xxx_yyy 单聊 / R:xxx 群聊），用于本地 agent 回执
    external_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    kind: Mapped[str] = mapped_column(String(16), default="single")  # single / group / system
    assigned_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    state: Mapped[str] = mapped_column(String(16), default="active")
    takeover: Mapped[bool] = mapped_column(Boolean, default=False)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_message_preview: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    direction: Mapped[str] = mapped_column(String(16))  # inbound / outbound
    source: Mapped[str] = mapped_column(String(16), default="customer")  # customer/ai/agent/system
    content_type: Mapped[str] = mapped_column(String(16), default="text")
    content: Mapped[str] = mapped_column(Text, default="")
    external_msgid: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    delivery_id: Mapped[int | None] = mapped_column(ForeignKey("deliveries.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Delivery(Base):
    """事务性发件箱。消息落库与投递意图在同一事务里写，worker 再消费。"""

    __tablename__ = "deliveries"
    __table_args__ = (
        UniqueConstraint("conversation_id", "idempotency_key", name="uq_delivery_idempotency"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="queued")
    blocked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_msgid: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=func.now()
    )


class ReadCursor(Base):
    """多端已读位置：按 (用户, 会话) 存，避免单一 unread 计数器在双端登录时错乱。"""

    __tablename__ = "read_cursors"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), primary_key=True)
    last_read_message_id: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

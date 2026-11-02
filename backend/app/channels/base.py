"""通道适配层的公共契约。

所有通道（企微客服、以后的会话存档、其他 IM）都实现同一个 Protocol，
业务层只依赖这里的类型，不 import 具体实现。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(slots=True)
class WebhookRequest:
    raw_body: bytes
    query: dict[str, str]
    headers: dict[str, str]


@dataclass(slots=True)
class WebhookResult:
    ok: bool
    plaintext: str = ""          # 验证 URL 时要原样返回
    event: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    dedupe_hash: str = ""        # 用于回调幂等


@dataclass(slots=True)
class InboundMessage:
    external_msgid: str
    external_userid: str
    content: str
    origin: int                  # 企微：3=客户 4=系统 5=接待人员
    send_time: int               # 秒
    msgtype: str = "text"
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class InboundPage:
    messages: list[InboundMessage]
    next_cursor: str
    has_more: bool


@dataclass(slots=True)
class OutboundMessage:
    external_userid: str
    content: str
    idempotency_key: str


@dataclass(slots=True)
class SendResult:
    ok: bool
    external_msgid: str = ""
    error: str = ""
    uncertain: bool = False      # 网络结果不明，禁止自动重投
    blocked_reason: str = ""     # 前置校验不通过


@dataclass(slots=True)
class ChannelHealth:
    ready: bool
    blocked_reason: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class ChannelAdapter(Protocol):
    channel_type: str

    async def verify_webhook(self, request: WebhookRequest) -> WebhookResult: ...

    async def fetch_inbound(self, cursor: str) -> InboundPage: ...

    async def send(self, message: OutboundMessage) -> SendResult: ...

    async def health(self) -> ChannelHealth: ...

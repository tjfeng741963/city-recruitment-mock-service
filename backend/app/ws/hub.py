"""多端推送 WebSocket 中心。

一个后端进程内只有一个 `hub`。客户端（Web 工作台 / 桌面端 / 小程序）用
`ws://host/ws?token=<JWT>` 连接，连上后按 topic 订阅，业务代码只管
`await hub.publish("conversation:1", event)`，不必关心当前有几个连接、谁掉线了。

topic 命名约定：
    conversation:{id}  单个会话的事件（新消息、会话状态变更）
    inbox              所有会话的"收件箱级"汇总事件（会话列表刷新、投递状态）
    device:{code}      某台主机的状态
    channel:{id}       某个通道的状态（被限流、被封禁）

事件形状统一为 `{"type": "<event.type>", ...}`，即 publish 传入的 event 原样透传，
不做二次包装——前端按 `type` 分发即可。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jwt import InvalidTokenError

from ..security import decode_token

# --------------------------------------------------------------------------- #
# 事件类型常量
# --------------------------------------------------------------------------- #
EVT_MESSAGE_CREATED = "message.created"
EVT_CONVERSATION_UPDATED = "conversation.updated"
EVT_DELIVERY_UPDATED = "delivery.updated"
EVT_DEVICE_STATUS = "device.status"
EVT_CHANNEL_BLOCKED = "channel.blocked"

# --------------------------------------------------------------------------- #
# topic 构造
# --------------------------------------------------------------------------- #
INBOX_TOPIC = "inbox"


def conversation_topic(conversation_id: int) -> str:
    return f"conversation:{conversation_id}"


def device_topic(device_code: str) -> str:
    return f"device:{device_code}"


def channel_topic(channel_id: int) -> str:
    return f"channel:{channel_id}"


# --------------------------------------------------------------------------- #
# 订阅者与连接池
# --------------------------------------------------------------------------- #
@dataclass(eq=False)  # 按对象身份取哈希，放进 set 才不会因为 topics 是可变类型而报错
class Subscriber:
    websocket: WebSocket
    user_id: int
    topics: set[str] = field(default_factory=set)


class ConnectionManager:
    """内存连接池。单进程内使用，不做跨进程广播（多副本要靠 Redis 之类的上游）。"""

    def __init__(self) -> None:
        self._subs: set[Subscriber] = set()

    # -- 生命周期 ---------------------------------------------------------- #
    async def connect(self, websocket: WebSocket, user_id: int) -> Subscriber:
        await websocket.accept()
        sub = Subscriber(websocket=websocket, user_id=user_id)
        self._subs.add(sub)
        return sub

    async def disconnect(self, sub: Subscriber) -> None:
        """只做摘除。关闭握手由 endpoint 负责，避免重复 close。"""
        self._subs.discard(sub)

    async def subscribe(self, sub: Subscriber, topics: list[str]) -> None:
        sub.topics.update(topics)

    async def unsubscribe(self, sub: Subscriber, topics: list[str]) -> None:
        sub.topics.difference_update(topics)

    # -- 推送 -------------------------------------------------------------- #
    async def _deliver(self, sub: Subscriber, event: dict) -> bool:
        try:
            await sub.websocket.send_json(event)
            return True
        except (WebSocketDisconnect, RuntimeError):
            # WebSocketDisconnected 也是 RuntimeError 的子类；连接已废，直接摘除，
            # 不能让一条坏连接拖垮整批推送。
            self._subs.discard(sub)
            return False

    async def _dispatch(self, targets: list[Subscriber], event: dict) -> int:
        if not targets:
            return 0
        results = await asyncio.gather(
            *(self._deliver(sub, event) for sub in targets),
            return_exceptions=True,
        )
        return sum(1 for ok in results if ok is True)

    async def publish(self, topic: str, event: dict) -> int:
        """推给订阅了该 topic 的所有连接，返回成功送达的连接数。"""
        targets = [sub for sub in list(self._subs) if topic in sub.topics]
        return await self._dispatch(targets, event)

    async def broadcast(self, event: dict) -> int:
        return await self._dispatch(list(self._subs), event)

    async def send_to_user(self, user_id: int, event: dict) -> int:
        """同一用户可能有多端在线，全部推。"""
        targets = [sub for sub in list(self._subs) if sub.user_id == user_id]
        return await self._dispatch(targets, event)

    # -- 观测 -------------------------------------------------------------- #
    def stats(self) -> dict:
        topics: dict[str, int] = {}
        for sub in self._subs:
            for topic in sub.topics:
                topics[topic] = topics.get(topic, 0) + 1
        return {"connections": len(self._subs), "topics": topics}


hub = ConnectionManager()


# --------------------------------------------------------------------------- #
# 便捷函数：业务代码直接调，省得自己拼 topic 和 event
# --------------------------------------------------------------------------- #
async def emit_message_created(conversation_id: int, message: dict) -> int:
    return await hub.publish(
        conversation_topic(conversation_id),
        {"type": EVT_MESSAGE_CREATED, "conversation_id": conversation_id, "message": message},
    )


async def emit_conversation_updated(conversation_id: int, payload: dict) -> int:
    return await hub.publish(
        conversation_topic(conversation_id),
        {"type": EVT_CONVERSATION_UPDATED, "conversation_id": conversation_id, **payload},
    )


async def emit_delivery_updated(delivery_id: int, status: str, reason: str | None = None) -> int:
    """投递状态变化没有会话上下文，走 inbox，让所有端刷新会话列表。"""
    event: dict = {"type": EVT_DELIVERY_UPDATED, "delivery_id": delivery_id, "status": status}
    if reason is not None:
        event["reason"] = reason
    return await hub.publish(INBOX_TOPIC, event)


# --------------------------------------------------------------------------- #
# WS 端点
# --------------------------------------------------------------------------- #
router = APIRouter()


def _user_id_from_token(token: str | None) -> int | None:
    if not token:
        return None
    try:
        payload = decode_token(token)
    except InvalidTokenError:
        return None
    subject = payload.get("sub")
    try:
        return int(subject)
    except (TypeError, ValueError):
        return None


async def _read_topics(message: dict) -> list[str] | None:
    topics = message.get("topics")
    if topics is None:
        return []
    if not isinstance(topics, list) or not all(isinstance(t, str) for t in topics):
        return None
    return topics


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    user_id = _user_id_from_token(websocket.query_params.get("token"))
    if user_id is None:
        # 握手阶段就拒绝，不 accept、不进订阅循环
        await websocket.close(code=1008)
        return

    sub = await hub.connect(websocket, user_id)
    try:
        while True:
            raw = await websocket.receive_text()

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                message = None
            if not isinstance(message, dict):
                await websocket.send_json({"type": "error", "message": "invalid json"})
                continue

            msg_type = message.get("type")
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif msg_type == "subscribe":
                topics = await _read_topics(message)
                if topics is None:
                    await websocket.send_json({"type": "error", "message": "invalid topics"})
                    continue
                await hub.subscribe(sub, topics)
            elif msg_type == "unsubscribe":
                topics = await _read_topics(message)
                if topics is None:
                    await websocket.send_json({"type": "error", "message": "invalid topics"})
                    continue
                await hub.unsubscribe(sub, topics)
            else:
                await websocket.send_json({"type": "error", "message": "unknown type"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(sub)

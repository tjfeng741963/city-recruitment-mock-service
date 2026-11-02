"""WebSocket 中心（app/ws/hub.py）的协议与推送语义测试。

两个刻意的取舍：
1. 不 import app.main —— 只挂 hub.router，避免依赖数据库与 lifespan；
2. 不用 asyncio.run(hub.publish(...)) 从测试线程直接推 —— hub 内部的 anyio
   stream 绑定在应用的事件循环上，跨线程调用会踩坏 send。改成在最小应用里
   挂 `/_t/*` 控制端点，让推送和 stats 都在应用自己的循环里执行。
"""

from __future__ import annotations

import time
from typing import Any, Callable

import jwt
import pytest
from fastapi import Body, FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.security import create_access_token
from app.ws.hub import (
    EVT_CHANNEL_BLOCKED,
    EVT_CONVERSATION_UPDATED,
    EVT_DELIVERY_UPDATED,
    EVT_DEVICE_STATUS,
    EVT_MESSAGE_CREATED,
    emit_conversation_updated,
    emit_delivery_updated,
    emit_message_created,
    hub,
    router,
)

# --------------------------------------------------------------------------- #
# 最小应用：业务路由 + 测试用控制端点
# --------------------------------------------------------------------------- #
app = FastAPI()
app.include_router(router)


@app.post("/_t/publish")
async def _t_publish(payload: dict = Body(...)) -> dict:
    return {"sent": await hub.publish(payload["topic"], payload["event"])}


@app.post("/_t/broadcast")
async def _t_broadcast(payload: dict = Body(...)) -> dict:
    return {"sent": await hub.broadcast(payload["event"])}


@app.post("/_t/send_to_user")
async def _t_send_to_user(payload: dict = Body(...)) -> dict:
    return {"sent": await hub.send_to_user(int(payload["user_id"]), payload["event"])}


@app.get("/_t/stats")
async def _t_stats() -> dict:
    return hub.stats()


@app.post("/_t/emit/message")
async def _t_emit_message(payload: dict = Body(...)) -> dict:
    return {"sent": await emit_message_created(payload["conversation_id"], payload["message"])}


@app.post("/_t/emit/conversation")
async def _t_emit_conversation(payload: dict = Body(...)) -> dict:
    return {"sent": await emit_conversation_updated(payload["conversation_id"], payload["payload"])}


@app.post("/_t/emit/delivery")
async def _t_emit_delivery(payload: dict = Body(...)) -> dict:
    return {
        "sent": await emit_delivery_updated(
            payload["delivery_id"], payload["status"], payload.get("reason")
        )
    }


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def _token(user_id: int) -> str:
    # create_access_token 返回 (token, expires_in)
    token, _expires_in = create_access_token(str(user_id))
    return token


def _connect(client: TestClient, user_id: int):
    return client.websocket_connect(f"/ws?token={_token(user_id)}")


def _sync(ws) -> None:
    """ping/pong 当栅栏用：同一连接的消息按序处理，pong 到手说明前面的指令都已生效。"""
    ws.send_json({"type": "ping"})
    assert ws.receive_json() == {"type": "pong"}


def _subscribe(ws, *topics: str) -> None:
    ws.send_json({"type": "subscribe", "topics": list(topics)})
    _sync(ws)


def _wait_until(fn: Callable[[], Any], what: str, timeout: float = 3.0) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"等待超时：{what}")
        time.sleep(0.02)


def _stats(client: TestClient) -> dict:
    return client.get("/_t/stats").json()


# --------------------------------------------------------------------------- #
# 1. 鉴权
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "query",
    [
        pytest.param("", id="no-token"),
        pytest.param("?token=", id="empty-token"),
        pytest.param("?token=not-a-jwt", id="garbage-token"),
        pytest.param(
            "?token=" + jwt.encode({"sub": "1"}, "wrong-secret", algorithm="HS256"),
            id="wrong-secret",
        ),
    ],
)
def test_reject_invalid_token(query: str) -> None:
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect(f"/ws{query}"):
                pass  # 握手阶段就应被拒，走不到这里
        assert excinfo.value.code == 1008


# --------------------------------------------------------------------------- #
# 2. 订阅语义：只收自己订的
# --------------------------------------------------------------------------- #
def test_subscribe_receives_only_subscribed_topic() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws:
            _subscribe(ws, "conversation:1")

            other = {"type": EVT_MESSAGE_CREATED, "conversation_id": 2, "message": {"id": 2}}
            assert client.post(
                "/_t/publish", json={"topic": "conversation:2", "event": other}
            ).json()["sent"] == 0
            _sync(ws)  # 若上面被误推，这里先到的就不是 pong

            mine = {"type": EVT_MESSAGE_CREATED, "conversation_id": 1, "message": {"id": 1}}
            assert client.post(
                "/_t/publish", json={"topic": "conversation:1", "event": mine}
            ).json()["sent"] == 1
            assert ws.receive_json() == mine


def test_publish_targets_only_subscribers() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws_a, _connect(client, 2) as ws_b:
            _subscribe(ws_a, "conversation:1")
            _subscribe(ws_b, "inbox")

            event = {"type": EVT_MESSAGE_CREATED, "conversation_id": 1, "message": {"id": 7}}
            sent = client.post(
                "/_t/publish", json={"topic": "conversation:1", "event": event}
            ).json()["sent"]
            assert sent == 1
            assert ws_a.receive_json() == event
            _sync(ws_b)  # B 订的是 inbox，不该收到


def test_unsubscribe_stops_delivery_and_broadcast_reaches_everyone() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws_a, _connect(client, 2) as ws_b:
            _subscribe(ws_a, "inbox")
            _subscribe(ws_b, "inbox")

            ws_a.send_json({"type": "unsubscribe", "topics": ["inbox"]})
            _sync(ws_a)

            event = {"type": EVT_CHANNEL_BLOCKED, "channel_id": 3}
            assert client.post(
                "/_t/publish", json={"topic": "inbox", "event": event}
            ).json()["sent"] == 1
            assert ws_b.receive_json() == event
            _sync(ws_a)  # 退订后收不到

            assert client.post("/_t/broadcast", json={"event": event}).json()["sent"] == 2
            assert ws_a.receive_json() == event
            assert ws_b.receive_json() == event


# --------------------------------------------------------------------------- #
# 3. 协议帧
# --------------------------------------------------------------------------- #
def test_ping_pong() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws:
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}


def test_invalid_json_keeps_connection_alive() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws:
            ws.send_text("{not-json")
            assert ws.receive_json() == {"type": "error", "message": "invalid json"}

            # 合法 JSON 但不是对象，同样算非法
            ws.send_text("[1, 2, 3]")
            assert ws.receive_json() == {"type": "error", "message": "invalid json"}

            ws.send_json({"type": "no-such-type"})
            assert ws.receive_json() == {"type": "error", "message": "unknown type"}

            _sync(ws)  # 连接仍然可用


# --------------------------------------------------------------------------- #
# 4. 定向推送与连接池清理
# --------------------------------------------------------------------------- #
def test_send_to_user_only_hits_that_user() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws_a, _connect(client, 2) as ws_b:
            event = {"type": EVT_DEVICE_STATUS, "device_code": "pc-01", "status": "online"}
            sent = client.post(
                "/_t/send_to_user", json={"user_id": 1, "event": event}
            ).json()["sent"]
            assert sent == 1
            assert ws_a.receive_json() == event
            _sync(ws_b)


def test_stats_cleared_after_disconnect() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws:
            _subscribe(ws, "conversation:1", "inbox")
            stats = _wait_until(
                lambda: (lambda s: s if s["connections"] == 1 else None)(_stats(client)),
                "stats 记录到 1 个连接",
            )
            assert stats["topics"] == {"conversation:1": 1, "inbox": 1}

        # 断开后计数归零，且再 publish 不抛异常
        stats = _wait_until(
            lambda: (lambda s: s if s["connections"] == 0 else None)(_stats(client)),
            "stats 归零",
        )
        assert stats["topics"] == {}
        resp = client.post("/_t/publish", json={"topic": "conversation:1", "event": {"type": "x"}})
        assert resp.status_code == 200
        assert resp.json()["sent"] == 0


# --------------------------------------------------------------------------- #
# 5. 便捷函数的事件形状
# --------------------------------------------------------------------------- #
def test_emit_helpers_event_shape() -> None:
    with TestClient(app) as client:
        with _connect(client, 1) as ws:
            _subscribe(ws, "conversation:1", "inbox")

            message = {"id": 9, "text": "hi"}
            assert client.post(
                "/_t/emit/message", json={"conversation_id": 1, "message": message}
            ).json()["sent"] == 1
            assert ws.receive_json() == {
                "type": EVT_MESSAGE_CREATED,
                "conversation_id": 1,
                "message": message,
            }

            assert client.post(
                "/_t/emit/conversation",
                json={"conversation_id": 1, "payload": {"status": "open"}},
            ).json()["sent"] == 1
            assert ws.receive_json() == {
                "type": EVT_CONVERSATION_UPDATED,
                "conversation_id": 1,
                "status": "open",
            }

            assert client.post(
                "/_t/emit/delivery",
                json={"delivery_id": 7, "status": "failed", "reason": "channel blocked"},
            ).json()["sent"] == 1
            assert ws.receive_json() == {
                "type": EVT_DELIVERY_UPDATED,
                "delivery_id": 7,
                "status": "failed",
                "reason": "channel blocked",
            }

            # 无 reason 时字段不出现
            assert client.post(
                "/_t/emit/delivery", json={"delivery_id": 8, "status": "sent"}
            ).json()["sent"] == 1
            assert ws.receive_json() == {
                "type": EVT_DELIVERY_UPDATED,
                "delivery_id": 8,
                "status": "sent",
            }

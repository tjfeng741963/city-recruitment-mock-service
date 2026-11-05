"""客户端 inbound 上报：入站消息同步给 Node 桥接（4222）的测试。

复用 test_bridge_heartbeat 的桩加载方式（agent/autopilot.py 依赖键鼠模块，
backend 测试环境用桩替代后再加载）。被测的 _send_bridge_inbound /
BridgeClient.inbound 只发 HTTP，不碰窗口和键鼠。
"""

from __future__ import annotations

import json

from tests.test_bridge_heartbeat import (  # noqa: F401
    FakeApi,
    _load_autopilot,
    make_reporter,
)

# 混合批次：入站/出站/群聊/系统会话/空内容
BATCH = {
    "conversations": [
        {"external_id": "S:1688850001", "name": "张三"},
        {"external_id": "R:1002", "name": "普工群"},
        {"external_id": "S:sys001", "name": "企业微信团队"},
    ],
    "messages": [
        {"external_conversation_id": "S:1688850001", "external_msgid": "101",
         "direction": "inbound", "content": "你们厂包吃住吗"},
        # 出站（键鼠发的）绝不上报
        {"external_conversation_id": "S:1688850001", "external_msgid": "102",
         "direction": "outbound", "content": "包的"},
        # 群聊也是真实会话，照常上报
        {"external_conversation_id": "R:1002", "external_msgid": "103",
         "direction": "inbound", "content": "群里有人问工资"},
        # 系统/官方会话不上报
        {"external_conversation_id": "S:sys001", "external_msgid": "104",
         "direction": "inbound", "content": "系统通知"},
        # 空内容不上报（桥接口要求 content 非空）
        {"external_conversation_id": "S:1688850001", "external_msgid": "105",
         "direction": "inbound", "content": "   "},
    ],
}


class FakeBridge:
    """带 inbound 的假桥接客户端；exc 不为 None 时 inbound 抛异常。"""

    enabled = True

    def __init__(self, exc: Exception | None = None) -> None:
        self.heartbeats: list[tuple[str, str]] = []
        self.inbounds: list[dict] = []
        self.exc = exc

    def heartbeat(self, state: str, account_id: str = "") -> dict:
        self.heartbeats.append((state, account_id))
        return {"device": {"state": state}}

    def inbound(self, event_id: str, contact_id: str, content: str, nickname: str = "") -> dict:
        self.inbounds.append({
            "event_id": event_id,
            "contact_id": contact_id,
            "content": content,
            "nickname": nickname,
        })
        if self.exc is not None:
            raise self.exc
        return {"status": "processed", "reply_status": "observe_only"}


def test_inbound_reported_only_for_inbound_messages(tmp_path, capsys):
    """入站消息逐条上报；出站/系统会话/空内容跳过；nickname 取会话名。"""
    autopilot = _load_autopilot()
    api = FakeApi()
    bridge = FakeBridge()
    rep = make_reporter(autopilot, api, bridge, tmp_path)

    rep._run({"wecom_state": "online", "queue_size": 0, "last_error": ""}, BATCH)

    assert [(m["event_id"], m["contact_id"], m["content"], m["nickname"]) for m in bridge.inbounds] == [
        ("S:1688850001:101", "S:1688850001", "你们厂包吃住吗", "张三"),
        ("R:1002:103", "R:1002", "群里有人问工资", "普工群"),
    ]
    # 主心跳照常
    assert len(api.calls) == 1
    out = capsys.readouterr().out
    assert "[桥接] inbound 上报 2 条" in out


def test_bridge_inbound_failure_does_not_break_reporting(tmp_path, capsys):
    """桥接 inbound 全部失败：只打日志，主心跳/主上报照常，进程不崩。"""
    autopilot = _load_autopilot()
    api = FakeApi()
    bridge = FakeBridge(exc=TimeoutError("timed out"))
    rep = make_reporter(autopilot, api, bridge, tmp_path)

    rep._run({"wecom_state": "online", "queue_size": 0, "last_error": ""}, BATCH)

    # 失败逐条被吞，上报条数=入站可上报条数（2），但都没有成功
    assert len(bridge.inbounds) == 2
    assert len(api.calls) == 1  # 主心跳照常
    out = capsys.readouterr().out
    assert "失败（忽略）" in out
    assert "[心跳]" in out


def test_unconfigured_bridge_skips_inbound(tmp_path, capsys):
    """未配置桥接时整体跳过，不报错。"""
    autopilot = _load_autopilot()
    api = FakeApi()
    rep = make_reporter(autopilot, api, None, tmp_path)

    rep._run({"wecom_state": "online", "queue_size": 0, "last_error": ""}, BATCH)
    out = capsys.readouterr().out
    assert "[桥接] inbound" not in out or "异常" in out


def test_bridge_inbound_request_shape(monkeypatch):
    """BridgeClient.inbound 发出正确的方法/路径/头/体。"""
    autopilot = _load_autopilot()
    agent_client = autopilot.agent_client

    captured: list = []

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"status": "processed", "reply_status": "observe_only"}).encode()

    class FakeOpener:
        def open(self, req, timeout=None):
            captured.append((req, timeout))
            return FakeResp()

    monkeypatch.setattr(
        agent_client.urllib.request, "build_opener", lambda *a, **kw: FakeOpener()
    )

    bridge = agent_client.BridgeClient(
        "http://119.91.113.100:4222/", "bridge-tok-123", "pc-office-01"
    )
    res = bridge.inbound("S:1688850001:101", "S:1688850001", "你们厂包吃住吗", "张三")

    assert len(captured) == 1
    req, _timeout = captured[0]
    assert req.get_method() == "POST"
    assert req.full_url == (
        "http://119.91.113.100:4222/api/v1/bridge/devices/pc-office-01/inbound"
    )
    assert req.get_header("Authorization") == "Bearer bridge-tok-123"
    assert json.loads(req.data) == {
        "event_id": "S:1688850001:101",
        "contact_id": "S:1688850001",
        "content": "你们厂包吃住吗",
        "nickname": "张三",
    }
    assert res == {"status": "processed", "reply_status": "observe_only"}

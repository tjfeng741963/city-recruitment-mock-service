"""客户端双向消息上报：同步给 Node 桥接（4222）的测试。

复用 test_bridge_heartbeat 的桩加载方式（agent/autopilot.py 依赖键鼠模块，
backend 测试环境用桩替代后再加载）。被测的 _send_bridge_messages /
BridgeClient.inbound 只发 HTTP，不碰窗口和键鼠。
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

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
        # 出站（自动回复或直接在企微里发的）也同步
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
    device_code = "test-device"

    def __init__(self, exc: Exception | None = None) -> None:
        self.heartbeats: list[tuple[str, str]] = []
        self.inbounds: list[dict] = []
        self.outbounds: list[dict] = []
        self.requests: list[tuple] = []
        self.exc = exc

    def _request(self, method, path, body):
        self.requests.append((method, path, body))
        if path.endswith("/inbound"):
            return self.inbound(**{k: v for k, v in body.items() if k != "sent_at"})
        assert path.endswith("/outbound")
        self.outbounds.append(body)
        if self.exc is not None:
            raise self.exc
        return {"status": "processed"}

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


def test_both_directions_reported_except_system_and_empty_messages(tmp_path, capsys):
    """双向逐条上报；系统会话/空内容跳过；nickname 取会话名。"""
    autopilot = _load_autopilot()
    api = FakeApi()
    bridge = FakeBridge()
    rep = make_reporter(autopilot, api, bridge, tmp_path)

    rep._run({"wecom_state": "online", "queue_size": 0, "last_error": ""}, BATCH)

    assert [(m["event_id"], m["contact_id"], m["content"], m["nickname"]) for m in bridge.inbounds] == [
        ("S:1688850001:101", "S:1688850001", "你们厂包吃住吗", "张三"),
        ("R:1002:103", "R:1002", "群里有人问工资", "普工群"),
    ]
    assert [m["event_id"] for m in bridge.outbounds] == ["S:1688850001:102"]
    # 主心跳照常
    assert len(api.calls) == 1
    out = capsys.readouterr().out
    assert "[桥接] messages 上报 3 条" in out


def test_bridge_inbound_failure_does_not_break_reporting(tmp_path, capsys):
    """桥接 inbound 全部失败：只打日志，主心跳/主上报照常，进程不崩。

    4687c48 起「单条失败不堵队」：一轮里所有 pending 都会被尝试一遍，
    失败的留在队列里下轮重试，而不是失败一条就停整队。
    """
    autopilot = _load_autopilot()
    api = FakeApi()
    bridge = FakeBridge(exc=TimeoutError("timed out"))
    rep = make_reporter(autopilot, api, bridge, tmp_path)

    rep._run({"wecom_state": "online", "queue_size": 0, "last_error": ""}, BATCH)

    # FakeBridge 先记账再抛异常：两条 inbound、一条 outbound 都被尝试过
    assert len(bridge.inbounds) == 2
    assert len(bridge.outbounds) == 1
    # 全部失败，全部留在队列等待下轮重试
    assert len(rep._bridge_pending) == 3
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


class IngestApi(FakeApi):
    def ingest(self, batch):
        return {"messages_created": len(batch["messages"])}


HEARTBEAT = {"wecom_state": "online", "queue_size": 0, "last_error": ""}


def test_bridge_failure_retries_after_primary_cursor_advances_and_process_restarts(tmp_path):
    autopilot = _load_autopilot()
    bridge = FakeBridge(exc=TimeoutError("offline"))
    rep = make_reporter(autopilot, IngestApi(), bridge, tmp_path)
    rep._run(HEARTBEAT, BATCH)
    assert rep._cursor["S:1688850001"] == 105
    saved = json.loads(rep.state_path.read_text(encoding="utf-8"))
    assert len(saved["bridge_pending"]) == 3

    recovered = FakeBridge()
    restarted = make_reporter(autopilot, IngestApi(), recovered, tmp_path)
    restarted._run(HEARTBEAT, {"messages": []})
    assert [event["event_id"] for event in recovered.inbounds] == ["S:1688850001:101", "R:1002:103"]
    assert [event["event_id"] for event in recovered.outbounds] == ["S:1688850001:102"]
    assert restarted._bridge_pending == {}
    assert json.loads(restarted.state_path.read_text(encoding="utf-8"))["bridge_pending"] == {}
    restarted._run(HEARTBEAT, {"messages": []})
    assert len(recovered.inbounds) == 2


def test_partial_success_keeps_only_unacknowledged_records(tmp_path):
    autopilot = _load_autopilot()
    bridge = FakeBridge()
    original = bridge.inbound

    def send(**event):
        if event["contact_id"].startswith("R:"):
            raise TimeoutError("second record failed")
        return original(**event)

    bridge.inbound = send
    rep = make_reporter(autopilot, IngestApi(), bridge, tmp_path)
    rep._run(HEARTBEAT, BATCH)
    assert len(rep._bridge_pending) == 1
    assert next(iter(rep._bridge_pending.values()))["event"]["event_id"] == "R:1002:103"
    bridge.inbound = original
    rep._run(HEARTBEAT, {"messages": []})
    assert [event["event_id"] for event in bridge.inbounds] == ["S:1688850001:101", "R:1002:103"]


def test_bridge_queue_is_durable_before_primary_ingest(tmp_path):
    autopilot = _load_autopilot()
    rep = make_reporter(autopilot, IngestApi(), FakeBridge(), tmp_path)
    original = rep.api.ingest

    def ingest(batch):
        saved = json.loads(rep.state_path.read_text(encoding="utf-8"))
        assert len(saved["bridge_pending"]) == 3
        return original(batch)

    rep.api.ingest = ingest
    rep._run(HEARTBEAT, BATCH)
    assert not rep._bridge_pending


def test_queue_write_failure_does_not_advance_primary_cursor(tmp_path, monkeypatch):
    autopilot = _load_autopilot()
    api = IngestApi()
    api.ingest = MagicMock()
    bridge = FakeBridge()
    rep = make_reporter(autopilot, api, bridge, tmp_path)
    monkeypatch.setattr(rep, "_save", lambda: False)
    rep._run(HEARTBEAT, BATCH)
    api.ingest.assert_not_called()
    assert rep._cursor == {}
    assert bridge.inbounds == []
    assert len(api.calls) == 1


def test_pending_records_are_not_sent_to_a_reconfigured_bridge(tmp_path):
    autopilot = _load_autopilot()
    bridge = FakeBridge(exc=TimeoutError("offline"))
    bridge.base_url = "http://old.example"
    rep = make_reporter(autopilot, IngestApi(), bridge, tmp_path)
    rep._run(HEARTBEAT, BATCH)
    other = FakeBridge()
    other.base_url = "http://new.example"
    restarted = make_reporter(autopilot, IngestApi(), other, tmp_path)
    restarted._run(HEARTBEAT, {"messages": []})
    assert other.inbounds == []
    assert other.outbounds == []
    assert len(restarted._bridge_pending) == 3


def test_old_state_files_without_queue_remain_compatible(tmp_path):
    autopilot = _load_autopilot()
    (tmp_path / "state.json").write_text(json.dumps({"cursor": {"S:old": 100}}), encoding="utf-8")
    rep = make_reporter(autopilot, IngestApi(), FakeBridge(), tmp_path)
    assert rep._cursor == {"S:old": 100}
    assert rep._bridge_pending == {}


def test_old_pending_inbound_format_remains_compatible(tmp_path):
    autopilot = _load_autopilot()
    event = {"event_id": "old:1", "contact_id": "S:old", "content": "old", "nickname": "old"}
    (tmp_path / "state.json").write_text(json.dumps({"bridge_pending": {
        "old-key": {"destination": ["", "test-device"], "event": event},
    }}), encoding="utf-8")
    bridge = FakeBridge()
    rep = make_reporter(autopilot, IngestApi(), bridge, tmp_path)
    rep._run(HEARTBEAT, {"messages": []})
    assert bridge.inbounds == [event]
    assert rep._bridge_pending == {}


def test_outbound_retry_keeps_timestamp_and_uses_escaped_device_path(tmp_path):
    autopilot = _load_autopilot()
    bridge = FakeBridge()
    bridge.device_code = "device/with space"
    event = {**BATCH["messages"][1], "sent_at": "2026-11-06T02:00:00+00:00"}
    rep = make_reporter(autopilot, IngestApi(), bridge, tmp_path)
    rep._run(HEARTBEAT, {"messages": [event]})
    method, path, body = bridge.requests[0]
    assert (method, path) == ("POST", "/api/v1/bridge/devices/device%2Fwith%20space/outbound")
    assert body["sent_at"] == event["sent_at"]


def test_outbound_failure_is_durable_and_retried_after_restart(tmp_path):
    autopilot = _load_autopilot()
    failed = FakeBridge(exc=TimeoutError("offline"))
    rep = make_reporter(autopilot, IngestApi(), failed, tmp_path)
    rep._run(HEARTBEAT, {"messages": [BATCH["messages"][1]]})
    assert len(failed.outbounds) == 1
    recovered = FakeBridge()
    restarted = make_reporter(autopilot, IngestApi(), recovered, tmp_path)
    restarted._run(HEARTBEAT, {"messages": []})
    assert recovered.outbounds == failed.outbounds
    assert restarted._bridge_pending == {}

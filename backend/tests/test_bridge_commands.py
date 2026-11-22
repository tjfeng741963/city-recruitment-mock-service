"""控制台主动发消息：客户端 claim 指令 → 键鼠发送 → 回执。

agent/autopilot.py 在真实机器上依赖 pywin32 / 键鼠补丁；这里沿用
test_bridge_heartbeat 的做法，用桩替代 wecom_io_core / compat，
被测的 claim / 发送编排 / 回执本身只调 HTTP 和 core_send，桩不影响逻辑。
"""

from __future__ import annotations

import json
import types
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot as _load_autopilot
from tests.agent_loader import load_reply_store


@pytest.fixture(autouse=True)
def _real_command_journal(tmp_path, monkeypatch):
    original = _load_autopilot

    def load():
        module = original()
        module.rlog = load_reply_store(tmp_path / "reply_log.db")
        return module

    monkeypatch.setattr(f"{__name__}._load_autopilot", load)


def _reset(autopilot):
    """CLAIM_INTERVAL / 冷却都是模块级状态，测试之间必须重置。"""
    autopilot._last_claim_at = 0.0
    autopilot._last_reply_at = 0.0
    autopilot._last_error = ""


class FakeBridge:
    """桥接客户端桩：只记录 claim / receipt 调用。"""

    enabled = True
    base_url = "http://bridge.example"
    device_code = "pc-office-01"

    def __init__(self, command: dict | None = None, claim_exc: Exception | None = None):
        self.command = command
        self.claim_exc = claim_exc
        self.claim_calls = 0
        self.receipts: list[tuple] = []

    def claim(self):
        self.claim_calls += 1
        if self.claim_exc is not None:
            raise self.claim_exc
        return self.command

    def receipt(self, command_id, lease_token, status, message_id=""):
        self.receipts.append((command_id, lease_token, status, message_id))
        return {"ok": True}


COMMAND = {
    "id": "cmd-0001",
    "device_code": "pc-office-01",
    "customer_id": 700004,
    "contact_id": "S:1688858186855249_7881299918302353",
    "nickname": "青冥",
    "content": "你好，这边是人工客服",
    "status": "claimed",
    "lease_token": "lease-abc",
    "lease_until": 4102444800000,
}


def _mock_store(name: str = "青冥"):
    """真实 Store 的替身：会话列表里有一个可发送的客户会话。"""
    store = MagicMock()
    store.sessions.return_value = [{"name": name, "id": "S:1688858186855249_7881299918302353"}]
    return store


def _cfg(**over):
    cfg = {"cooldown": 0.0, "dry_run": False}
    cfg.update(over)
    return cfg


@pytest.mark.parametrize("new_ids,confirmed,status,expected", [
    ([102], True, "succeeded", "S:1688858186855249_7881299918302353:102"),
    ([102, 103], True, "unknown", ""),
    ([], True, "unknown", ""),
    ([102], False, "succeeded", "S:1688858186855249_7881299918302353:102"),
])
def test_manual_receipt_correlates_only_one_new_confirmed_database_message(new_ids, confirmed, status, expected):
    autopilot = _load_autopilot()
    store = _mock_store()
    store.self_id.return_value = "owner"
    old = (101, COMMAND["content"])
    query = store._conn.return_value.execute
    query.return_value.fetchall.side_effect = [[old], [old, *((mid, COMMAND["content"]) for mid in new_ids)]]
    autopilot.core_send.send.return_value = {
        "ok": True, "conversation_id": COMMAND["contact_id"] if confirmed else "", "detail": "ok",
    }
    bridge = FakeBridge(command=dict(COMMAND))
    assert autopilot.pump_commands(store, _cfg(), bridge=bridge) == {
        "claimed": 1, "sent": int(status == "succeeded"), "failed": int(status == "unknown"),
    }
    assert bridge.receipts[-1][2:] == (status, expected)
    assert all(call.args[1] == (COMMAND["contact_id"], "owner") for call in query.call_args_list)
    store.refresh.assert_not_called()


# --------------------------------------------------------------------------- #
# 1. 领到指令 → 用会话昵称和内容调用键鼠发送 → 回执 succeeded
# --------------------------------------------------------------------------- #
def test_claim_sends_with_keyboard_and_reports_success(monkeypatch, capsys):
    autopilot = _load_autopilot()
    _reset(autopilot)
    sent: list[tuple] = []

    def fake_send(store, name, text, **kwargs):
        sent.append((name, text, kwargs.get("verify_db"), kwargs.get("expect_id")))
        return {"ok": True, "conversation_id": COMMAND["contact_id"], "detail": "已发送"}

    monkeypatch.setattr(autopilot, "core_send", types.SimpleNamespace(send=fake_send))
    bridge = FakeBridge(command=dict(COMMAND))
    store = _mock_store()
    store.self_id.return_value = "owner"
    store._conn.return_value.execute.return_value.fetchall.side_effect = [[], [(102, COMMAND["content"])]]

    stats = autopilot.pump_commands(store, _cfg(cooldown=0.0), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 1, "sent": 1, "failed": 0}
    # 用昵称做搜索关键词，人工回读开启并约束目标 contact_id。
    assert sent == [("青冥", "你好，这边是人工客服", True, "S:1688858186855249_7881299918302353")]
    assert bridge.receipts == [("cmd-0001", "lease-abc", "succeeded", f"{COMMAND['contact_id']}:102")]
    assert autopilot._last_reply_at > 0  # 发送后进入冷却，自动回复不会立刻抢键鼠
    out = capsys.readouterr().out
    assert "[指令] 人工发送" in out and "已发送" in out


# --------------------------------------------------------------------------- #
# 2. 发送失败 → 落 failed 回执，指令不会卡在 claimed
# --------------------------------------------------------------------------- #
def test_send_failure_reports_failed_receipt(monkeypatch):
    autopilot = _load_autopilot()
    _reset(autopilot)
    monkeypatch.setattr(
        autopilot,
        "core_send",
        types.SimpleNamespace(send=lambda store, name, text, **kw: {"ok": False, "detail": "没找到企业微信窗口"}),
    )
    bridge = FakeBridge(command=dict(COMMAND))

    stats = autopilot.pump_commands(_mock_store(), _cfg(), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 1, "sent": 0, "failed": 1}
    assert bridge.receipts == [("cmd-0001", "lease-abc", "failed", "")]
    assert autopilot._last_error == "没找到企业微信窗口"


# --------------------------------------------------------------------------- #
# 3. 发送抛异常 → 回执 failed，异常不外抛
# --------------------------------------------------------------------------- #
def test_send_exception_is_contained(monkeypatch):
    autopilot = _load_autopilot()
    _reset(autopilot)

    def boom(*args, **kwargs):
        raise OSError("clipboard died")

    monkeypatch.setattr(autopilot, "core_send", types.SimpleNamespace(send=boom))
    bridge = FakeBridge(command=dict(COMMAND))

    stats = autopilot.pump_commands(_mock_store(), _cfg(), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 1, "sent": 0, "failed": 1}
    assert bridge.receipts[-1][2] == "unknown"


# --------------------------------------------------------------------------- #
# 4. 企微非 online / dry-run / 未配置桥接 → 一条都不领
# --------------------------------------------------------------------------- #
def test_does_not_claim_when_not_online(monkeypatch):
    autopilot = _load_autopilot()
    _reset(autopilot)
    bridge = FakeBridge(command=dict(COMMAND))

    assert autopilot.pump_commands(MagicMock(), _cfg(), bridge=bridge, wecom_state="hidden") == {
        "claimed": 0, "sent": 0, "failed": 0,
    }
    assert bridge.claim_calls == 0

    autopilot._last_claim_at = 0.0
    assert autopilot.pump_commands(_mock_store(), _cfg(dry_run=True), bridge=bridge, wecom_state="online") == {
        "claimed": 0, "sent": 0, "failed": 0,
    }
    assert bridge.claim_calls == 0
    assert autopilot.pump_commands(_mock_store(), _cfg(), bridge=None, wecom_state="online")["claimed"] == 0


# --------------------------------------------------------------------------- #
# 5. claim 请求异常 → 只记日志，主循环不受影响
# --------------------------------------------------------------------------- #
def test_claim_exception_does_not_raise(capsys):
    autopilot = _load_autopilot()
    _reset(autopilot)
    bridge = FakeBridge(claim_exc=TimeoutError("timed out"))

    stats = autopilot.pump_commands(_mock_store(), _cfg(), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 0, "sent": 0, "failed": 0}
    assert "[指令] 领取失败（忽略）" in capsys.readouterr().out


def test_missing_nickname_fails_fast_without_touching_keyboard(monkeypatch):
    autopilot = _load_autopilot()
    _reset(autopilot)
    called = []
    monkeypatch.setattr(autopilot, "core_send", types.SimpleNamespace(send=lambda *a, **kw: called.append(1) or {"ok": True}))
    bridge = FakeBridge(command={**COMMAND, "nickname": ""})

    stats = autopilot.pump_commands(_mock_store(), _cfg(), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 1, "sent": 0, "failed": 1}
    assert called == []
    assert bridge.receipts == [("cmd-0001", "lease-abc", "failed", "")]


# --------------------------------------------------------------------------- #
# 6. 10 秒节流：同一个周期内重复调用不会再领
# --------------------------------------------------------------------------- #
def test_claim_is_throttled(monkeypatch):
    autopilot = _load_autopilot()
    _reset(autopilot)
    monkeypatch.setattr(autopilot, "core_send", types.SimpleNamespace(send=lambda *a, **kw: {"ok": True, "detail": "ok"}))
    bridge = FakeBridge(command=dict(COMMAND))

    autopilot.pump_commands(_mock_store(), _cfg(), bridge=bridge, wecom_state="online")
    autopilot.pump_commands(_mock_store(), _cfg(), bridge=bridge, wecom_state="online")

    assert bridge.claim_calls == 1


# --------------------------------------------------------------------------- #
# 6b. 盲发护栏：系统会话 / 不在会话列表的名字，一律不碰键鼠
# --------------------------------------------------------------------------- #
def test_refuses_system_conversation(monkeypatch, capsys):
    autopilot = _load_autopilot()
    _reset(autopilot)
    called: list = []
    monkeypatch.setattr(autopilot, "core_send", types.SimpleNamespace(send=lambda *a, **kw: called.append(1) or {"ok": True}))
    bridge = FakeBridge(command={**COMMAND, "nickname": "我的客服"})
    store = MagicMock()
    store.sessions.return_value = [{"name": "我的客服", "id": "S:0_1"}]

    stats = autopilot.pump_commands(store, _cfg(), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 1, "sent": 0, "failed": 1}
    assert called == []
    assert bridge.receipts == [("cmd-0001", "lease-abc", "failed", "")]
    assert "系统/官方会话" in capsys.readouterr().out


def test_refuses_name_missing_from_wecom_sessions(monkeypatch, capsys):
    autopilot = _load_autopilot()
    _reset(autopilot)
    called: list = []
    monkeypatch.setattr(autopilot, "core_send", types.SimpleNamespace(send=lambda *a, **kw: called.append(1) or {"ok": True}))
    bridge = FakeBridge(command={**COMMAND, "nickname": "查无此人"})
    store = MagicMock()
    store.sessions.return_value = [{"name": "青冥", "id": "S:0_1"}]

    stats = autopilot.pump_commands(store, _cfg(), bridge=bridge, wecom_state="online")

    assert stats == {"claimed": 1, "sent": 0, "failed": 1}
    assert called == []
    assert bridge.receipts == [("cmd-0001", "lease-abc", "failed", "")]
    assert "不在企微会话列表" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# 7. BridgeClient 的方法/路径/头/体
# --------------------------------------------------------------------------- #
def test_bridge_client_claim_and_receipt_request_shape(monkeypatch):
    autopilot = _load_autopilot()
    agent_client = autopilot.agent_client
    captured: list = []

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"command": {"id": "cmd-1"}}).encode()

    class FakeOpener:
        def open(self, req, timeout=None):
            captured.append(req)
            return FakeResp()

    monkeypatch.setattr(agent_client.urllib.request, "build_opener", lambda *a, **kw: FakeOpener())
    bridge = agent_client.BridgeClient("http://119.91.113.100:4222", "bridge-tok", "pc-office-01")

    assert bridge.claim() == {"id": "cmd-1"}
    bridge.receipt("cmd-1", "lease-1", "succeeded", "keyboard-cmd-1")

    claim_req, receipt_req = captured
    assert claim_req.get_method() == "POST"
    assert claim_req.full_url == "http://119.91.113.100:4222/api/v1/bridge/devices/pc-office-01/claim"
    assert claim_req.get_header("Authorization") == "Bearer bridge-tok"
    assert json.loads(claim_req.data) == {}

    assert receipt_req.full_url == "http://119.91.113.100:4222/api/v1/bridge/devices/pc-office-01/receipts"
    assert json.loads(receipt_req.data) == {
        "command_id": "cmd-1",
        "lease_token": "lease-1",
        "status": "succeeded",
        "message_id": "keyboard-cmd-1",
    }

"""客户端双通道心跳：桥接（4222）上报逻辑测试。

agent/autopilot.py 依赖 pywin32 / 键鼠补丁（wecom_io_core、compat），
backend 测试环境没有这些依赖，这里用桩替代后再加载模块。
被测的 Reporter 桥接逻辑 / BridgeClient / map_bridge_state 本身
只发 HTTP，不碰窗口和键鼠，桩不影响被测代码路径。
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from tests.agent_loader import load_autopilot as _load_autopilot


class FakeApi:
    """主心跳（8090）的假客户端，只记录调用。"""

    def __init__(self) -> None:
        self.device_code = "pc-office-01"
        self.calls: list[dict] = []

    def heartbeat(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        return {"ok": True}


class FakeBridge:
    """桥接（4222）的假客户端；exc 不为 None 时模拟请求失败。"""

    enabled = True

    def __init__(self, exc: Exception | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.exc = exc

    def heartbeat(self, state: str, account_id: str = "") -> dict:
        self.calls.append((state, account_id))
        if self.exc is not None:
            raise self.exc
        return {"device": {"device_code": "pc-office-01", "state": state}}


def make_reporter(autopilot, api, bridge, tmp_path):
    """直接构造 Reporter，state 文件指到 tmp，绝不碰真实游标文件。"""
    store = MagicMock()
    store.self_id.return_value = "1688858186855249"
    rep = autopilot.Reporter(
        api,
        store,
        state_path=tmp_path / "state.json",
        device_code="pc-office-01",
        bridge=bridge,
    )
    return rep


# --------------------------------------------------------------------------- #
# 1. 配置无 bridge 字段 → 不发桥接请求，主心跳照常
# --------------------------------------------------------------------------- #
def test_missing_bridge_config_skips_bridge(tmp_path, capsys):
    autopilot = _load_autopilot()
    cfg = {
        "server": "http://8090.example",
        "device_token": "tok",
        "device_code": "pc-office-01",
        # 故意没有 bridge_server / bridge_token
    }
    rep = autopilot._make_reporter(cfg, MagicMock())
    assert rep is not None
    assert rep.bridge is None  # 桥接整体跳过

    rep.api = FakeApi()
    rep.state_path = tmp_path / "state.json"  # 避免写真实游标文件
    rep._run({"wecom_state": "online", "queue_size": 0, "last_error": ""}, {"messages": []})

    out = capsys.readouterr().out
    assert "[桥接] 未配置 bridge_server / bridge_token" in out
    assert "[心跳]" in out and "ok=True" in out  # 主心跳照常


# --------------------------------------------------------------------------- #
# 2. 配置齐全 → 发出正确方法/路径/头/体（state 映射对）
# --------------------------------------------------------------------------- #
def test_bridge_request_shape(monkeypatch):
    autopilot = _load_autopilot()
    agent_client = autopilot.agent_client

    captured: list = []

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"device": {"device_code": "pc-office-01"}}).encode()

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
    res = bridge.heartbeat("online", account_id="1688858186855249")

    assert len(captured) == 1
    req, timeout = captured[0]
    assert req.get_method() == "POST"
    assert req.full_url == (
        "http://119.91.113.100:4222/api/v1/bridge/devices/pc-office-01/heartbeat"
    )
    assert req.get_header("Authorization") == "Bearer bridge-tok-123"
    assert json.loads(req.data) == {
        "state": "online",
        "account_id": "1688858186855249",
    }
    assert timeout == bridge.timeout
    assert res == {"device": {"device_code": "pc-office-01"}}


def test_state_mapping_conservative():
    """只有确认 online 才报 online，其余一律 offline。"""
    autopilot = _load_autopilot()
    assert autopilot.map_bridge_state("online") == "online"
    assert autopilot.map_bridge_state("hidden") == "offline"
    assert autopilot.map_bridge_state("login_required") == "offline"
    assert autopilot.map_bridge_state("not_running") == "offline"
    assert autopilot.map_bridge_state("unknown") == "offline"
    assert autopilot.map_bridge_state("") == "offline"


# --------------------------------------------------------------------------- #
# 3. 桥接请求抛超时 → 主心跳仍 ok，进程不崩
# --------------------------------------------------------------------------- #
def test_bridge_timeout_does_not_break_main_heartbeat(tmp_path, capsys):
    autopilot = _load_autopilot()
    api = FakeApi()
    bridge = FakeBridge(exc=TimeoutError("timed out"))
    rep = make_reporter(autopilot, api, bridge, tmp_path)

    # _run 在真实代码里跑在后台线程；这里直接调用，异常不该外抛
    rep._run({"wecom_state": "online", "queue_size": 2, "last_error": ""}, {"messages": []})

    # 主心跳发出且成功
    assert len(api.calls) == 1
    assert api.calls[0]["wecom_state"] == "online"
    # 桥接确实尝试过、失败被吞掉
    assert len(bridge.calls) == 1
    out = capsys.readouterr().out
    assert "[心跳]" in out and "ok=True" in out
    assert "[桥接]" in out and "失败" in out


# --------------------------------------------------------------------------- #
# 4. hidden → 上报 offline（account_id 一并带上）
# --------------------------------------------------------------------------- #
def test_hidden_reports_offline(tmp_path, capsys):
    autopilot = _load_autopilot()
    api = FakeApi()
    bridge = FakeBridge()
    rep = make_reporter(autopilot, api, bridge, tmp_path)

    rep._run({"wecom_state": "hidden", "queue_size": 0, "last_error": ""}, {"messages": []})

    assert bridge.calls == [("offline", "1688858186855249")]
    out = capsys.readouterr().out
    assert "[桥接] pc-office-01 → offline ok=True" in out

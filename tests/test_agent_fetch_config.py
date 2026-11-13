"""远端配置拉取/合并/热更（agent/client.py fetch_config + agent/remote_config.py）。

只依赖标准库模块：client 与 remote_config 都不引 pywin32，可在根 tests/ 的
pytest 环境直接导入（autopilot.py 本体因依赖 wecom_io_core/win32api 不在此导入）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
sys.path.insert(0, str(AGENT_DIR))

import client as agent_client  # noqa: E402
import remote_config as rc  # noqa: E402


class FakeClient:
    """按序返回 payload 的假 BridgeClient；元素为 Exception 时模拟网络失败。"""

    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = 0

    def fetch_config(self, device_code: str = "") -> dict | None:
        self.calls += 1
        if not self.payloads:
            return None
        item = self.payloads.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def _restore_device_scripts():
    """_device_scripts 是模块级全局，测完还原，避免用例间串扰。"""
    yield
    rc._device_scripts = []


def payload(version="2026-11-10T22:00:00Z", interval=20, cooldown=8, merge=0, scripts=None):
    return {
        "version": version,
        "interval_seconds": interval,
        "cooldown": cooldown,
        "merge_delay_seconds": merge,
        "scripts": scripts if scripts is not None else [],
    }


# ── client.BridgeClient.fetch_config ────────────────────────────────────────

def test_fetch_config_builds_bridge_request(monkeypatch):
    br = agent_client.BridgeClient("http://bridge:4222", "tok", "dev-01")
    seen = {}

    def fake_request(method, path, body=None):
        seen["method"] = method
        seen["path"] = path
        return {"version": "v1", "scripts": []}

    monkeypatch.setattr(br, "_request", fake_request)
    assert br.fetch_config() == {"version": "v1", "scripts": []}
    assert seen == {"method": "GET", "path": "/api/v1/bridge/devices/dev-01/config"}


def test_fetch_config_returns_none_on_connection_error():
    # 127.0.0.1 上没有服务在听这个端口，连接立刻被拒；5s 超时兜底
    br = agent_client.BridgeClient("http://127.0.0.1:9", "tok", "dev-01")
    assert br.fetch_config() is None


# ── 参数合并 ────────────────────────────────────────────────────────────────

def test_apply_remote_params_overrides_local_only_present_keys():
    cfg = {"interval": 20, "cooldown": 8.0}
    changed = rc.apply_remote_params(cfg, payload(interval=35, cooldown=12, merge=2))
    assert changed == ["interval", "cooldown", "merge_delay"]
    assert cfg == {"interval": 35, "cooldown": 12, "merge_delay": 2}


def test_apply_remote_params_ignores_invalid_values():
    cfg = {"interval": 20, "cooldown": 8}
    changed = rc.apply_remote_params(
        cfg,
        {"interval_seconds": 0, "cooldown": "abc", "merge_delay_seconds": -1, "other": 1},
    )
    assert changed == []
    assert cfg == {"interval": 20, "cooldown": 8}


# ── RemoteConfig.sync：成功合并 + 写缓存 ────────────────────────────────────

def test_sync_success_merges_caches_and_stores_scripts(tmp_path):
    cache = tmp_path / "config.remote.json"
    scripts = [{"stage": "send_info", "city": "深圳", "title": "龙华厂标准介绍", "content": "你好"}]
    cfg = {"interval": 20, "cooldown": 8}
    remote = rc.RemoteConfig(FakeClient([payload(interval=45, cooldown=10, scripts=scripts)]), cache_path=cache)
    assert remote.sync(cfg) is True
    assert cfg == {"interval": 45, "cooldown": 10, "merge_delay": 0.0}
    assert rc.device_scripts() == scripts
    saved = json.loads(cache.read_text(encoding="utf-8"))
    assert saved["version"] == "2026-11-10T22:00:00Z"
    assert saved["interval_seconds"] == 45
    assert saved["scripts"] == scripts


# ── RemoteConfig.sync：失败兜底（缓存 → 空）────────────────────────────────

def test_sync_failure_falls_back_to_cache(tmp_path):
    cache = tmp_path / "config.remote.json"
    scripts = [{"stage": "ask_city", "city": "广州", "title": "", "content": "想找哪个城市？"}]
    cache.write_text(json.dumps({"version": "v1", "interval_seconds": 30, "cooldown": 9, "scripts": scripts}), encoding="utf-8")
    cfg = {"interval": 20, "cooldown": 8}
    remote = rc.RemoteConfig(FakeClient([RuntimeError("boom")]), cache_path=cache)
    assert remote.sync(cfg) is False
    # 参数不动（本地 config.json 兜底），话术用缓存兜底
    assert cfg == {"interval": 20, "cooldown": 8}
    assert rc.device_scripts() == scripts


def test_no_cache_and_no_server_means_empty_scripts(tmp_path):
    remote = rc.RemoteConfig(FakeClient([None]), cache_path=tmp_path / "config.remote.json")
    assert remote.sync() is False
    assert rc.device_scripts() == []


# ── version 变更触发重拉热更 ────────────────────────────────────────────────

def test_version_change_triggers_refetch_and_hot_update(tmp_path):
    cache = tmp_path / "config.remote.json"
    cfg = {"interval": 20, "cooldown": 8}
    first_scripts = [{"stage": "send_info", "city": "深圳", "title": "v1", "content": "a"}]
    second_scripts = [{"stage": "send_info", "city": "深圳", "title": "v2", "content": "b"}]
    fake = FakeClient([
        payload(version="v1", interval=30, scripts=first_scripts),
        payload(version="v1", interval=99),  # version 没变：不热更
        payload(version="v2", interval=45, cooldown=15, scripts=second_scripts),
    ])
    remote = rc.RemoteConfig(fake, cache_path=cache)
    assert remote.sync(cfg) is True
    assert cfg["interval"] == 30
    assert rc.device_scripts() == first_scripts
    assert remote.sync(cfg) is True
    assert cfg["interval"] == 30  # 同 version 不覆盖
    assert fake.calls == 2
    assert remote.sync(cfg) is True
    assert cfg == {"interval": 45, "cooldown": 15, "merge_delay": 0.0}
    assert rc.device_scripts() == second_scripts
    assert remote.version == "v2"
    assert fake.calls == 3
    assert json.loads(cache.read_text(encoding="utf-8"))["version"] == "v2"


def test_restart_reapplies_cached_params_when_version_unchanged(tmp_path):
    cache = tmp_path / "config.remote.json"
    cache.write_text(
        json.dumps({"version": "v1", "interval_seconds": 30, "cooldown": 9, "scripts": []}),
        encoding="utf-8",
    )
    # 重启场景：config.json 还是旧值，version 未变也要把缓存参数并回
    cfg = {"interval": 20, "cooldown": 8}
    remote = rc.RemoteConfig(FakeClient([payload(version="v1")]), cache_path=cache)
    assert remote.sync(cfg) is True
    assert cfg == {"interval": 30, "cooldown": 9}


# ── 人工接管名单（R4）：随 /config 下发，drain 命中就跳过 ──────────────────

def test_takeover_sessions_come_from_remote(tmp_path):
    remote_payload = payload(version="v-takeover", scripts=[])
    remote_payload["takeover_sessions"] = ["S:alice", "R:group-1"]
    remote = rc.RemoteConfig(FakeClient([remote_payload]), cache_path=tmp_path / "c.json")
    assert remote.sync() is True
    assert rc.takeover_sessions() == {"S:alice", "R:group-1"}


def test_takeover_sessions_ignore_dirty_values(tmp_path):
    # 脏值全部丢弃：非数组、非字符串元素、空白串。绝不能因为一个脏值把所有会话都停掉。
    remote_payload = payload(version="v-dirty", scripts=[])
    remote_payload["takeover_sessions"] = [1, None, "  ", "S:ok", {"id": "x"}]
    remote = rc.RemoteConfig(FakeClient([remote_payload]), cache_path=tmp_path / "c.json")
    assert remote.sync() is True
    assert rc.takeover_sessions() == {"S:ok"}

    not_a_list = payload(version="v-dirty2", scripts=[])
    not_a_list["takeover_sessions"] = "S:alice"
    remote2 = rc.RemoteConfig(FakeClient([not_a_list]), cache_path=tmp_path / "c2.json")
    assert remote2.sync() is True
    assert rc.takeover_sessions() == set()


def test_takeover_sessions_survive_cached_restart(tmp_path):
    cache = tmp_path / "config.remote.json"
    cache.write_text(
        json.dumps({"version": "v1", "interval_seconds": 20, "cooldown": 8, "scripts": [],
                    "takeover_sessions": ["S:alice"]}),
        encoding="utf-8",
    )
    # 重启且远端拉不到：仍按缓存里的接管名单工作，绝不擅自恢复自动回复
    remote = rc.RemoteConfig(FakeClient([None]), cache_path=cache)
    assert rc.takeover_sessions() == {"S:alice"}
    assert remote.sync({"interval": 20, "cooldown": 8}) is False
    assert rc.takeover_sessions() == {"S:alice"}


def test_takeover_removed_when_server_says_so(tmp_path):
    # 网页点「交还 AI」→ 名单里没有这个会话了 → 客户端恢复自动回复。
    # 整体替换而非增量合并，删除动作才表达得出来。
    cache = tmp_path / "config.remote.json"
    first = payload(version="v1", scripts=[])
    first["takeover_sessions"] = ["S:alice", "S:bob"]
    second = payload(version="v2", scripts=[])
    second["takeover_sessions"] = ["S:bob"]
    remote = rc.RemoteConfig(FakeClient([first, second]), cache_path=cache)
    remote.sync()
    assert rc.takeover_sessions() == {"S:alice", "S:bob"}
    remote.sync()
    assert rc.takeover_sessions() == {"S:bob"}
    assert json.loads(cache.read_text(encoding="utf-8"))["takeover_sessions"] == ["S:bob"]


def test_takeover_kept_when_server_omits_the_key(tmp_path):
    # 老服务端不下发这个键：不能理解成「没人被接管」而把已接管的会话放回自动回复。
    cache = tmp_path / "config.remote.json"
    first = payload(version="v1", scripts=[])
    first["takeover_sessions"] = ["S:alice"]
    second = payload(version="v2", scripts=[])
    remote = rc.RemoteConfig(FakeClient([first, second]), cache_path=cache)
    remote.sync()
    remote.sync()
    assert rc.takeover_sessions() == {"S:alice"}


# ── 已流失名单（步骤 3）：客户说「我不去了」后不再发任何消息 ──────────────────

def test_abandoned_sessions_come_from_remote(tmp_path):
    remote_payload = payload(version="v-abandon", scripts=[])
    remote_payload["abandoned_sessions"] = ["S:quit-1"]
    remote = rc.RemoteConfig(FakeClient([remote_payload]), cache_path=tmp_path / "c.json")
    assert remote.sync() is True
    assert rc.abandoned_sessions() == {"S:quit-1"}


def test_abandoned_and_takeover_are_independent(tmp_path):
    # 两者语义不同：接管可交还，流失要人工恢复。混成一个集合会让
    # 「交还 AI」把流失的人也放回自动回复。
    remote_payload = payload(version="v-pair", scripts=[])
    remote_payload["takeover_sessions"] = ["S:human"]
    remote_payload["abandoned_sessions"] = ["S:quit"]
    remote = rc.RemoteConfig(FakeClient([remote_payload]), cache_path=tmp_path / "c.json")
    remote.sync()
    assert rc.takeover_sessions() == {"S:human"}
    assert rc.abandoned_sessions() == {"S:quit"}


def test_abandoned_dirty_values_ignored(tmp_path):
    remote_payload = payload(version="v-dirty-abandon", scripts=[])
    remote_payload["abandoned_sessions"] = [None, 1, "  ", "S:ok"]
    remote = rc.RemoteConfig(FakeClient([remote_payload]), cache_path=tmp_path / "c.json")
    remote.sync()
    assert rc.abandoned_sessions() == {"S:ok"}


def test_abandoned_survives_cached_restart(tmp_path):
    cache = tmp_path / "config.remote.json"
    cache.write_text(
        json.dumps({"version": "v1", "interval_seconds": 20, "cooldown": 8, "scripts": [],
                    "abandoned_sessions": ["S:quit"]}),
        encoding="utf-8",
    )
    # 重启且远端拉不到：仍按缓存工作，绝不擅自恢复发送
    remote = rc.RemoteConfig(FakeClient([None]), cache_path=cache)
    assert rc.abandoned_sessions() == {"S:quit"}
    assert remote.sync({"interval": 20, "cooldown": 8}) is False
    assert rc.abandoned_sessions() == {"S:quit"}


def test_abandoned_cleared_when_server_removes_it(tmp_path):
    # 运营在网页上「恢复跟进」→ 名单里没人了 → 客户端恢复发送
    cache = tmp_path / "config.remote.json"
    first = payload(version="v1", scripts=[])
    first["abandoned_sessions"] = ["S:quit"]
    second = payload(version="v2", scripts=[])
    second["abandoned_sessions"] = []
    remote = rc.RemoteConfig(FakeClient([first, second]), cache_path=cache)
    remote.sync()
    assert rc.abandoned_sessions() == {"S:quit"}
    remote.sync()
    assert rc.abandoned_sessions() == set()

"""客户端自注册模块（agent/register.py）：机器码派生与配置回写。

只测纯逻辑，不发任何 HTTP——注册链路本身由 acceptance-smoke 覆盖。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

AGENT = Path(__file__).resolve().parents[2] / "agent"
if str(AGENT) not in sys.path:
    sys.path.insert(0, str(AGENT))

import register  # noqa: E402


def test_device_code_is_stable_for_the_same_machine():
    first = register.derive_device_code("machine-guid-1234")
    second = register.derive_device_code("machine-guid-1234")
    assert first == second
    assert first.startswith("pc-")
    assert len(first) == len("pc-") + register.MACHINE_HASH_LENGTH


def test_device_code_matches_the_server_side_pattern():
    import re

    code = register.derive_device_code("another-machine")
    # 服务端只接受 [a-z0-9][a-z0-9_-]{0,63}，小写十六进制前缀必须匹配。
    assert re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", code)


def test_different_machines_get_different_codes():
    assert register.derive_device_code("a") != register.derive_device_code("b")


def test_register_without_key_does_nothing():
    assert register.register("http://127.0.0.1:1", "", "pc-x") == {}


def test_register_requires_a_device_code():
    with pytest.raises(ValueError):
        register.register("http://127.0.0.1:1", "some-long-key-here", "")


def test_write_back_keeps_existing_fields(tmp_path: Path):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"server": "http://x:8090", "dry_run": False}), encoding="utf-8")

    register.write_back(cfg, {"device_token": "dt_abc", "device_code": "pc-1"})

    merged = json.loads(cfg.read_text(encoding="utf-8"))
    assert merged["server"] == "http://x:8090"
    assert merged["device_token"] == "dt_abc"
    assert merged["dry_run"] is False  # 已存在的显式值必须保留


def test_write_back_forces_dry_run_on_a_fresh_config(tmp_path: Path):
    cfg = tmp_path / "config.json"

    register.write_back(cfg, {"device_token": "dt_abc"})

    merged = json.loads(cfg.read_text(encoding="utf-8"))
    # 新机器第一次注册必须默认 dry_run，避免装上去就真发消息。
    assert merged["dry_run"] is True

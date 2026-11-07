from __future__ import annotations

import argparse
import json

import pytest

from tests.agent_loader import load_autopilot


def test_file_settings_are_not_overwritten_by_cli_defaults(tmp_path):
    autopilot = load_autopilot()
    path = tmp_path / "config.json"
    path.write_text(json.dumps({
        "dry_run": True, "target": "Audit", "cooldown": 60,
        "interval_seconds": 7, "reply_first": "Hello", "device_code": "test-device",
    }), encoding="utf-8")

    cfg = autopilot.load_config(argparse.Namespace(dry=False), path)

    assert cfg["dry_run"] is True
    assert cfg["target"] == "Audit"
    assert cfg["cooldown"] == 60
    assert cfg["interval"] == 7
    assert cfg["reply_first"] == "Hello"
    assert cfg["device_code"] == "test-device"


def test_explicit_cli_overrides_file_and_dry_always_disables_sending(tmp_path):
    autopilot = load_autopilot()
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"dry_run": False, "target": "File", "cooldown": 60}), encoding="utf-8")
    cfg = autopilot.load_config(argparse.Namespace(dry=True, target="CLI", cooldown=0), path)
    assert (cfg["dry_run"], cfg["target"], cfg["cooldown"]) == (True, "CLI", 0)
    bridge = autopilot.agent_client.BridgeClient("http://test", "token", "device")
    assert autopilot.pump_commands(None, cfg, bridge=bridge)["claimed"] == 0


@pytest.mark.parametrize("content", [
    "{", "[]", '{"dry_run":"false"}', '{"dry_run":null}',
    '{"cooldown":-1}', '{"interval":0}', '{"interval":true}',
    '{"cooldown":NaN}', '{"target":null}', '{"brain":[]}',
    '{"brain":{"mode":"kb"}}', '{"brain":{"mode":"kb","base_url":false}}',
    '{"brain":{"mode":"typo"}}',
])
def test_invalid_config_stops_main_before_initializing_sender(tmp_path, monkeypatch, content):
    autopilot = load_autopilot()
    (tmp_path / "config.json").write_text(content, encoding="utf-8")
    monkeypatch.setattr(autopilot, "ROOT", tmp_path)
    monkeypatch.setattr(autopilot.sys, "argv", ["autopilot.py", "--once"])
    assert autopilot.main() == 2
    autopilot.rlog.init.assert_not_called()
    autopilot.core_send.send.assert_not_called()


def test_main_keeps_file_dry_run_without_cli_flag(tmp_path, monkeypatch):
    autopilot = load_autopilot()
    (tmp_path / "config.json").write_text('{"dry_run":true,"target":"Audit"}', encoding="utf-8")
    monkeypatch.setattr(autopilot, "ROOT", tmp_path)
    monkeypatch.setattr(autopilot.sys, "argv", ["autopilot.py", "--once"])
    captured = []
    monkeypatch.setattr(autopilot, "bootstrap", lambda store, cfg: captured.append(cfg))
    monkeypatch.setattr(autopilot, "scan", lambda *args: 0)
    monkeypatch.setattr(autopilot, "drain", lambda store, cfg, **kw: {"dry": kw["dry"]})
    monkeypatch.setattr(autopilot, "pump_safely", lambda *args: None)
    monkeypatch.setattr(autopilot, "_make_reporter", lambda *args: None)
    monkeypatch.setattr(autopilot, "print_history", lambda *args: None)
    monkeypatch.setattr(autopilot, "detect_wecom_state", lambda: "online")
    autopilot.rlog.stats.return_value = {}
    assert autopilot.main() == 0
    assert captured[0]["dry_run"] is True
    assert captured[0]["target"] == "Audit"
    autopilot.core_send.send.assert_not_called()

"""Account-scoped bridge configuration and recipient-binding reports."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import pytest


def load_agent_module(name):
    path = Path(__file__).resolve().parents[2] / "agent" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"recipient_binding_test_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def remote_config():
    return load_agent_module("remote_config")


def row(cid="S:me_other", remark="JOB-A7C3", status="verified"):
    return {"conversation_id": cid, "remark": remark, "status": status}


def payload(account="me", rows=None):
    return {
        "version": "same",
        "recipient_bindings_account_id": account,
        "recipient_bindings": [] if rows is None else rows,
    }


def test_refreshes_binding_snapshot_even_if_config_version_is_unchanged(remote_config, tmp_path):
    rc = remote_config
    client = Mock()
    expected = row()
    client.fetch_config.side_effect = [
        payload(rows=[expected, row("S:other2_me", "JOB-A002", "awaiting")]),
        payload(rows=[row(status="needs_confirmation")]),
        {"version": "same"},
    ]
    config = rc.RemoteConfig(client, tmp_path / "cache.json")
    assert config.sync()
    assert rc.recipient_binding_account_active("me")
    assert not rc.recipient_binding_account_active("other")
    assert rc.recipient_bindings("other") == {}
    assert rc.recipient_bindings("me")["S:me_other"] == expected
    assert rc.recipient_bindings("me")["S:other2_me"]["status"] == "awaiting"
    rc.recipient_bindings("me")["S:me_other"]["remark"] = "changed"
    assert rc.recipient_bindings("me")["S:me_other"] == expected

    assert config.sync()
    assert rc.recipient_bindings("me") == {"S:me_other": row(status="needs_confirmation")}
    assert config.sync()
    assert not rc.recipient_binding_account_active("me")
    assert rc.recipient_bindings("me") == {}


def test_bindings_are_never_restored_or_written_to_disk(remote_config, tmp_path):
    rc = remote_config
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps(payload(rows=[row()])), encoding="utf-8")
    client = Mock()
    client.fetch_config.side_effect = [
        None,
        {**payload(rows=[row()]), "version": "current"},
        None,
        payload(account="second", rows=[row("S:second_again")]),
    ]
    config = rc.RemoteConfig(client, cache)
    assert not config.sync()
    assert not rc.recipient_binding_account_active("me")
    assert rc.recipient_bindings("me") == {}

    assert config.sync()
    assert rc.recipient_bindings("me") == {"S:me_other": row()}
    assert "recipient_bindings" not in json.loads(cache.read_text(encoding="utf-8"))
    assert not config.sync()
    assert rc.recipient_bindings("me") == {"S:me_other": row()}

    assert config.sync()
    assert not rc.recipient_binding_account_active("me")
    assert rc.recipient_binding_account_active("second")
    assert rc.recipient_bindings("second") == {"S:second_again": row("S:second_again")}


def test_malformed_bindings_cannot_create_a_recipient(remote_config, tmp_path):
    rc = remote_config
    proposed = [
        row("S:acc_owner"),
        row("S:team_other"),
        row("R:acc_team"),
        row("S:acc_other", status="pending"),
        row("S:acc_first", remark=None),
        row("S:acc_duplicate"),
        row("S:acc_duplicate", "JOB-BC12"),
        row("S:acc_acc"),
    ]
    client = Mock()
    client.fetch_config.side_effect = [
        payload(account="acc", rows=proposed),
        {"version": "same", "recipient_bindings_account_id": "acc", "recipient_bindings": {}},
    ]
    config = rc.RemoteConfig(client, tmp_path / "cache.json")
    assert config.sync()
    assert rc.recipient_bindings("acc") == {"S:acc_owner": row("S:acc_owner")}
    assert not rc.recipient_binding_account_active("acc_old")
    assert config.sync()
    assert not rc.recipient_binding_account_active("acc")
    assert rc.recipient_bindings("acc") == {}


def test_report_recipient_binding_uses_device_route_and_exact_body(monkeypatch):
    client = load_agent_module("client").BridgeClient("https://example.test", "bridge-token", "win/01")
    request = Mock(return_value={"ok": True})
    monkeypatch.setattr(client, "_request", request)
    result = client.report_recipient_binding("me", "S:me_other", "verified", "JOB-A7C3")
    assert result == {"ok": True}
    request.assert_called_once_with(
        "POST",
        "/api/v1/bridge/devices/win%2F01/recipient-binding",
        {
            "account_id": "me",
            "conversation_id": "S:me_other",
            "status": "verified",
            "remark": "JOB-A7C3",
        },
    )



def test_binding_snapshot_expires_when_the_bridge_cannot_refresh(remote_config, tmp_path, monkeypatch):
    rc = remote_config
    clock = Mock(return_value=100)
    monkeypatch.setattr(rc.time, "monotonic", clock)
    client = Mock()
    client.fetch_config.side_effect = [payload(rows=[row()]), None]
    config = rc.RemoteConfig(client, tmp_path / "cache.json")
    assert config.sync()
    assert rc.recipient_binding_account_active("me")
    clock.return_value = 191
    assert not config.sync()
    assert not rc.recipient_binding_account_active("me")
    assert rc.recipient_bindings("me") == {}

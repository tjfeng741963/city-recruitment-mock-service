"""Explicit desktop data selection without changing frozen Store behavior."""
from __future__ import annotations

import argparse
import json
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


@pytest.fixture
def entry(tmp_path, monkeypatch):
    agent = load_autopilot()
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    for name in ("bootstrap", "scan_added_contacts", "scan", "drain", "pump_safely", "print_history"):
        monkeypatch.setattr(agent, name, MagicMock())
    monkeypatch.setattr(agent, "_make_reporter", MagicMock(return_value=None))
    monkeypatch.setattr(agent, "detect_wecom_state", lambda: "online")
    agent.rlog.stats.return_value = {}
    agent.rlog.manual_receipt_counts.return_value = {}
    agent.rlog.retry_held.return_value = 0
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--once", "--dry"])
    return agent


def data_folder(tmp_path, name="Data"):
    folder = tmp_path / name
    folder.mkdir()
    for database in ("message.db", "session.db"):
        (folder / database).touch()
    return folder


def save_config(tmp_path, **values):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    return path


def test_reply_mode_is_synchronized_before_contact_observations_are_consumed(entry, monkeypatch):
    calls = []
    monkeypatch.setattr(entry, "_check_reply_mode", lambda *args: calls.append("mode") or True)
    monkeypatch.setattr(entry, "scan_added_contacts", lambda *args: calls.append("contacts") or 0)
    assert entry.main() == 0
    assert calls.index("mode") < calls.index("contacts")


@pytest.mark.parametrize("configured", [False, True])
def test_empty_or_missing_directory_preserves_default_discovery(entry, tmp_path, configured):
    if configured:
        save_config(tmp_path, data_dir="")
    assert entry.main() == 0
    entry.Store.assert_called_once_with()
    entry.core_send.send.assert_not_called()


def test_file_directory_is_passed_to_existing_store_parameter(entry, tmp_path):
    folder = data_folder(tmp_path)
    save_config(tmp_path, data_dir="  " + str(folder) + "  ", dry_run=True)
    assert entry.main() == 0
    entry.Store.assert_called_once_with(data_dir=folder)
    entry.bootstrap.assert_called_once()
    entry.core_send.send.assert_not_called()


def test_cli_directory_overrides_offline_file_directory(entry, tmp_path, monkeypatch):
    folder = data_folder(tmp_path)
    save_config(tmp_path, data_dir=str(tmp_path / "offline"))
    monkeypatch.setattr(entry.sys, "argv", ["autopilot.py", "--once", "--dry", "--data-dir", str(folder)])
    assert entry.main() == 0
    entry.Store.assert_called_once_with(data_dir=folder)


def test_explicit_empty_cli_directory_restores_default_selection(entry, tmp_path, monkeypatch):
    save_config(tmp_path, data_dir=str(tmp_path / "offline"))
    monkeypatch.setattr(entry.sys, "argv", ["autopilot.py", "--once", "--dry", "--data-dir", ""])
    assert entry.main() == 0
    entry.Store.assert_called_once_with()


@pytest.mark.parametrize("value", [None, True, 123, [], {}])
def test_invalid_directory_type_stops_before_store_or_journal(entry, tmp_path, value):
    save_config(tmp_path, data_dir=value)
    assert entry.main() == 2
    entry.rlog.init.assert_not_called()
    entry.Store.assert_not_called()
    entry.core_send.send.assert_not_called()


@pytest.mark.parametrize("kind", ["relative", "missing", "file", "no-message", "no-session", "directory-as-db"])
def test_invalid_explicit_location_never_falls_back_to_another_account(entry, tmp_path, kind):
    folder = data_folder(tmp_path)
    if kind == "relative":
        value = "relative/Data"
    elif kind == "missing":
        value = str(tmp_path / "missing")
    elif kind == "file":
        value = str(folder / "message.db")
    else:
        value = str(folder)
        missing = "session.db" if kind == "no-session" else "message.db"
        (folder / missing).unlink()
        if kind == "directory-as-db":
            (folder / missing).mkdir()
    save_config(tmp_path, data_dir=value)
    assert entry.main() == 2
    entry.Store.assert_not_called()
    entry.bootstrap.assert_not_called()
    entry.scan.assert_not_called()
    entry._make_reporter.assert_not_called()
    entry.core_send.send.assert_not_called()


@pytest.mark.parametrize("option", ["--list", "--retry-held", "--flush-receipts"])
def test_maintenance_cli_works_with_offline_directory_and_never_creates_store(entry, tmp_path, monkeypatch, option):
    save_config(tmp_path, data_dir=str(tmp_path / "offline"), dry_run=False)
    monkeypatch.setattr(entry.sys, "argv", ["autopilot.py", option])
    bridge = MagicMock()
    monkeypatch.setattr(entry, "_make_bridge", lambda *args: bridge)
    flush = MagicMock(return_value=True)
    monkeypatch.setattr(entry, "flush_manual_receipts", flush)
    assert entry.main() == 0
    entry.Store.assert_not_called()
    entry.bootstrap.assert_not_called()
    entry.scan.assert_not_called()
    entry.core_send.send.assert_not_called()
    if option == "--flush-receipts":
        flush.assert_called_once_with(bridge, force=True)
    else:
        flush.assert_not_called()


def test_config_loading_does_not_probe_an_offline_directory(tmp_path):
    agent = load_autopilot()
    path = save_config(tmp_path, data_dir=str(tmp_path / "offline"))
    cfg = agent.load_config(argparse.Namespace(dry=False), path)
    assert cfg["data_dir"] == str(tmp_path / "offline")

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "deploy/client"
AGENT = ROOT / "agent"
sys.path.insert(0, str(CLIENT))


def service_module():
    spec = importlib.util.spec_from_file_location(
        "client_manager_service_startup_state", CLIENT / "client_manager_service.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_status_exposes_startup_state_and_rejects_stale_ready(tmp_path, monkeypatch):
    module = service_module()
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "client-state.json").write_text(
        json.dumps({"status": "ready", "pid": 123, "detail": "可回复"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "system_snapshot", lambda: {"processes": [], "task_enabled": False})

    state = module.ManagerService(tmp_path).status()

    assert state["running"] == 0
    assert state["startup_status"] == "failed"
    assert "退出" in state["startup_detail"]


def test_status_does_not_reuse_ready_state_from_an_older_pid(tmp_path, monkeypatch):
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "client-state.json").write_text(
        json.dumps({"status": "ready", "pid": 111, "detail": "旧进程"}),
        encoding="utf-8",
    )
    module = service_module()
    monkeypatch.setattr(
        module,
        "system_snapshot",
        lambda: {
            "processes": [{
                "Name": "python.exe",
                "CommandLine": f'python.exe "{tmp_path / "autopilot.py"}" --watch',
                "ProcessId": 222,
                "CreationDate": "2026-11-21T00:00:00Z",
            }],
            "task_enabled": False,
        },
    )

    state = module.ManagerService(tmp_path).status()

    assert state["running"] == 1
    assert state["startup_status"] == "starting"


def test_start_waits_for_business_state_instead_of_pid(tmp_path, monkeypatch):
    module = service_module()
    service = module.ManagerService(tmp_path)
    for name in ("autopilot.py", "login_code.py", "pilot-hidden.vbs", "start-pilot.cmd", "config.json"):
        (tmp_path / name).write_bytes(b"# fixture\n")
    (tmp_path / "frozen-core-sha256.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(module.updater, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(module.updater, "_release_mutex", lambda handle: None)
    monkeypatch.setattr(module.updater, "_running_autopilot", lambda: False)
    monkeypatch.setattr(module, "require_interactive_session", lambda: None)
    monkeypatch.setattr(module.updater, "_verify_installed_core", lambda *args: None)
    monkeypatch.setattr(module.updater, "_start_existing_client", lambda root: None)
    statuses = iter([
        {"running": 1, "startup_status": "starting"},
        {"running": 1, "startup_status": "waiting_login"},
    ])
    calls = []
    def read_status():
        calls.append(True)
        return next(statuses)
    monkeypatch.setattr(service, "status", read_status)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)

    assert service.start() == 1
    assert len(calls) == 2


def test_autopilot_defers_database_refresh_until_after_login_probe():
    src = (AGENT / "autopilot.py").read_text(encoding="utf-8")
    assert "def write_client_state" in src
    assert "waiting_login" in src
    assert "waiting_wecom" in src
    assert "configured_data_dir(cfg, require_files=False)" in src
    assert src.index("qr_pusher = login_qr.LoginQrPusher()") < src.index("store.refresh()")


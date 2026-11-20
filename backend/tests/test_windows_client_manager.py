from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "deploy/client"
sys.path.insert(0, str(CLIENT))
import client_updater as updater


def service_module():
    spec = importlib.util.spec_from_file_location("client_manager_service", CLIENT / "client_manager_service.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COMMIT = "a" * 40
RELEASE = {"commit": COMMIT, "package_url": "package", "checksum_url": "checksum"}


@pytest.fixture(autouse=True)
def use_manager_updater_module(monkeypatch):
    monkeypatch.setitem(sys.modules, "client_updater", updater)


def test_check_release_reads_metadata_without_downloading_or_starting(monkeypatch):
    calls = []
    def request(url):
        calls.append(url)
        return {"sha": COMMIT} if url.endswith("commits/main") else {"fixture": True}
    monkeypatch.setattr(updater, "_request_json", request)
    monkeypatch.setattr(updater, "release_asset_urls", lambda sha, data: ("package", "checksum"))
    monkeypatch.setattr(updater, "_download", lambda *a: pytest.fail("check must not download"))
    monkeypatch.setattr(updater, "_start_existing_client", lambda *a: pytest.fail("check must not start"))
    assert updater.check_release() == RELEASE
    assert len(calls) == 2


@pytest.mark.parametrize(("name", "command", "expected"), [
    ("python.exe", r'C:\Python311\python.exe C:\agent\autopilot.py --watch', True),
    ("pythonw.exe", r'"C:\Program Files\Python311\pythonw.exe" "C:\agent\autopilot.py" --watch', True),
    ("python.exe", r'python.exe -u C:/AGENT/autopilot.py --watch', True),
    ("python.exe", r'python.exe C:\agent2\autopilot.py --watch', False),
    ("python.exe", r'python.exe C:\agent\client_manager.py', False),
    ("python.exe", r'python.exe -c "print(autopilot.py)"', False),
    ("python.exe", r'python.exe autopilot.py --watch', False),
    ("cmd.exe", r'cmd.exe /c C:\agent\autopilot.py', False),
])
def test_process_identity_requires_this_client_script(name, command, expected):
    module = service_module()
    assert module.is_client_process({"Name": name, "CommandLine": command}, Path("C:/agent")) is expected


def fixture_service(tmp_path, monkeypatch):
    module = service_module()
    service = module.ManagerService(tmp_path)
    events = []
    monkeypatch.setattr(updater, "_acquire_mutex", lambda: events.append("lock"))
    monkeypatch.setattr(updater, "_release_mutex", lambda handle: events.append("unlock"))
    monkeypatch.setattr(updater, "_running_autopilot", lambda: False)
    monkeypatch.setattr(updater, "check_release", lambda: RELEASE)
    monkeypatch.setattr(updater, "fetch_release_package", lambda release=None: (COMMIT, b"zip", "digest"))
    monkeypatch.setattr(updater, "apply_package", lambda *a, **kw: events.append("apply") or {"commit": COMMIT, "changed": ["autopilot.py"]})
    monkeypatch.setattr(updater, "_start_existing_client", lambda *a: pytest.fail("update must not start"))
    return module, service, events


def test_manual_update_installs_without_launching_client(tmp_path, monkeypatch):
    module, service, events = fixture_service(tmp_path, monkeypatch)
    stages = []
    result = service.update(COMMIT, progress=stages.append)
    assert result["commit"] == COMMIT
    assert events == ["lock", "apply", "unlock"]
    assert stages


def test_manual_update_rejects_version_changed_since_check(tmp_path, monkeypatch):
    module, service, events = fixture_service(tmp_path, monkeypatch)
    with pytest.raises(updater.UpdateError, match="版本"):
        service.update("b" * 40)
    assert "apply" not in events
    assert events[-1] == "unlock"


def test_manual_update_rechecks_sender_after_download(tmp_path, monkeypatch):
    module, service, events = fixture_service(tmp_path, monkeypatch)
    checks = iter([False, True])
    monkeypatch.setattr(updater, "_running_autopilot", lambda: next(checks))
    with pytest.raises(updater.UpdateError, match="运行"):
        service.update(COMMIT)
    assert "apply" not in events


def test_manual_update_network_failure_keeps_sources(tmp_path, monkeypatch):
    module, service, events = fixture_service(tmp_path, monkeypatch)
    (tmp_path / "autopilot.py").write_bytes(b"# old code")
    def fail(*a, **kw):
        raise updater.UpdateError("HTTPS download failed")
    monkeypatch.setattr(updater, "fetch_release_package", fail)
    with pytest.raises(updater.UpdateError):
        service.update(COMMIT)
    assert "apply" not in events
    assert (tmp_path / "autopilot.py").read_bytes() == b"# old code"


def test_status_does_not_start_or_check_network(tmp_path, monkeypatch):
    module = service_module()
    monkeypatch.setattr(module, "system_snapshot", lambda: {"processes": [], "task_enabled": False})
    monkeypatch.setattr(updater, "check_release", lambda: pytest.fail("status must be local"))
    assert module.ManagerService(tmp_path).status() == {"commit": None, "running": 0, "task_enabled": False, "other_running": 0}


def test_stop_only_targets_owned_processes_and_revalidates(tmp_path, monkeypatch):
    module = service_module()
    own = {"Name": "python.exe", "CommandLine": f'python.exe "{tmp_path / "autopilot.py"}" --watch', "ProcessId": 123, "CreationDate": "fixture-time"}
    foreign = {**own, "ProcessId": 456, "CommandLine": r"python.exe C:\other\autopilot.py"}
    states = iter([{"processes": [own, foreign]}, {"processes": [foreign]}])
    monkeypatch.setattr(module, "system_snapshot", lambda: next(states))
    calls = []
    monkeypatch.setattr(module, "terminate_verified_process", lambda row, root: calls.append((row, root)))
    monkeypatch.setattr(updater, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(updater, "_release_mutex", lambda handle: None)
    assert module.ManagerService(tmp_path).stop() == 1
    assert calls == [(own, tmp_path)]


def test_stop_revalidation_script_checks_creation_time_and_exact_command(monkeypatch):
    module = service_module()
    captured = []
    monkeypatch.setattr(module, "run_powershell", lambda script: captured.append(script) or {})
    row = {"Name": "python.exe", "CommandLine": r"python.exe C:\agent\autopilot.py --watch", "ProcessId": 123, "CreationDate": "fixture-time"}
    module.terminate_verified_process(row, Path("C:/agent"))
    assert "CreationDate" in captured[0]
    assert "CommandLine" in captured[0]
    assert "Stop-Process -Id" in captured[0]
    assert "-Name python" not in captured[0]


def test_start_rejects_running_sender_before_launch(tmp_path, monkeypatch):
    module = service_module()
    monkeypatch.setattr(updater, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(updater, "_release_mutex", lambda handle: None)
    monkeypatch.setattr(updater, "_running_autopilot", lambda: True)
    monkeypatch.setattr(updater, "_start_existing_client", lambda *a: pytest.fail("duplicate launch"))
    with pytest.raises(updater.UpdateError, match="运行"):
        module.ManagerService(tmp_path).start()


@pytest.mark.skipif(sys.platform != "win32", reason="Actual read-only Windows CIM integration")
def test_windows_system_snapshot_executes_real_powershell():
    module = service_module()
    state = module.system_snapshot()
    assert isinstance(state["processes"], list)
    assert state["task_enabled"] in (True, False, None)


@pytest.mark.skipif(sys.platform != "win32", reason="Exact Windows process termination in synthetic roots")
def test_windows_stop_revalidates_identity_and_preserves_foreign_process(tmp_path):
    module = service_module()
    roots = [tmp_path / "owned", tmp_path / "foreign"]
    children = []
    try:
        for root in roots:
            root.mkdir()
            script = root / "autopilot.py"
            script.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
            children.append(subprocess.Popen([getattr(sys, "_base_executable", sys.executable), str(script)], creationflags=subprocess.CREATE_NO_WINDOW))
        rows = module.system_snapshot()["processes"]
        own = next(row for row in rows if row["ProcessId"] == children[0].pid)
        with pytest.raises(updater.UpdateError):
            module.terminate_verified_process({**own, "CreationDate": "wrong creation time"}, roots[0])
        assert children[0].poll() is None
        assert module.ManagerService(roots[0]).stop() == 1
        assert children[0].poll() is not None
        assert children[1].poll() is None
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=10)

"""Isolation and cleanup guarantees for the standalone HTTP acceptance runner."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError

import pytest


@pytest.fixture
def smoke():
    source = Path(__file__).resolve().parents[2] / "scripts/acceptance-smoke.py"
    spec = importlib.util.spec_from_file_location("acceptance_smoke", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_services_replace_inherited_backend_configuration(smoke, monkeypatch, tmp_path):
    for name in ("APP_DATABASE_URL", "REA_DATABASE_PATH", "WECOM_SECRET", "UVICORN_ENV_FILE", "NODE_OPTIONS", "app_extra_config"):
        monkeypatch.setenv(name, "inherited-production-sentinel")
    monkeypatch.setattr(smoke.shutil, "which", lambda _: sys.executable)
    monkeypatch.setattr(smoke.subprocess, "check_output", lambda *args, **kwargs: str(tmp_path / "loader.mjs"))
    services = smoke.Services(tmp_path)
    assert "inherited-production-sentinel" not in services.env.values()
    assert services.env["APP_OUTBOX_WORKER"] == "false"
    assert services.env["APP_SYNC_WORKER"] == "false"
    assert services.env["APP_DATABASE_URL"].endswith((tmp_path / "python.sqlite").as_posix())
    assert services.env["ACCEPTANCE_RUN_DIR"] == str(tmp_path)


def test_cleanup_terminates_owned_service_process(smoke, monkeypatch, tmp_path):
    monkeypatch.setattr(smoke.shutil, "which", lambda _: sys.executable)
    monkeypatch.setattr(smoke.subprocess, "check_output", lambda *args, **kwargs: str(tmp_path / "loader.mjs"))
    services = smoke.Services(tmp_path)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    services.children["node"] = child
    try:
        services.close()
        assert child.poll() is not None
        assert not services.children
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)


def test_http_failure_never_includes_response_body_or_credentials(smoke, monkeypatch):
    def fail(*args, **kwargs):
        raise HTTPError("http://127.0.0.1:12345/test", 500, "Failure", {}, io.BytesIO(b"secret-response-sentinel"))

    monkeypatch.setattr(smoke.HTTP, "open", fail)
    with pytest.raises(RuntimeError) as error:
        smoke.request("http://127.0.0.1:12345", "/test", headers={"Authorization": "Bearer secret-header-sentinel"})
    assert "expected HTTP 200, got 500" in str(error.value)
    assert "sentinel" not in str(error.value)


def test_http_runner_rejects_remote_targets_before_connecting(smoke, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("HTTP must not be called")

    monkeypatch.setattr(smoke.HTTP, "open", forbidden)
    with pytest.raises(RuntimeError, match="Only loopback"):
        smoke.request("https://example.com", "/healthz")


def test_failed_scenario_still_cleans_runtime_and_writes_failure_report(smoke, monkeypatch, tmp_path):
    state = {}

    class FakeServices:
        def __init__(self, run_dir):
            state["directory"] = run_dir

        def close(self):
            state["closed"] = True

    def fail(services, checks):
        raise RuntimeError("Synthetic scenario failure")

    report = tmp_path / "result.json"
    monkeypatch.setattr(smoke, "Services", FakeServices)
    monkeypatch.setattr(smoke, "exercise", fail)
    monkeypatch.setattr(smoke.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(sys, "argv", ["acceptance-smoke.py", "--report", str(report)])
    assert smoke.main() == 1
    assert state["closed"] is True
    assert not state["directory"].exists()
    assert json.loads(report.read_text(encoding="utf-8"))["status"] == "failed"

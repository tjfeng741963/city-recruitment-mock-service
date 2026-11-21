"""Tk window contract with a fake local service; never starts a real sender."""

import importlib
from pathlib import Path
import sys
import time

import pytest


CLIENT = Path(__file__).resolve().parents[2] / "deploy/client"
sys.path.insert(0, str(CLIENT))
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Native Windows Tk window")
COMMIT = "a" * 40


class FixtureService:
    def __init__(self, root):
        self.root = root
        self.calls = []
        self.running = 0
        self.installed = None

    def status(self):
        self.calls.append("status")
        return {"commit": self.installed, "running": self.running, "task_enabled": False, "other_running": 0}

    def watch_status(self, previous):
        return self.status()

    def restart(self):
        self.calls.append("restart")
        return 1

    def check(self):
        self.calls.append("check")
        return {"commit": COMMIT}

    def update(self, commit, progress):
        self.calls.append(("update", commit))
        progress("fixture installation")
        self.installed = commit
        return {"commit": commit, "changed": ["autopilot.py"]}

    def start(self):
        self.calls.append("start")
        self.running = 1
        return 1

    def stop(self):
        self.calls.append("stop")
        self.running = 0
        return 1


@pytest.fixture(scope="module")
def tk_root():
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    yield root
    root.destroy()


@pytest.fixture
def window(tmp_path, tk_root):
    import tkinter as tk
    module = importlib.import_module("client_manager")
    window = tk.Toplevel(tk_root)
    window.withdraw()
    service = FixtureService(tmp_path)
    app = module.ManagerWindow(window, service)
    yield app, service
    app.close()


def settle(app):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        app.window.update()
        if not app.busy:
            return
        time.sleep(0.01)
    pytest.fail("GUI worker did not settle")


def test_opening_window_only_reads_local_status(window):
    app, service = window
    settle(app)
    assert set(service.calls) == {"status"}
    assert app.install_button.instate(["disabled"])
    assert "停止" in app.runtime_text.get()


def test_running_window_detects_exit_without_manual_refresh(window):
    app, service = window
    service.running = 1
    settle(app)
    service.running = 0
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        app.window.update()
        if "停止" in app.runtime_text.get():
            assert not app.busy
            assert not app.start_button.instate(["disabled"])
            return
        time.sleep(0.01)
    pytest.fail("GUI kept an exited process on screen")


def test_check_and_install_never_start_sender(window):
    app, service = window
    settle(app)
    app.check_button.invoke()
    assert app.busy
    assert app.check_button.instate(["disabled"])
    settle(app)
    assert app.latest_text.get() == COMMIT
    assert not app.install_button.instate(["disabled"])
    app.install_button.invoke()
    settle(app)
    assert ("update", COMMIT) in service.calls
    assert "start" not in service.calls
    assert app.current_text.get() == COMMIT
    assert "未启动" in app.message_text.get()


def test_matching_current_and_latest_versions_disable_update(window):
    app, service = window
    service.installed = COMMIT
    settle(app)
    app.check_button.invoke()
    settle(app)
    assert app.current_text.get() == COMMIT
    assert app.latest_text.get() == COMMIT
    assert app.install_button.instate(["disabled"])
    assert app.install_button.cget("text") == "已是最新版本"
    assert "已是该发布版本" in app.message_text.get()
    app.install_button.invoke()
    assert not any(isinstance(call, tuple) and call[0] == "update" for call in service.calls)


def test_network_failure_is_visible_without_changing_current_version(window):
    app, service = window
    settle(app)
    before = app.current_text.get()
    def fail():
        raise OSError("fixture offline")
    service.check = fail
    app.check_button.invoke()
    settle(app)
    assert app.current_text.get() == before
    assert "失败" in app.message_text.get()
    assert app.install_button.instate(["disabled"])
    assert "start" not in service.calls


def test_start_requires_confirmation_and_running_client_blocks_install(window, monkeypatch):
    app, service = window
    settle(app)
    module = importlib.import_module("client_manager")
    monkeypatch.setattr(module.messagebox, "askyesno", lambda *a, **kw: False)
    app.start_button.invoke()
    assert "start" not in service.calls
    monkeypatch.setattr(module.messagebox, "askyesno", lambda *a, **kw: True)
    app.start_button.invoke()
    settle(app)
    assert "start" in service.calls
    app.check_button.invoke()
    settle(app)
    assert app.install_button.instate(["disabled"])
    assert not app.stop_button.instate(["disabled"])

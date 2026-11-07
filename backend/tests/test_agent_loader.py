import ctypes
import sys

import pytest

from tests import agent_loader


def test_agent_tests_work_without_windows_ctypes_and_restore_import_state(monkeypatch):
    monkeypatch.delattr(ctypes, "WinDLL", raising=False)
    before_modules = dict(sys.modules)
    before_path = list(sys.path)
    module = agent_loader.load_autopilot()
    assert callable(module.pump_commands)
    assert callable(module.Reporter)
    assert not hasattr(ctypes, "WinDLL")
    assert sys.path == before_path
    for name in ("autopilot", "client", "compat", "reply_store", "login_watch", "wecom_io_core"):
        assert sys.modules.get(name) is before_modules.get(name)


def test_failed_import_does_not_cache_partial_agent(monkeypatch):
    original = agent_loader._load_module
    before = dict(sys.modules)

    def fail(name):
        if name == "autopilot":
            sys.modules[name] = object()
            raise RuntimeError("simulated import failure")
        return original(name)

    monkeypatch.setattr(agent_loader, "_load_module", fail)
    with pytest.raises(RuntimeError, match="simulated import failure"):
        agent_loader.load_autopilot()
    for name in ("autopilot", "client", "wecom_io_core"):
        assert sys.modules.get(name) is before.get(name)

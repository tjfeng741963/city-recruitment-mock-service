"""Load agent orchestration with all desktop input APIs isolated."""

from __future__ import annotations

import ctypes
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

AGENT_DIR = Path(__file__).resolve().parents[2] / "agent"


def _load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, AGENT_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_autopilot():
    stubs = {
        name: MagicMock()
        for name in (
            "wecom_io_core", "wecom_io_core.win", "wecom_io_core.send",
            "wecom_io_core.store", "compat", "reply_store", "login_watch",
        )
    }
    # send 的媒体函数给真实签名：MagicMock 迭代默认是空的，直接解包会炸
    stubs["wecom_io_core.send"].split_media_marks = MagicMock(
        side_effect=lambda text: (text or "", [])
    )
    stubs["wecom_io_core.send"].paste_media = MagicMock(return_value=(True, "stub"))
    with (
        patch.dict(sys.modules, stubs),
        patch.object(sys, "path", list(sys.path)),
        patch.object(ctypes, "WinDLL", MagicMock(), create=True),
    ):
        _load_module("client")
        return _load_module("autopilot")


def load_reply_store(path: Path):
    with patch.dict(sys.modules):
        module = _load_module("reply_store")
    module.DB_PATH = path
    module.init()
    return module

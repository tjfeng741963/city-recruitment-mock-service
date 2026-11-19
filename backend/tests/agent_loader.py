"""Load agent orchestration with all desktop input APIs isolated."""

from __future__ import annotations

import ctypes
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

AGENT_DIR = Path(__file__).resolve().parents[2] / "agent"

# brain.py 与 autopilot 同目录，build_brain 里 `import brain` 需要 agent 目录
# 在 sys.path 上；worker 子进程里 main() 也会走到，所以这里永久插入不恢复。
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


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
            "login_code",
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
        # brain.py 与 autopilot 同目录（agent/），build_brain 里 `import brain`
        # 需要 agent 目录在 sys.path 上。
        sys.path.insert(0, str(AGENT_DIR))
        _load_module("client")
        module = _load_module("autopilot")
        # Hosted Windows CI is not an interactive client desktop. Every test
        # controls the read-only probe explicitly; never query its real session.
        module.desktop_send_ready = MagicMock(return_value=(True, ''))
        return module


def load_reply_store(path: Path):
    with patch.dict(sys.modules):
        module = _load_module("reply_store")
    module.DB_PATH = path
    module.init()
    return module

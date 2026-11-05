"""掉登录提醒：去抖 + 找不到窗口也要吼一声。

agent/login_watch.py 会真的去调 user32 / winsound，这里全部打桩：
窗口发现与置前都换成普通函数，声音换成记录器，时钟换成可推进的假时钟，
所以整套用例在 CI / Linux 上跑也不会碰真实窗口。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[2] / "agent"


def _load_login_watch():
    name = "login_watch"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, AGENT_DIR / "login_watch.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def lw():
    """每个用例一份干净的模块状态 + 一堆桩。"""
    mod = _load_login_watch()
    mod.reset()

    clock = {"now": 1_000.0}
    mod._now = lambda: clock["now"]
    mod._find_window = lambda: 0x1234
    mod._bring_to_front = lambda hwnd: True
    mod._beep = lambda: True
    mod._clock = clock
    yield mod
    mod.reset()


# ─────────────────────── 首次进入 ───────────────────────
def test_first_login_required_alerts(lw) -> None:
    lines: list[str] = []

    assert lw.alert_login_required("login_required", log=lines.append) is True
    assert len(lines) == 1
    assert lines[0].startswith("[注意]")
    assert "扫码" in lines[0]


# ─────────────────────── 冷却 ───────────────────────
def test_second_call_within_cooldown_is_silent(lw) -> None:
    lines: list[str] = []
    assert lw.alert_login_required("login_required", log=lines.append) is True

    lw._clock["now"] += 30.0
    assert lw.alert_login_required("login_required", log=lines.append) is False

    assert len(lines) == 1


def test_alerts_again_after_cooldown(lw) -> None:
    lines: list[str] = []
    assert lw.alert_login_required("login_required", log=lines.append) is True

    lw._clock["now"] += lw.COOLDOWN + 1
    assert lw.alert_login_required("login_required", log=lines.append) is True

    assert len(lines) == 2


# ─────────────────────── 恢复正常后重置 ───────────────────────
def test_online_resets_so_next_drop_alerts_again(lw) -> None:
    lines: list[str] = []
    assert lw.alert_login_required("login_required", log=lines.append) is True

    lw._clock["now"] += 10.0
    assert lw.alert_login_required("online", log=lines.append) is False
    assert len(lines) == 1

    # 冷却没到，但用户刚重新扫过码，第二次掉登录必须立刻提醒
    lw._clock["now"] += 10.0
    assert lw.alert_login_required("login_required", log=lines.append) is True
    assert len(lines) == 2


# ─────────────────────── 不是扫码场景 ───────────────────────
@pytest.mark.parametrize("state", ["hidden", "not_running", "online"])
def test_other_states_never_alert(lw, state: str) -> None:
    lines: list[str] = []
    assert lw.alert_login_required(state, log=lines.append) is False
    lw._clock["now"] += lw.COOLDOWN + 1
    assert lw.alert_login_required(state, log=lines.append) is False
    assert lines == []


# ─────────────────────── 找不到窗口 ───────────────────────
def test_window_not_found_still_alerts_but_returns_false(lw) -> None:
    lines: list[str] = []
    beeps: list[int] = []
    lw._find_window = lambda: 0
    lw._bring_to_front = lambda hwnd: pytest.fail("窗口没找到就不该去置前")
    lw._beep = lambda: beeps.append(1) or True

    assert lw.alert_login_required("login_required", log=lines.append) is False
    assert len(lines) == 1 and lines[0].startswith("[注意]")
    assert beeps == [1]


# ─────────────────────── 异常不外泄 ───────────────────────
def test_window_api_exceptions_are_swallowed(lw) -> None:
    lines: list[str] = []

    def boom():
        raise OSError("拒绝访问")

    lw._find_window = boom

    assert lw.alert_login_required("login_required", log=lines.append) is False
    assert len(lines) == 1

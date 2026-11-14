"""后台发送路径：不抢前台、可最小化/隐藏（2026-11-13 客户需求）。

锁死的契约：
1. 后台路径**绝不调用** SetForegroundWindow / ShowWindow / BringWindowToTop
2. 最小化或隐藏的窗口也要能被找到（find_any_window 不筛可见性）
3. 多段回复逐段发送
4. 人类化节奏：间隔随机，不是固定机器节奏
5. 输入框位置用相对比例，不用绝对像素

用 mock 隔离所有 user32 调用，测试不碰真实桌面。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

AGENT_DIR = Path(__file__).resolve().parents[2] / "agent"
SOURCE = AGENT_DIR / "background_send.py"

# 被测模块在模块级就调用 ctypes.WinDLL / ctypes.WINFUNCTYPE，这两个符号只在
# Windows 的 ctypes 里存在。ubuntu 的 CI 跑单测时连 import 都过不去，
# 而这套契约本身描述的是 win32 窗口行为，非 Windows 上无从验证。
pytestmark = pytest.mark.skipif(
    sys.platform != "win32", reason="background_send 是 win32 模块，非 Windows 平台无法加载"
)


def _load_background_send():
    """加载 background_send，把 user32/gdi32 换成 mock。"""
    assert SOURCE.is_file(), "background_send.py 不存在"

    fake_user32 = MagicMock()
    fake_gdi32 = MagicMock()

    def fake_windll(name: str, **kwargs):
        del kwargs
        return fake_user32 if "user32" in name else fake_gdi32

    module_name = "background_send_under_test"
    with patch.dict(sys.modules):
        import importlib.util

        spec = importlib.util.spec_from_file_location(module_name, SOURCE)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        with patch("ctypes.WinDLL", side_effect=fake_windll):
            spec.loader.exec_module(module)
    return module, fake_user32


# ── 1. 绝不抢前台（本模块存在的全部理由）─────────────────────────
def _code_only() -> str:
    """去掉注释与字符串，只留可执行代码，避免误判文档里的禁止词。"""
    import io
    import tokenize

    source = SOURCE.read_text(encoding="utf-8")
    keep: list[str] = []
    skip_types = {
        tokenize.COMMENT,
        tokenize.STRING,
        tokenize.FSTRING_START,
        tokenize.FSTRING_MIDDLE,
        tokenize.FSTRING_END,
    } if hasattr(tokenize, "FSTRING_START") else {tokenize.COMMENT, tokenize.STRING}

    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type in skip_types:
            continue
        keep.append(tok.string)
    return "\n".join(keep)


def test_background_send_never_touches_window_state():
    code = _code_only()
    for forbidden in (
        "SetForegroundWindow",
        "BringWindowToTop",
        "ShowWindow",
        "SetCursorPos",
        "keybd_event",
        "SendInput",
        "mouse_event",
    ):
        assert forbidden not in code, f"后台路径不许出现 {forbidden}"


def test_find_any_window_does_not_filter_visibility():
    """客户要的「缩到角标」：最小化/隐藏的窗口也必须能找到。"""
    import ast

    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    func = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "find_any_window"
    )
    # 取函数体里出现的所有属性名（不含 docstring）
    used: set[str] = set()
    for node in ast.walk(func):
        if isinstance(node, ast.Attribute):
            used.add(node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value != ast.get_docstring(func):
            used.add(node.value)
    assert "IsWindowVisible" not in used, "find_any_window 不应筛可见性"
    assert "IsIconic" not in used, "find_any_window 不应筛最小化"


# ── 2. 分段 ─────────────────────────────────────────────────────
def test_split_parts_splits_on_blank_line():
    module, _ = _load_background_send()
    parts = module.split_parts("第一段\n\n第二段\n\n第三段")
    assert parts == ["第一段", "第二段", "第三段"]


def test_split_parts_single_block():
    module, _ = _load_background_send()
    assert module.split_parts("只有一段") == ["只有一段"]
    assert module.split_parts("") == []


# ── 3. 发送行为 ─────────────────────────────────────────────────
def test_send_returns_false_when_no_window():
    module, user32 = _load_background_send()
    user32.EnumWindows.side_effect = lambda cb, lp: None  # 枚举不到任何窗口
    result = module.send("测试")
    assert result["ok"] is False
    assert "没找到" in result["detail"]
    assert result["parts_sent"] == 0


def test_send_rejects_empty_text():
    module, user32 = _load_background_send()
    result = module.send("   ")
    assert result["ok"] is False
    assert result["parts_sent"] == 0
    user32.PostMessageW.assert_not_called()


def test_dry_run_reports_without_posting():
    module, user32 = _load_background_send()

    # 伪造一个窗口，让流程走到 dry 分支。
    # 注意 EnumWindows 的回调签名要求 lParam 是整数，不能传 None。
    def fake_enum(cb, param):
        cb(0x1234, 0)
        return 1

    user32.EnumWindows.side_effect = fake_enum
    user32.GetClassNameW.side_effect = _fake_class_name("WeWorkWindow")
    user32.GetWindowRect.side_effect = _fake_window_rect(1280, 761)

    result = module.send("测试内容", dry=True)
    assert result["ok"] is True
    assert "DRY-RUN" in result["detail"]
    assert result["parts_sent"] == 0
    user32.PostMessageW.assert_not_called()


# ── 4. 人类化节奏 ───────────────────────────────────────────────
def test_human_pacing_ranges_are_valid():
    module, _ = _load_background_send()
    lo, hi = module.CHAR_DELAY_RANGE
    assert 0 < lo < hi
    lo2, hi2 = module.SEGMENT_PAUSE_RANGE
    assert 0 < lo2 < hi2


def test_input_ratios_are_relative_not_pixels():
    module, _ = _load_background_send()
    assert module.INPUT_RATIO_CANDIDATES, "至少要有候选点"
    for rx, ry in module.INPUT_RATIO_CANDIDATES:
        assert 0.0 < rx < 1.0 and 0.0 < ry < 1.0


# ── 5. 灰度开关默认关闭 ─────────────────────────────────────────
def test_background_send_defaults_to_off():
    """未验证的路径不许默认接管发送，否则一上线就顶掉前台路径。

    见 docs/可行性分析-后台静默自动回复-20261113.md：L1 阶段必须单机灰度。
    """
    source = (AGENT_DIR / "autopilot.py").read_text(encoding="utf-8")
    assert 'cfg.get("background_send", False)' in source, (
        "开关默认值必须是 False；改成 True 等于未验证就全量上线"
    )
    assert 'cfg.get("background_send", True)' not in source


def test_config_example_documents_the_switch():
    example = (AGENT_DIR / "config.example.json").read_text(encoding="utf-8")
    assert '"background_send"' in example
    assert '"background_send": false' in example



# ── helpers ─────────────────────────────────────────────────────
def _fake_class_name(name: str):
    def fill(hwnd, buf, size):
        del hwnd, size
        # buffer 是 ctypes 的 unicode buffer，直接塞进去再读 value
        try:
            buf.value = name
        except AttributeError:
            pass
        return len(name)

    return fill


def _fake_window_rect(w: int, h: int):
    import ctypes

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long), ("top", ctypes.c_long),
            ("right", ctypes.c_long), ("bottom", ctypes.c_long),
        ]

    def fill(hwnd, ptr):
        del hwnd
        rect = ctypes.cast(ptr, ctypes.POINTER(RECT)).contents
        rect.left, rect.top = 0, 0
        rect.right, rect.bottom = w, h
        return 1

    return fill

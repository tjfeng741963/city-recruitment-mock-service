"""后台发送：不抢前台、可最小化/隐藏，直接把消息投进企业微信。

为什么单独一个模块
------------------
`wecom_io_core/send.py` 走全局键盘（`keybd_event`），每步都要
`ensure_foreground()` 抢前台，窗口被最小化/隐藏时还会主动 `SW_RESTORE`。
2026-11-13 客户要的正好相反：人在用别的软件时不许抢焦点，企微可以缩进托盘。

**本模块一行窗口操作都不做**：不调用 SetForegroundWindow / ShowWindow /
BringWindowToTop，只用 PostMessage 往目标窗口投消息。

实测依据（2026-11-13，企微 5.0.13.6005）
-----------------------------------------
- UIA 控件树为空、无子 HWND、不支持 TextPattern
  → uiautomation / pywinauto / SetWindowText 全部不可用
- 最小化窗口与隐藏窗口都能收到 PostMessage（自建窗口验证）
- 企微是 Duilib 自绘，点击与按键由自己的消息循环按坐标/内部焦点分发

因此这里的做法只能是「投递 + 回读校验」，不能「查找控件再设值」。

失败时的行为
------------
任何一步不确定就返回失败，由调用方决定是否退回前台路径。
**绝不假装成功**：发没发出去必须靠回读本地库确认（沿用 send.py 的做法）。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import random
import time
from collections.abc import Callable

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_CHAR = 0x0102
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
MK_LBUTTON = 0x0001
VK_RETURN = 0x0D

# 输入框在客户区里的候选比例（窗口相对，不写死像素，避免分辨率/DPI 影响）。
# 顺序按命中率排，多个候选点都点一遍，提高一次命中的概率。
INPUT_RATIO_CANDIDATES: tuple[tuple[float, float], ...] = (
    (0.45, 0.86),
    (0.52, 0.88),
    (0.45, 0.82),
)

# 人类化节奏：单字间隔与整段间隔都随机，避免固定的机器节奏
CHAR_DELAY_RANGE = (0.03, 0.09)
SEGMENT_PAUSE_RANGE = (0.6, 1.6)


def _log_quiet(msg: str) -> None:
    print(msg, flush=True)


def _jitter(span: tuple[float, float]) -> float:
    return random.uniform(*span)


def find_visible_window() -> int:
    """找可见且未最小化的 WeWorkWindow（给「窗口在屏幕上」的场景用）。

    为什么不跟 `wecom_io_core.win.find_window()` 一样按面积取最大：
    实测 5.0.13 有 4 个 WeWorkWindow（1 可见 + 3 隐藏，尺寸不同），
    按面积会在窗口尺寸变化时选错。这里优先可见、其次未最小化、最后面积。
    """
    found: list[tuple[int, int, int]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        if buf.value != "WeWorkWindow":
            return True
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w > 400 and h > 300:
            visible = 1 if user32.IsWindowVisible(hwnd) else 0
            restored = 0 if user32.IsIconic(hwnd) else 1
            found.append((visible * 2 + restored, w * h, hwnd))
        return True

    user32.EnumWindows(_cb, None)
    return max(found)[2] if found else 0


def find_any_window() -> int:
    """找任意 WeWorkWindow（含最小化/隐藏）。

    最小化后 `IsWindowVisible` 通常仍为 True，完全隐藏时为 False。
    客户要的「缩到角标」两种都要能发，所以这里**不筛可见性**。
    """
    found: list[tuple[int, int]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        if buf.value != "WeWorkWindow":
            return True
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w > 400 and h > 300:
            found.append((w * h, hwnd))
        return True

    user32.EnumWindows(_cb, None)
    return max(found)[1] if found else 0


def client_size(hwnd: int) -> tuple[int, int]:
    rect = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    return rect.right - rect.left, rect.bottom - rect.top


def window_to_client(hwnd: int) -> tuple[int, int]:
    """窗口坐标 → 客户区坐标的偏移量（标题栏 + 边框）。"""
    wrect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(wrect))
    point = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(point))
    return point.x - wrect.left, point.y - wrect.top


def post_click(hwnd: int, cx: int, cy: int) -> None:
    """向客户区坐标投一次左键点击。不移动真实鼠标、不激活窗口。"""
    lp = ((cy & 0xFFFF) << 16) | (cx & 0xFFFF)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.04)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)


def focus_input(hwnd: int) -> tuple[bool, str]:
    """把 Duilib 的内部焦点点到输入框上。返回 (ok, detail)。

    这只改变**企微内部**的焦点，不改变 Windows 的前台窗口，
    所以人正在别的软件里打字不会被打断。
    """
    cw, ch = client_size(hwnd)
    if cw <= 0 or ch <= 0:
        return False, "客户区尺寸为 0"
    for rx, ry in INPUT_RATIO_CANDIDATES:
        post_click(hwnd, int(cw * rx), int(ch * ry))
        time.sleep(0.15)
    return True, f"已点击 {len(INPUT_RATIO_CANDIDATES)} 个候选输入框位置"


def post_char(hwnd: int, ch: str) -> None:
    user32.PostMessageW(hwnd, WM_CHAR, ord(ch), 1)


def post_enter(hwnd: int) -> None:
    user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 1)
    time.sleep(0.05)
    user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 1)


def type_text(hwnd: int, text: str) -> None:
    """逐字投递。中文按 UTF-16 码元投（Python str 一个字符一个 WM_CHAR）。"""
    for ch in text:
        post_char(hwnd, ch)
        time.sleep(_jitter(CHAR_DELAY_RANGE))


def split_parts(text: str) -> list[str]:
    """把回复按空行拆段，逐段发送（模拟真人打一段发一段）。"""
    chunks = [part.strip() for part in (text or "").split("\n\n")]
    return [chunk for chunk in chunks if chunk] or ([text.strip()] if text.strip() else [])


def send(
    text: str,
    *,
    log: Callable[[str], None] = _log_quiet,
    dry: bool = False,
    pause: Callable[[float], None] | None = None,
) -> dict:
    """后台发送一段文本。返回 {ok, detail, parts_sent}。

    **不负责**：切换会话、确认发到哪个会话、回读校验。
    那些由调用方（autopilot）用现有的 store 回读机制完成——
    本模块只回答「字有没有投进去」。

    这样切分的原因：后台路径里切换会话同样依赖内部焦点，风险更高；
    先只验证「当前会话内能不能把字发出去」，通过后再谈切会话。
    """
    sleeper = pause or time.sleep
    body = (text or "").strip()
    if not body:
        return {"ok": False, "detail": "内容为空", "parts_sent": 0}

    hwnd = find_any_window()
    if not hwnd:
        return {"ok": False, "detail": "没找到企业微信窗口", "parts_sent": 0}

    if dry:
        return {
            "ok": True,
            "detail": f"DRY-RUN：会向 0x{hwnd:X} 投递 {len(body)} 个字符，未实际发送",
            "parts_sent": 0,
        }

    ok, focus_detail = focus_input(hwnd)
    if not ok:
        return {"ok": False, "detail": focus_detail, "parts_sent": 0}
    log(f"[后台] {focus_detail}")

    parts = split_parts(body)
    sent = 0
    for index, part in enumerate(parts):
        type_text(hwnd, part)
        sleeper(_jitter(SEGMENT_PAUSE_RANGE))
        post_enter(hwnd)
        sent += 1
        log(f"[后台] 第 {index + 1}/{len(parts)} 段已回车（{len(part)} 字）")
        if index < len(parts) - 1:
            sleeper(_jitter(SEGMENT_PAUSE_RANGE))

    return {
        "ok": True,
        "detail": f"已投递 {sent} 段到 0x{hwnd:X}（未回读，需调用方确认）",
        "parts_sent": sent,
    }


__all__ = [
    "send",
    "split_parts",
    "find_any_window",
    "find_visible_window",
    "post_click",
    "type_text",
    "post_enter",
    "INPUT_RATIO_CANDIDATES",
]

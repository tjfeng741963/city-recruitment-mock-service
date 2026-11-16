"""键鼠发送：激活企微窗口 → 搜索会话 → 粘贴文本 → 回车。

为什么用键鼠而不是接口：这套方案通篇不调企微 API，发送只能模拟真实操作。

注意（都是实测踩过的）：
- 必须是**交互式桌面会话**：锁屏、RDP 断开、窗口最小化都会失败
- 必须先 Ctrl+F 搜到目标会话再输入，否则会发到上一个打开的会话
- 粘贴用剪贴板，避免逐字符输入导致的输入法干扰
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes as wt

# pythonw 拉起时没有控制台，tasklist 会自己新建一个黑窗口；见 autopilot.py 的说明。
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# 64 位下必须显式声明，否则句柄会被截断成 32 位，SetClipboardData 直接访问违例
kernel32.GlobalAlloc.restype = wt.HGLOBAL
kernel32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
kernel32.GlobalLock.restype = wt.LPVOID
kernel32.GlobalLock.argtypes = [wt.HGLOBAL]
kernel32.GlobalUnlock.argtypes = [wt.HGLOBAL]
kernel32.GlobalUnlock.restype = wt.BOOL
user32.OpenClipboard.argtypes = [wt.HWND]
user32.OpenClipboard.restype = wt.BOOL
user32.SetClipboardData.restype = wt.HANDLE
user32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
user32.EmptyClipboard.restype = wt.BOOL

VK_CONTROL = 0x11
VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
VK_F = 0x46
KEYEVENTF_KEYUP = 0x0002
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


# ── SendInput ────────────────────────────────────────────────────────────────
# 关键：INPUT 的 union 必须包含 MOUSEINPUT 才能让 sizeof 等于 40（64 位）。
# 只声明 KEYBDINPUT 会让 sizeof 变成 32，SendInput 直接返回 0 + ERROR_INVALID_PARAMETER(87)。
class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.c_void_p)]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]

    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _U)]


def _send_input(*inputs: "_INPUT") -> None:
    n = len(inputs)
    arr = (_INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(_INPUT))
    if sent != n:
        raise RuntimeError(f"SendInput 失败：{sent}/{n}，err={ctypes.get_last_error()}")


def _key(vk: int, up: bool = False) -> None:
    inp = _INPUT()
    inp.type = 1  # INPUT_KEYBOARD
    inp.ki = _KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP if up else 0,
                         time=0, dwExtraInfo=None)
    _send_input(inp)


def _tap(vk: int) -> None:
    down = _INPUT(); down.type = 1
    down.ki = _KEYBDINPUT(wVk=vk, wScan=0, dwFlags=0, time=0, dwExtraInfo=None)
    up = _INPUT(); up.type = 1
    up.ki = _KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0, dwExtraInfo=None)
    _send_input(down, up)
    time.sleep(0.05)


def _combo(modifier: int, key: int) -> None:
    m_down = _INPUT(); m_down.type = 1
    m_down.ki = _KEYBDINPUT(wVk=modifier, wScan=0, dwFlags=0, time=0, dwExtraInfo=None)
    k_down = _INPUT(); k_down.type = 1
    k_down.ki = _KEYBDINPUT(wVk=key, wScan=0, dwFlags=0, time=0, dwExtraInfo=None)
    k_up = _INPUT(); k_up.type = 1
    k_up.ki = _KEYBDINPUT(wVk=key, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0, dwExtraInfo=None)
    m_up = _INPUT(); m_up.type = 1
    m_up.ki = _KEYBDINPUT(wVk=modifier, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0, dwExtraInfo=None)
    _send_input(m_down, k_down)
    time.sleep(0.05)
    _send_input(k_up, m_up)
    time.sleep(0.05)


def type_unicode(text: str) -> None:
    """按字符码直接注入文本，不依赖输入法、不占剪贴板。"""
    items = []
    for ch in text:
        code = ord(ch)
        down = _INPUT(); down.type = 1
        down.ki = _KEYBDINPUT(wVk=0, wScan=code, dwFlags=0x0004, time=0, dwExtraInfo=None)
        up = _INPUT(); up.type = 1
        up.ki = _KEYBDINPUT(wVk=0, wScan=code, dwFlags=0x0004 | KEYEVENTF_KEYUP,
                            time=0, dwExtraInfo=None)
        items.extend([down, up])
    if items:
        _send_input(*items)


def set_clipboard(text: str) -> None:

    user32.OpenClipboard(None)
    try:
        user32.EmptyClipboard()
        buf = ctypes.create_string_buffer(text.encode("utf-16-le") + b"\x00\x00")
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(buf))
        ptr = kernel32.GlobalLock(handle)
        ctypes.memmove(ptr, buf, len(buf))
        kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(CF_UNICODETEXT, handle)
    finally:
        user32.CloseClipboard()


def _wxwork_pids() -> list[int]:
    import subprocess

    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        encoding="gbk",
        errors="ignore",
        creationflags=_CREATE_NO_WINDOW,
    ).stdout
    pids = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) > 1 and parts[1].strip('"').isdigit():
            pids.append(int(parts[1].strip('"')))
    return pids


def find_main_window() -> int:
    """找企微主窗口。

    实测：企微关闭后缩到托盘，窗口仍然存在但 IsWindowVisible=False，
    所以不能按"可见"过滤，否则永远找不到。优先按窗口类名 WeWorkWindow 命中。
    """
    pids = set(_wxwork_pids())
    if not pids:
        raise RuntimeError("WXWork.exe 未运行")
    found: list[tuple[int, int, int, str]] = []  # (优先级, 面积, hwnd, 类名)

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def callback(hwnd, _lparam):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        rect = wt.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        area = (rect.right - rect.left) * (rect.bottom - rect.top)
        if area < 100_000:
            return True
        cls = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, cls, 128)
        name = cls.value
        priority = 0 if name == "WeWorkWindow" else 1
        found.append((priority, area, int(hwnd), name))
        return True

    user32.EnumWindows(callback, 0)
    if not found:
        raise RuntimeError("没找到企微主窗口（进程在但窗口未创建）")
    found.sort(key=lambda x: (x[0], -x[1]))
    return found[0][2]


def activate(hwnd: int, retries: int = 3) -> bool:
    """把窗口切到前台并确认成功。

    后台进程直接调 SetForegroundWindow 会被 Windows 拒绝（前台锁），
    必须先用 AttachThreadInput 把本线程挂到当前前台线程上，再抢焦点。
    """
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.BringWindowToTop(hwnd)
    time.sleep(0.2)

    for _ in range(retries):
        if user32.GetForegroundWindow() == hwnd:
            return True
        fg = user32.GetForegroundWindow()
        fg_thread = user32.GetWindowThreadProcessId(fg, None)
        this_thread = kernel32.GetCurrentThreadId()
        attached = False
        if fg_thread and fg_thread != this_thread:
            attached = bool(user32.AttachThreadInput(this_thread, fg_thread, True))
        try:
            user32.SetForegroundWindow(hwnd)
            user32.SetFocus(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(this_thread, fg_thread, False)
        time.sleep(0.4)
        if user32.GetForegroundWindow() == hwnd:
            return True
    return False


def send_text(
    conversation_name: str,
    text: str,
    *,
    switch: bool = True,
    dry_run: bool = False,
) -> dict:
    """给指定会话发一条文本。返回 {"ok": bool, "detail": str}

    switch=True  先尝试切到目标会话（依赖 Ctrl+F 搜索，企微 5.x 未验证成功）
    switch=False 直接把文本发到"当前已打开"的会话，由操作员保证会话正确
    """
    if dry_run:
        return {"ok": True, "detail": f"[dry-run] 会发给 {conversation_name!r}: {text[:40]!r}"}

    hwnd = find_main_window()
    if not activate(hwnd):
        raise RuntimeError("无法把企微窗口切到前台（可能被锁屏或其它程序占用前台）")

    if switch:
        _combo(VK_CONTROL, VK_F)          # 打开搜索
        time.sleep(0.8)
        set_clipboard(conversation_name)
        _combo(VK_CONTROL, 0x56)          # Ctrl+V 粘贴名字
        time.sleep(1.0)
        _tap(VK_RETURN)                   # 打开第一个结果
        time.sleep(1.0)
        _tap(VK_ESCAPE)                   # 关闭搜索框
        time.sleep(0.5)

    set_clipboard(text)
    _combo(VK_CONTROL, 0x56)              # Ctrl+V 粘贴正文
    time.sleep(0.6)
    _tap(VK_RETURN)                       # 发送
    time.sleep(0.8)
    return {"ok": True, "detail": "已模拟发送"}


def _client_rect_screen(hwnd: int) -> tuple[int, int, int, int]:
    """客户区在屏幕上的位置和大小（去掉标题栏和边框）。"""
    rect = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    origin = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    return origin.x, origin.y, rect.right - rect.left, rect.bottom - rect.top


def click_ratio(hwnd: int, rx: float, ry: float) -> tuple[int, int]:
    """按客户区比例点一下。rx/ry 取 0~1。"""
    x0, y0, w, h = _client_rect_screen(hwnd)
    x, y = int(x0 + w * rx), int(y0 + h * ry)
    user32.SetCursorPos(x, y)
    time.sleep(0.2)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.3)
    return x, y


def probe(hwnd: int, rx: float, ry: float, text: str = "键盘自测") -> dict:
    """点进指定位置并粘贴一段文字，用于标定输入框坐标（不按回车，不会发出去）。"""
    if not activate(hwnd):
        return {"ok": False, "detail": "窗口切不到前台"}
    x, y = click_ratio(hwnd, rx, ry)
    set_clipboard(text)
    _combo(VK_CONTROL, 0x56)
    time.sleep(0.6)
    return {"ok": True, "detail": f"已在 ({x},{y}) 粘贴：{text}"}


def click_at(x: int, y: int, button: str = "left") -> None:
    """在屏幕绝对坐标点一下。button: left | right。"""
    user32.SetCursorPos(x, y)
    time.sleep(0.15)
    down = 0x0008 if button == "right" else 0x0002
    up = 0x0010 if button == "right" else 0x0004
    user32.mouse_event(down, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(up, 0, 0, 0, 0)
    time.sleep(0.3)


def click_ratio_at(hwnd: int, rx: float, ry: float, button: str = "left") -> tuple[int, int]:
    """按客户区比例点击，支持左右键。"""
    x0, y0, w, h = _client_rect_screen(hwnd)
    x, y = int(x0 + w * rx), int(y0 + h * ry)
    click_at(x, y, button)
    return x, y

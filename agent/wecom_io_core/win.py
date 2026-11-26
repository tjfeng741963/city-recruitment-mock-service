"""窗口定位与键鼠动作（本项目唯一的写操作层）。"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import random
import time

import win32api
import win32clipboard
import win32con
import win32gui
import win32process

user32 = ctypes.windll.user32

VK = {
    "ctrl": win32con.VK_CONTROL,
    "enter": win32con.VK_RETURN,
    "esc": win32con.VK_ESCAPE,
    "a": 0x41,
    "c": 0x43,
    "f": 0x46,
    "v": 0x56,
    "tab": 0x09,
    "delete": 0x2E,
    "space": 0x20,
}


def set_dpi_aware() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass


class RECT(ctypes.Structure):
    _fields_ = [("left", wt.LONG), ("top", wt.LONG), ("right", wt.LONG), ("bottom", wt.LONG)]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


def _renders_content(hwnd: int, w: int, h: int) -> bool:
    """窗口是否真的在绘制内容。

    企微「切换账号」会留下一个 IsWindowVisible=True 但整块全黑的实例窗口
    （2026-11-24 现场：hwnd=591122 截图 2.4KB 全黑，盖在真窗口 hwnd=2426148
    的 156KB 截图之上）。只看 visible 会选中它，之后 Ctrl+F/Ctrl+V 全打在空气上，
    表现为「已回车进入会话」但输入框校验必然失败。

    用 PrintWindow 取若干行像素算平均亮度：全黑窗口亮度趋近 0，正常窗口是浅色底。
    不能按「颜色种类」判断——聊天区空白处整行就是纯色，会被误杀。
    探测失败时返回 True（宁可保持旧行为，也不要误杀唯一窗口）。
    """
    try:
        gdi32 = ctypes.windll.gdi32
        hdc = user32.GetWindowDC(hwnd)
        if not hdc:
            return True
        memdc = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
        old = gdi32.SelectObject(memdc, bmp)
        try:
            if not user32.PrintWindow(hwnd, memdc, 2):
                return True
            bi = _BITMAPINFOHEADER()
            bi.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
            bi.biWidth = w
            bi.biHeight = -h
            bi.biPlanes = 1
            bi.biBitCount = 32
            buf = ctypes.create_string_buffer(w * h * 4)
            # 必须整图取：GetDIBits 在 biHeight=-1 时对 uStartScan 的处理与预期不符，
            # 逐行取（cScanLines=1）在本机实测恒返回全 0（2026-11-24）。
            if not gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bi), 0):
                return True
            data = buf.raw
            total = 0
            count = 0
            for i in range(0, len(data) - 3, 4 * 97):
                total += data[i] + data[i + 1] + data[i + 2]
                count += 1
            if not count:
                return True
            return (total / count / 3) > 25
        finally:
            gdi32.SelectObject(memdc, old)
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(memdc)
            user32.ReleaseDC(hwnd, hdc)
    except Exception:  # noqa: BLE001
        return True


def find_window() -> dict | None:
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        if buf.value != "WeWorkWindow":
            return True
        r = RECT()
        if ctypes.windll.dwmapi.DwmGetWindowAttribute(
                hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) != 0 or r.right <= r.left:
            user32.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if w > 400 and h > 300:
            found.append({"hwnd": hwnd, "rect": (r.left, r.top, w, h),
                          "visible": bool(user32.IsWindowVisible(hwnd))})
        return True

    user32.EnumWindows(_cb, None)
    if not found:
        return None
    # 企微「切换账号」会同时留下新旧两个实例的 WeWorkWindow：旧账号那个仍存在但被隐藏，
    # 且尺寸往往更大。只按面积挑会选中已登出的旧窗口，发送必然被拦（2026-11-24 实测
    # hwnd=853446 pid=4968 隐藏、hwnd=591122 pid=6772 可见）。优先可见窗口。
    visible = [d for d in found if d["visible"]]
    pool = visible or found
    if len(pool) > 1:
        # 可见窗口也可能不止一个，其中会有「可见但全黑」的切换账号残留窗口，
        # 它常常尺寸更大并盖在真窗口上。挑第一个真正在渲染的。
        pool = sorted(pool, key=lambda d: d["rect"][2] * d["rect"][3], reverse=True)
        for item in pool:
            if _renders_content(item["hwnd"], item["rect"][2], item["rect"][3]):
                return item
    return max(pool, key=lambda d: d["rect"][2] * d["rect"][3])


def activate(hwnd: int) -> bool:
    if not user32.IsWindowVisible(hwnd):
        user32.ShowWindow(hwnd, win32con.SW_SHOW)
        time.sleep(0.25)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.25)
    if user32.GetForegroundWindow() == hwnd:
        return True
    cur = win32api.GetCurrentThreadId()
    tgt, _ = win32process.GetWindowThreadProcessId(hwnd)
    attached = False
    try:
        if tgt and tgt != cur:
            attached = bool(win32process.AttachThreadInput(cur, tgt, True))
        user32.BringWindowToTop(hwnd)
        try:
            user32.SwitchToThisWindow(hwnd, True)
        except Exception:
            pass
        user32.SetForegroundWindow(hwnd)
    except Exception:
        return False
    finally:
        if attached:
            win32process.AttachThreadInput(cur, tgt, False)
    time.sleep(0.2)
    return user32.GetForegroundWindow() == hwnd


def _jitter(base: float, lo: float = 0.85, hi: float = 1.25) -> None:
    time.sleep(base * random.uniform(lo, hi))


def _key(vk: int, up: bool = False) -> None:
    win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP if up else 0, 0)


def hotkey(*names: str) -> None:
    vks = [VK[n] for n in names]
    for vk in vks:
        _key(vk)
        time.sleep(0.02)
    time.sleep(0.05)
    for vk in reversed(vks):
        _key(vk, up=True)
        time.sleep(0.02)


def tap(name: str) -> None:
    vk = VK[name]
    _key(vk)
    time.sleep(0.03)
    _key(vk, up=True)
    time.sleep(0.05)


def set_clipboard(text: str) -> None:
    for _ in range(5):
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
            finally:
                win32clipboard.CloseClipboard()
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("写剪贴板失败")


def click(x: int, y: int) -> None:
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.06)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.04)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def ensure_foreground(hwnd: int, tries: int = 3, wait: float = 0.35) -> bool:
    """反复抢前台，直到成功或用尽次数（参考项目每步前都做这件事）。"""
    for _ in range(max(1, tries)):
        if user32.GetForegroundWindow() == hwnd:
            return True
        activate(hwnd)
        time.sleep(wait)
    return user32.GetForegroundWindow() == hwnd


def release_modifiers() -> None:
    """释放可能卡住的修饰键，避免异常中断后键盘被锁。"""
    for vk in (win32con.VK_CONTROL, win32con.VK_MENU, win32con.VK_SHIFT, win32con.VK_LWIN):
        try:
            _key(vk, up=True)
        except Exception:
            pass
    time.sleep(0.03)


def get_clipboard() -> str:
    for _ in range(5):
        try:
            win32clipboard.OpenClipboard()
            try:
                return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT) or ""
            finally:
                win32clipboard.CloseClipboard()
        except Exception:
            time.sleep(0.08)
    return ""


def is_visible(hwnd: int) -> bool:
    return bool(user32.IsWindowVisible(hwnd))


def wait_visible(hwnd: int, timeout: float = 15.0) -> bool:
    """等窗口重新可见（参考项目：企微检测到自动化后会隐藏窗口约 9 秒）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if user32.IsWindowVisible(hwnd):
            return True
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, win32con.SW_RESTORE)
        elif not user32.IsWindowVisible(hwnd):
            user32.ShowWindow(hwnd, win32con.SW_SHOW)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.3)
    return user32.IsWindowVisible(hwnd)


def wxwork_alive() -> bool:
    """企业微信进程是否还在（参考项目：进程没了就中止整批）。"""
    import subprocess

    try:
        # tasklist 输出是 GBK（中文系统），用 text=True 会解码失败
        raw = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WXWork.exe"],
                             capture_output=True, timeout=10).stdout
        return "wxwork.exe" in raw.decode("gbk", errors="ignore").lower()
    except Exception:
        return True

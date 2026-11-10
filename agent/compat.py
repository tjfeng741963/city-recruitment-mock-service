"""对 wecom_io_core 的本机兼容补丁（不改动 core 里的任何文件）。

背景
----
`core/win.py` 的 `set_clipboard` 用 `win32clipboard.SetClipboardData(fmt, str)`，
由 pywin32 内部完成 GlobalAlloc。在本机上，当发送流程执行到「步骤2 清空输入框」
之后的那次写入时，`SetClipboardData` 会稳定抛出 `error(6, '句柄无效')`
（即内部 GlobalAlloc 拿不到内存句柄），重试 6 轮共 3 秒仍失败；
而在流程之外单独调用同一函数又稳定成功。

这里把它替换成显式 `GlobalAlloc + GlobalLock + memmove + SetClipboardData`
的等价实现，行为完全一致（CF_UNICODETEXT + GMEM_MOVEABLE），
只是不再依赖 pywin32 的自动转换。

**只补这一处，发送的动作序列（Ctrl+F / Enter / Ctrl+A / Delete / Ctrl+V / 哨兵回读）
仍然完全由 core/send.py 决定，不做任何改动。**
"""

from __future__ import annotations

import ctypes
import time

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.restype = ctypes.c_int
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalFree.restype = ctypes.c_void_p
kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
user32.OpenClipboard.restype = ctypes.c_int
user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.EmptyClipboard.restype = ctypes.c_int
user32.CloseClipboard.restype = ctypes.c_int
user32.SetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]


def set_clipboard(text: str, retries: int = 100) -> None:
    """等价于 core/win.py::set_clipboard，但显式管理内存句柄。

    本机上向日葵（AweSun.exe 的 CClipboardViewer）会周期性独占剪贴板，
    最长约 5 秒才释放；原实现只等 0.5 秒，所以会卡在「Ctrl+F 之后写不进会话名」。
    这里把重试拉到 100 × 0.12s ≈ 12 秒，覆盖它的占用周期。
    """
    payload = text.encode("utf-16-le") + b"\x00\x00"
    last_err = 0
    for _ in range(retries):
        if not user32.OpenClipboard(None):
            last_err = ctypes.get_last_error()
            time.sleep(0.12)
            continue
        handle = None
        ok = False
        try:
            user32.EmptyClipboard()
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(payload))
            if not handle:
                last_err = ctypes.get_last_error()
                continue
            ptr = kernel32.GlobalLock(handle)
            if not ptr:
                last_err = ctypes.get_last_error()
                continue
            ctypes.memmove(ptr, payload, len(payload))
            kernel32.GlobalUnlock(handle)
            if user32.SetClipboardData(CF_UNICODETEXT, ctypes.c_void_p(handle)):
                ok = True
            else:
                last_err = ctypes.get_last_error()
        finally:
            user32.CloseClipboard()
            if not ok and handle:
                kernel32.GlobalFree(ctypes.c_void_p(handle))
        if ok:
            return
        time.sleep(0.12)
    raise RuntimeError(f"写剪贴板失败：err={last_err}")


def wait_clipboard_writable(timeout: float = 15.0) -> bool:
    """等剪贴板可写。**在按任何键之前**调用，避免 Ctrl+F 打开搜索框后才卡住。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if user32.OpenClipboard(None):
            user32.CloseClipboard()
            return True
        time.sleep(0.12)
    return False


def apply() -> None:
    """把 core.win.set_clipboard 换成上面的实现。"""
    from wecom_io_core import win as core_win

    core_win.set_clipboard = set_clipboard


# ── 抢前台 ──────────────────────────────────────────────────────────────────
# 实测：autopilot 常驻在后台时，`core.win.ensure_foreground` 会连续失败
# （"抢不到前台，已中止"），因为 Windows 前台锁只允许当前前台进程调用
# SetForegroundWindow。解决顺序：AllowSetForegroundWindow(ASFW_ANY) →
# core 自带的 AttachThreadInput → 仍失败则轻敲一次 Alt 冒充用户输入，
# 解除前台锁后再抢。动作序列仍由 core/send.py 决定，这里只管"把窗口弄到前台"。

VK_MENU = 0x12
KEYEVENTF_KEYUP = 0x0002

user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.SetForegroundWindow.restype = ctypes.c_int
user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
user32.BringWindowToTop.restype = ctypes.c_int
user32.BringWindowToTop.argtypes = [ctypes.c_void_p]
user32.AllowSetForegroundWindow.restype = ctypes.c_int
user32.AllowSetForegroundWindow.argtypes = [ctypes.c_uint]
user32.IsWindow.restype = ctypes.c_int
user32.IsWindow.argtypes = [ctypes.c_void_p]


def _foreground() -> int:
    return int(user32.GetForegroundWindow() or 0)


def _alt_tap() -> None:
    """轻敲一次 Alt：让系统认为发生了用户输入，从而解除 SetForegroundWindow 的前台锁。

    注意：Alt 会激活窗口菜单栏，可能把后续按键的焦点带偏，只在最后手段用。
    """
    user32.keybd_event(VK_MENU, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)


user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_long * 4)]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]


def _click_titlebar(hwnd: int) -> bool:
    """点一下窗口标题栏正中间来激活。

    比 Alt 可靠：鼠标点击本身就是"用户输入"，能真正解除前台锁，
    而且点标题栏中间不会触发任何业务操作（避开右上角的最小化/关闭）。
    """
    buf = (ctypes.c_long * 4)()
    if not user32.GetWindowRect(ctypes.c_void_p(hwnd), buf):
        return False
    left, top, right, bottom = buf[0], buf[1], buf[2], buf[3]
    if right <= left or bottom <= top:
        return False
    x = left + (right - left) // 2
    y = top + 18  # 标题栏中部，避开按钮
    user32.SetCursorPos(x, y)
    time.sleep(0.06)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.04)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    return True


def make_ensure_foreground(core_activate):
    def _tap_esc() -> None:
        user32.keybd_event(0x1B, 0, 0, 0)            # ESC down
        time.sleep(0.05)
        user32.keybd_event(0x1B, 0, KEYEVENTF_KEYUP, 0)

    def ensure_foreground(hwnd: int, tries: int = 6, wait: float = 0.35) -> bool:
        """抢前台，并在成功返回前空按一次 Esc。

        为什么在返回前按：core/send.py 拿到 True 后立刻发 Ctrl+F，
        而窗口刚被激活时**第一个按键会被系统用于激活窗口而不投递**，
        Ctrl+F 因此落空——搜索框没开、后面整段跑偏，表现为校验一直读到哨兵。
        在这里先消耗掉那次按键，send 里的 Ctrl+F 就成了"第二次按键"，能正常送达。
        """
        if not user32.IsWindow(ctypes.c_void_p(hwnd)):
            return False
        user32.AllowSetForegroundWindow(0xFFFFFFFF)  # ASFW_ANY

        ok = False
        rounds = max(tries, 6)
        for i in range(rounds):
            if _foreground() == hwnd:
                ok = True
                break
            core_activate(hwnd)
            time.sleep(wait)
            if _foreground() == hwnd:
                ok = True
                break
            if i % 2 == 1:
                _click_titlebar(hwnd)
            else:
                _alt_tap()
                user32.BringWindowToTop(ctypes.c_void_p(hwnd))
                user32.SetForegroundWindow(ctypes.c_void_p(hwnd))
            time.sleep(wait)
            if _foreground() == hwnd:
                ok = True
                break

        if ok:
            try:
                _tap_esc()
                time.sleep(0.12)
            except Exception:
                pass
            return _foreground() == hwnd
        return False

    return ensure_foreground


def apply_foreground() -> None:
    from wecom_io_core import win as core_win

    core_win.ensure_foreground = make_ensure_foreground(core_win.activate)


# ── 进会话后点一下输入框 ────────────────────────────────────────────────────
# 实测：从搜索结果回车进会话时，聊天区会重新渲染，焦点在约 0.2 秒后丢失，
# 于是后面的 Ctrl+A / Delete / Ctrl+V 全落在别处，verify_input_box 一直读到哨兵。
# 在 core 的 tap("delete") 之前插一次鼠标点击，把焦点拉回输入框。
# 位置按窗口比例算（输入框中部），不依赖固定分辨率。
CLICK_INPUT_RATIO = (0.45, 0.86)

user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]


def click_client(hwnd: int, rx: float, ry: float) -> bool:
    """按窗口比例点一下客户区。"""
    buf = (ctypes.c_long * 4)()
    if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(buf)):
        return False
    left, top, right, bottom = buf[0], buf[1], buf[2], buf[3]
    if right <= left or bottom <= top:
        return False
    x = left + int((right - left) * rx)
    y = top + int((bottom - top) * ry)
    user32.SetCursorPos(x, y)
    time.sleep(0.12)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.2)
    return True


def apply_click_input() -> None:
    """让 core 在执行 Delete（清空输入框）之前先点一下输入框。"""
    from wecom_io_core import win as core_win

    orig_tap = core_win.tap

    def tap(name: str) -> None:
        if name == "delete":
            fg = _foreground()
            if fg:
                click_client(fg, *CLICK_INPUT_RATIO)
        orig_tap(name)

    core_win.tap = tap


# ── 输入框没命中就换点重试 ──────────────────────────────────────────────────
# 单一比例点在窗口布局变化时（登录页→主界面、会话列表宽度变化、不同分辨率）
# 会打偏；打偏后 verify_input_box 只能报"焦点未落在输入框"，整次发送作废。
# 这里包一层：首次校验失败时，逐个候选点"点击 → 重新粘贴 → 再校验"。
# 不改 send.py 的动作序列，只替换它调用的校验函数。
INPUT_ATTEMPTS = (
    (0.45, 0.86),   # 主点：输入框中部
    (0.45, 0.80),   # 偏上（多行输入框上部）
    (0.55, 0.86),   # 偏右
    (0.35, 0.86),   # 偏左（避开右侧按钮）
    (0.45, 0.90),   # 偏下（贴近发送按钮上方）
    (0.50, 0.78),
)


def apply_input_focus_retry() -> None:
    """校验失败时换候选点重试，最多走完 INPUT_ATTEMPTS。"""
    from wecom_io_core import send as core_send
    from wecom_io_core import win as core_win

    orig_verify = core_send.verify_input_box

    def verify(text: str, retries: int = 5) -> tuple[bool, str]:
        ok, hint = orig_verify(text, retries=retries)
        if ok:
            return ok, hint

        target = core_win.find_window()
        if not target:
            return ok, hint
        hwnd = target["hwnd"]

        for rx, ry in INPUT_ATTEMPTS:
            core_win.ensure_foreground(hwnd, tries=3)
            time.sleep(0.15)
            if not click_client(hwnd, rx, ry):
                continue
            # 点击后重新粘贴，再走一遍原始校验
            core_win.set_clipboard(text)
            time.sleep(0.12)
            core_win.hotkey("ctrl", "a")
            time.sleep(0.08)
            core_win.hotkey("ctrl", "v")
            time.sleep(0.35)
            ok, hint = orig_verify(text, retries=2)
            if ok:
                return True, f"{hint}（候选点 {rx:.2f},{ry:.2f}）"

        return False, hint

    core_send.verify_input_box = verify


# ── 长消息解析 ──────────────────────────────────────────────────────────────
# core/store.py 的 `_pb_text` 对每个 length-delimited 字段直接 `decode("utf-8")`，
# 一旦失败就 `continue` 整段丢弃。消息体超过 127 字节时，长度前缀会变成两字节
# varint（如 `\x96\x01`），其中的 `\x96` 后跟 `\x01` 不是合法 UTF-8 序列，
# 于是整条消息被丢成空字符串。
#
# 实测：`'233'`（11 字节）能解，`'广州番禺电子厂普工现在还在招…'`（158 字节）解出空。
# 后果是 `build_history()` 取不到上下文，知识库只能看到短消息。
#
# 修法：decode 时 `errors="ignore"`，非法字节丢掉、中文保留。评分逻辑不变。

import re as _re


def _pb_text_lenient(data):
    if isinstance(data, str):
        return data
    if not isinstance(data, (bytes, bytearray)) or not data:
        return ""
    buf = bytes(data)
    i, n = 0, len(buf)
    best, best_score = "", 0

    def _varint(pos: int):
        val, shift = 0, 0
        while pos < n:
            b = buf[pos]
            pos += 1
            val |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        return val, pos

    while i < n:
        key, i = _varint(i)
        if key == 0 or i >= n:
            break
        wire = key & 7
        if wire == 0:
            _, i = _varint(i)
        elif wire == 1:
            i += 8
        elif wire == 2:
            ln, i = _varint(i)
            chunk = buf[i:i + ln]
            i += ln
            # 关键差异：ignore 而不是整段丢弃
            text = chunk.decode("utf-8", errors="ignore")
            clean = "".join(c for c in text if ord(c) >= 32 or c in "\n\t")
            score = sum(1 for c in clean if c.isalnum() or "\u4e00" <= c <= "\u9fff")
            has_cjk = any("\u4e00" <= c <= "\u9fff" for c in clean)
            if has_cjk and clean and clean[0].isascii() and clean[0].isalnum():
                score -= 10
            if score > best_score and clean.strip():
                best, best_score = clean, score
        elif wire == 5:
            i += 4
        else:
            break
    best = best.replace("\x00", "").strip()
    m = _re.match(r"^[\x20-\x7e\n]{1,5}(?=[\u4e00-\u9fff])", best)
    if m:
        best = best[m.end():]
    return best.strip()


def apply_pb_text() -> None:
    """替换 core.store._pb_text 为宽松解码版本。"""
    from wecom_io_core import store as core_store

    core_store._pb_text = _pb_text_lenient


def warmup_keyboard(keys: int = 2) -> bool:
    """抢前台后先空按几下，消耗掉"激活窗口"的那一次按键。

    实测：窗口从后台被激活时，系统的第一次按键会被用于激活窗口而不投递，
    于是 core/send.py 里的第一个 Ctrl+F 落空——搜索框没打开、后续全乱，
    表现为 verify_input_box 一直读到哨兵。空按 Esc 几次即可解决。

    注意：不因 ensure_foreground 返回 False 就提前退出——它经常在"已经在前台"
    但状态没同步的情况下报失败，此时窗口其实可用，Esc 仍然要按。
    """
    from wecom_io_core import win as core_win

    target = core_win.find_window()
    if not target:
        return False
    hwnd = target["hwnd"]
    core_win.ensure_foreground(hwnd)  # 返回值不可靠，下面用实际前台再判断
    try:
        for _ in range(max(1, keys)):
            core_win.tap("esc")
            time.sleep(0.18)
    except Exception:
        return False
    return _foreground() == hwnd

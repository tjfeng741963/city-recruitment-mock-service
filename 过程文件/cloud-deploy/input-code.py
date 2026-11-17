"""向企微验证码弹窗输入验证码：用法 python input-code.py 354853

关键教训（2026-11-17）：短信验证码弹窗是浮在登录窗上方的独立窗口
（类名 WXworkWindow，320x214，自绘无控件）——敲 WeChatLogin 是无效的。

流程：找 WXworkWindow → 前台 → 点输入框区域聚焦 → 清残留 → 逐位敲入
→ 点「验证」按钮。必须在交互式会话（Console）里跑。
"""
import ctypes
import sys
import time

import win32gui

u = ctypes.windll.user32

PUL = ctypes.POINTER(ctypes.c_ulong)


class KeyBdInput(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", PUL)]


class HardwareInput(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_short),
                ("wParamH", ctypes.c_ushort)]


class MouseInput(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", PUL)]


class Input_I(ctypes.Union):
    _fields_ = [("ki", KeyBdInput), ("hi", HardwareInput), ("mi", MouseInput)]


class Input(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("ii", Input_I)]


KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_KEYUP = 0x0002
INPUT_KEYBOARD = 1
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

VK_RETURN = 0x0D
VK_CONTROL = 0x11
VK_A = 0x41
VK_DELETE = 0x2E


def _key(vk: int, down: bool) -> None:
    ii = Input_I()
    ii.ki = KeyBdInput(vk, 0, 0 if down else KEYEVENTF_KEYUP, 0, None)
    arr = (Input * 1)(Input(INPUT_KEYBOARD, ii))
    u.SendInput(1, arr, ctypes.sizeof(Input))
    time.sleep(0.05)


def send_char(ch: str) -> None:
    for flag in (0, KEYEVENTF_KEYUP):
        ii = Input_I()
        ii.ki = KeyBdInput(0, ord(ch), KEYEVENTF_UNICODE | flag, 0, None)
        arr = (Input * 1)(Input(INPUT_KEYBOARD, ii))
        u.SendInput(1, arr, ctypes.sizeof(Input))
        time.sleep(0.12)


def send_enter() -> None:
    _key(VK_RETURN, True)
    _key(VK_RETURN, False)


def click_at(x: int, y: int) -> None:
    """鼠标移动到屏幕绝对坐标并左键单击（验证码窗是自绘的，靠点击聚焦）。"""
    u.SetCursorPos(int(x), int(y))
    time.sleep(0.1)
    u.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, None)
    time.sleep(0.05)
    u.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, None)
    time.sleep(0.2)


def clear_input() -> None:
    _key(VK_CONTROL, True)
    _key(VK_A, False)
    _key(VK_CONTROL, False)
    time.sleep(0.15)
    _key(VK_DELETE, True)
    _key(VK_DELETE, False)
    time.sleep(0.15)


def find_windows() -> dict:
    """收集企微全部可见顶层窗口，按类名归类。"""
    import subprocess

    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV"],
                         capture_output=True, text=True).stdout
    pids = []
    for line in out.splitlines():
        if "WXWork" in line:
            parts = line.split('","')
            if len(parts) > 1:
                try:
                    pids.append(int(parts[1].strip('"')))
                except ValueError:
                    pass

    found = {}

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        try:
            pid = win32gui.GetWindowThreadProcessId(hwnd)[1]
        except Exception:
            return True
        if pid not in pids:
            return True
        cls = win32gui.GetClassName(hwnd)
        # 同类窗口取最后一个（最上层）
        found[cls] = hwnd
        return True

    win32gui.EnumWindows(cb, None)
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: input-code.py <验证码>")
        return 2
    code = sys.argv[1].strip()
    if not code.isdigit():
        print("验证码必须是纯数字:", code)
        return 2

    windows = find_windows()
    print("可见企微窗口:", {k: hex(v) for k, v in windows.items()})

    # 优先验证码弹窗（WXworkWindow）；没有就退回登录窗
    hwnd = windows.get("WXworkWindow") or windows.get("WeChatLogin") or 0
    if not hwnd:
        print("没找到企微窗口")
        return 1
    cls = win32gui.GetClassName(hwnd)
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    w, h = right - left, bottom - top
    print("目标窗口:", cls, hex(hwnd), f"({left},{top}) {w}x{h}")

    try:
        win32gui.ShowWindow(hwnd, 9)  # SW_RESTORE
    except Exception:
        pass
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception as exc:
        print("SetForegroundWindow 失败（继续尝试）:", exc)
    time.sleep(1.0)

    # 点击输入框区域聚焦（弹窗布局：标题在上，六个格子约在 45~55% 高度，验证按钮约 75%）
    box_x = left + w // 2
    box_y = top + int(h * 0.48)
    click_at(box_x, box_y)
    print(f"点击输入框区域 ({box_x},{box_y})")

    clear_input()

    for ch in code:
        send_char(ch)
        time.sleep(0.15)
    print("已输入", code, "，等 1 秒后点「验证」按钮")
    time.sleep(1.0)

    btn_y = top + int(h * 0.76)
    click_at(box_x, btn_y)
    print(f"已点击验证按钮 ({box_x},{btn_y})")
    time.sleep(1.0)
    # 兜底：部分版本回车也能提交
    send_enter()
    print("完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())

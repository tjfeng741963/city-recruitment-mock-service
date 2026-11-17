"""向企微验证码窗口输入验证码：用法 python input-code.py 354853

窗口是 Qt 自绘（无 Win32 控件），只能走前台焦点 + SendInput Unicode。
必须在交互式会话（Console）里跑，SSH 会话看不到窗口。
"""
import ctypes
import sys
import time
import win32gui

u = ctypes.windll.user32
k = ctypes.windll.kernel32

# SendInput 结构（KEYBDINPUT）
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
    """一个 Unicode 字符 = 按下 + 抬起两个事件。"""
    for flag in (0, KEYEVENTF_KEYUP):
        ii = Input_I()
        ii.ki = KeyBdInput(0, ord(ch), KEYEVENTF_UNICODE | flag, 0, None)
        arr = (Input * 1)(Input(INPUT_KEYBOARD, ii))
        u.SendInput(1, arr, ctypes.sizeof(Input))
        time.sleep(0.12)


def send_enter() -> None:
    _key(VK_RETURN, True)
    _key(VK_RETURN, False)


def clear_input() -> None:
    """清空当前焦点输入框：Ctrl+A 全选 → Delete。

    企微的验证码窗是自绘控件，残留的上一次输入会让新码拼成错误位数
    （「验证码位数错误」的来源），敲码前必须先清。
    """
    _key(VK_CONTROL, True)
    _key(VK_A, False)
    _key(VK_CONTROL, False)
    time.sleep(0.15)
    _key(VK_DELETE, True)
    _key(VK_DELETE, False)
    time.sleep(0.15)


def find_login_window() -> int:
    found = []

    def cb(hwnd, _):
        if win32gui.GetClassName(hwnd) == "WeChatLogin" and win32gui.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    win32gui.EnumWindows(cb, None)
    return found[0] if found else 0


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: input-code.py <验证码>")
        return 2
    code = sys.argv[1].strip()
    if not code.isdigit():
        print("验证码必须是纯数字:", code)
        return 2

    hwnd = find_login_window()
    if not hwnd:
        print("没找到企微登录窗（WeChatLogin）")
        return 1
    title = win32gui.GetWindowText(hwnd)
    print("登录窗:", hex(hwnd), title)

    # 前台 + 焦点（最小化时先还原）
    try:
        win32gui.ShowWindow(hwnd, 9)  # SW_RESTORE
    except Exception:
        pass
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception as exc:
        print("SetForegroundWindow 失败（继续尝试）:", exc)
    time.sleep(1.2)

    # 先清掉可能残留的旧输入（上一次失败的码拼在后面 = 位数错误）
    clear_input()

    for ch in code:
        send_char(ch)
        time.sleep(0.15)
    print("已输入", code, "，等 1.5 秒后回车")
    time.sleep(1.5)
    send_enter()
    print("已回车提交")
    return 0


if __name__ == "__main__":
    sys.exit(main())

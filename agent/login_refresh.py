# -*- coding: utf-8 -*-
"""登录二维码过期自动刷新（三段式：定位窗口 → 相对坐标点击 → 截图验证）。

背景：企微 PC 登录窗口的二维码约 1-2 分钟过期，窗口里出现「二维码已过期 / 刷新」，
过期期间 autopilot 判定 login_required、设备离线、消息不回复。
历史上这个「刷新」只能人工在客户端机屏幕上点——远程桌面一断就没人点了。

设计约束（AGENTS.md 铁律）：
- 不碰 win.py / send.py 的任何动作层；本模块只在「登录窗口」（未登录态）上操作，
  不涉及任何消息发送链路。用户 2026-11-18 明确确认要做此自动点击。
- 进程模型：由 autopilot 主进程内嵌调用（login_required 分支），不另起进程——
  避免独立脚本的进程管理混乱（用户明确要求「都在统一一个」）。
- 执行上下文：autopilot 与企微同桌面会话（console），截图/点击才有效。
- 无第三方依赖：纯 ctypes user32/gdi32，不需要 opencv / OCR。
  定位方式：FindWindowW 定位企微登录窗口 → 「刷新」在窗口内固定相对位置
  （窗口宽 54%、高 55%，按 2026-11-18 实测截图标定）→ 点击后截图比对验证。
- 风控评估：点击发生在「未登录的登录窗口」，不涉及任何账号消息行为，风险最低档。
"""
from __future__ import annotations

import ctypes
import sys
import threading
import time

# 点击冷却：两次自动刷新至少间隔 90 秒（企微码 1-2 分钟一轮，太勤会被风控盯上）
REFRESH_COOLDOWN_SECONDS = 90.0
# 「刷新」按钮在登录窗口内的相对位置（x=宽的比例, y=高的比例）
REFRESH_REL_X = 0.50
REFRESH_REL_Y = 0.55
# 点击后等待企微出新码再验证
_VERIFY_DELAY = 4.0
# 单次截图尺寸（验证用，缩小体积）
_SHOT_PATH = r"C:\agent\logs\qr-refresh-verify.png"

# 惰性加载：CI/非 Windows 上 import 本模块必须不炸。
# autopilot.py 在模块顶层 `import login_refresh`，而 Linux 的 ctypes 没有 windll，
# 导入期取 user32 会让所有加载 autopilot 的用例在 setup 阶段就 ERROR（CI 就是这么红的）。
_user32 = None
_gdi32 = None


def _u():
    """惰性拿 user32；非 Windows 返回 None，由调用方判定后跳过。"""
    global _user32
    if _user32 is None and sys.platform == "win32":
        _user32 = ctypes.windll.user32
    return _user32


def _g():
    """惰性拿 gdi32；非 Windows 返回 None。"""
    global _gdi32
    if _gdi32 is None and sys.platform == "win32":
        _gdi32 = ctypes.windll.gdi32
    return _gdi32


_lock = threading.Lock()
_last_click_ts = 0.0


def _find_login_window():
    """定位企微登录窗口，返回 (hwnd, left, top, width, height) 或 None。"""
    user32 = _u()
    if user32 is None:
        return None
    hwnd = user32.FindWindowW(None, "企业微信")
    if not hwnd:
        return None
    if not user32.IsWindowVisible(hwnd):
        return None
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width < 200 or height < 300:
        return None  # 尺寸不对，不是登录窗口
    return hwnd, rect.left, rect.top, width, height


def _click_at(x, y):
    """移动鼠标到绝对坐标并左键单击（mouse_event，与主链路 keybd_event 同代 API）。"""
    user32 = _u()
    if user32 is None:
        return
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.15)
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, None)
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, None)


def _save_screen_crop(path):
    """全屏截图落盘（验证用）。GDI 无第三方依赖。"""
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
    user32 = _u()
    gdi32 = _g()
    if user32 is None or gdi32 is None:
        return False
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    gdi32.SelectObject(hdc_mem, hbm)
    gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, 0, 0, 0x00CC0020)
    # 保存为 BMP（无 GDI+ 依赖，PIL 可选读）
    class BMPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                    ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                    ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                    ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                    ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                    ("biClrImportant", ctypes.c_uint32)]
    bmi = BMPINFOHEADER(ctypes.sizeof(BMPINFOHEADER), width, -height, 1, 24, 0, 0, 0, 0, 0, 0)
    row_size = (width * 3 + 3) // 4 * 4
    buf = ctypes.create_string_buffer(row_size * height)
    gdi32.GetDIBits(hdc_mem, hbm, 0, height, buf, ctypes.byref(bmi), 0)
    user32.ReleaseDC(0, hdc_screen)
    gdi32.DeleteDC(hdc_mem)
    gdi32.DeleteObject(hbm)
    file_header = b"BM" + (54 + len(buf.raw)).to_bytes(4, "little") + b"\0\0\0\0" + (54).to_bytes(4, "little")
    with open(path, "wb") as f:
        f.write(file_header)
        f.write(bmi)
        f.write(buf.raw)
    return True


def maybe_refresh_expired_qr(log=None) -> bool:
    """login_required 时调用：若登录窗口码已过期则自动点击「刷新」。

    返回 True 表示本次执行了点击动作。线程化执行，立即返回，不阻塞主循环。
    """
    global _last_click_ts
    if sys.platform != "win32":
        return False
    now = time.time()
    if now - _last_click_ts < REFRESH_COOLDOWN_SECONDS:
        return False
    _last_click_ts = now

    def _worker():
        try:
            win = _find_login_window()
            if not win:
                if log:
                    log("[qr-refresh] 未找到可见的企微登录窗口，跳过")
                return
            hwnd, left, top, width, height = win
            click_x = left + int(width * REFRESH_REL_X)
            click_y = top + int(height * REFRESH_REL_Y)
            if log:
                log(f"[qr-refresh] 登录窗口 ({left},{top}) {width}x{height}，点击刷新 ({click_x},{click_y})")
            _click_at(click_x, click_y)
            time.sleep(_VERIFY_DELAY)
            _save_screen_crop(_SHOT_PATH)
            if log:
                log(f"[qr-refresh] 已点击并留验证截图 {_SHOT_PATH}")
        except Exception as exc:  # noqa: BLE001
            if log:
                log(f"[qr-refresh] 异常（忽略）：{exc!r}")

    threading.Thread(target=_worker, daemon=True).start()
    return True

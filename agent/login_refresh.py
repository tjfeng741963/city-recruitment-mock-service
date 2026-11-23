# -*- coding: utf-8 -*-
"""登录二维码过期自动刷新（定位窗口 → 投递点击 → 截图比对验证）。

背景：企微 PC 登录窗口的二维码约 1-2 分钟过期，窗口里会出现「二维码已过期 / 刷新」，
过期期间 autopilot 判定 login_required、设备离线、消息不回复。
历史上这个「刷新」只能人工在客户端机屏幕上点——远程桌面一断就没人点了。

2026-11-23 关键修复：**断开的 RDP 会话里鼠标注入无效**。
实测 134 那台机器 Administrator 会话状态是「断开」，此时：
- 全屏 BitBlt 返回纯黑；
- SetCursorPos + mouse_event 没有输入桌面可用，点击落空（21:05、21:06 两次
  自动刷新点击后二维码纹丝不动）；
- 但 PrintWindow 仍能渲染窗口内容（截图链路一直正常）。
所以主路径改成 **PostMessage 直接向 WeChatLogin 窗口投递 WM_LBUTTONDOWN/UP**，
不依赖输入桌面；mouse_event 只作兜底（会话真实可见时优先走真实输入）。

设计约束（AGENTS.md 铁律）：
- 不碰 win.py / send.py 的任何动作层；本模块只在「登录窗口」（未登录态）上操作，
  不涉及任何消息发送链路。用户 2026-11-18 明确确认要做此自动点击。
- 窗口按类名 `WeChatLogin` 定位（与 login_qr 一致）——主窗口类名不同，
  天然不会误点聊天界面（11-19 14:33 曾因标题相同点到主窗中部）。
- 进程模型：由 autopilot 主进程内嵌调用，不另起进程。
- 无第三方依赖：纯 ctypes user32/gdi32，不需要 opencv / OCR。
- 风控评估：点击发生在「未登录的登录窗口」，不涉及任何账号消息行为，风险最低档。
"""
from __future__ import annotations

import ctypes
import hashlib
import sys
import threading
import time
from ctypes import wintypes as wt

# 点击冷却：两次自动刷新至少间隔 90 秒（企微码 1-2 分钟一轮，太勤会被风控盯上）
REFRESH_COOLDOWN_SECONDS = 90.0

# 「刷新」链接中心在登录窗内的相对位置。
# 2026-11-23 对 180x252 的上传帧做像素聚类实测：蓝色「刷新」文字中心
# = (49.7% 宽, 53.6% 高)。旧值 (0.50, 0.55) 偏下约 6px，只擦到链接下沿。
REFRESH_REL_X = 0.497
REFRESH_REL_Y = 0.536

# 登录窗类名（与 login_qr / login_watch 保持一致）
LOGIN_CLASS = "WeChatLogin"

# 点击后等企微重绘出新码再比对
_VERIFY_DELAY = 3.5

# 尺寸白名单：只认登录小窗（实测 300x420，高 DPI 约 450x630）。
# 主窗口约 1180x760，超出上限一律不点。
_MIN_W, _MAX_W = 200, 560
_MIN_H, _MAX_H = 280, 760

WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
MK_LBUTTON = 0x0001
PW_RENDERFULLCONTENT = 0x00000002

# 惰性加载：CI/非 Windows 上 import 本模块必须不炸。
_user32 = None
_gdi32 = None


def _u():
    """惰性拿 user32；非 Windows 返回 None，由调用方判定后跳过。"""
    global _user32
    if _user32 is None and sys.platform == "win32":
        _user32 = ctypes.WinDLL("user32", use_last_error=True)
    return _user32


def _g():
    """惰性拿 gdi32；非 Windows 返回 None。"""
    global _gdi32
    if _gdi32 is None and sys.platform == "win32":
        _gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    return _gdi32


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class _BMPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


_lock = threading.Lock()
_last_click_ts = 0.0


def _find_login_window():
    """定位企微登录窗，返回 (hwnd, left, top, width, height) 或 None。

    按窗口类名找，而不是按标题——主窗口标题同为「企业微信」，11-19 就是这么
    点到聊天界面的。类名 WeChatLogin 只出现在未登录的扫码窗上。
    """
    user32 = _u()
    if user32 is None:
        return None
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _lparam):
        buf = ctypes.create_unicode_buffer(128)
        try:
            user32.GetClassNameW(hwnd, buf, 128)
        except Exception:  # noqa: BLE001
            return True
        if buf.value == LOGIN_CLASS and user32.IsWindowVisible(hwnd):
            found.append(int(hwnd))
            return False
        return True

    try:
        user32.EnumWindows(_cb, 0)
    except Exception:  # noqa: BLE001
        return None
    if not found:
        return None
    hwnd = found[0]
    rect = _RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if not (_MIN_W <= width <= _MAX_W and _MIN_H <= height <= _MAX_H):
        return None
    return hwnd, rect.left, rect.top, width, height


def _capture_pixels(hwnd: int):
    """PrintWindow 抓整窗，返回 (像素字节, 宽, 高)；失败返回 None。

    断开 RDP 时全屏 BitBlt 是黑的，但 PrintWindow 仍能把窗口内容画出来——
    这是本模块能在无人值守机器上工作的前提。
    """
    user32 = _u()
    gdi32 = _g()
    if user32 is None or gdi32 is None:
        return None
    rect = _RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbm)
    ok = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)
    bmi = _BMPINFOHEADER(ctypes.sizeof(_BMPINFOHEADER), w, -h, 1, 24, 0, 0, 0, 0, 0, 0)
    row = (w * 3 + 3) // 4 * 4
    buf = ctypes.create_string_buffer(row * h)
    gdi32.GetDIBits(hdc_mem, hbm, 0, h, buf, ctypes.byref(bmi), 0)
    user32.ReleaseDC(0, hdc_screen)
    gdi32.DeleteDC(hdc_mem)
    gdi32.DeleteObject(hbm)
    if not ok:
        return None
    return buf.raw, w, h


def _capture_hash(hwnd: int) -> str:
    """整窗内容 md5，用来判断「点完到底变没变」。抓不到返回空串。"""
    shot = _capture_pixels(hwnd)
    if shot is None:
        return ""
    return hashlib.md5(shot[0]).hexdigest()


def _refresh_link_visible(hwnd: int):
    """二维码是否已过期（=窗口里有没有蓝色「刷新」链接）。

    返回 True/False，抓不到图时返回 None（调用方按"不确定"处理，不点）。
    实测标定：过期帧在 x 38%-62%、y 50%-58% 区间有 75 个蓝色像素，
    正常帧同区间为 0。取阈值 8，留足抗噪余量。
    """
    shot = _capture_pixels(hwnd)
    if shot is None:
        return None
    raw, w, h = shot
    width = w
    stride = (w * 3 + 3) // 4 * 4
    x0, x1 = int(width * 0.38), int(width * 0.62) + 1
    y0, y1 = int(h * 0.50), int(h * 0.58) + 1
    hits = 0
    for y in range(y0, min(y1, h)):
        base = y * stride
        for x in range(x0, min(x1, width)):
            i = base + x * 3
            b, g, r = raw[i], raw[i + 1], raw[i + 2]
            if b > 140 and b - r > 55 and b - g > 35:
                hits += 1
                if hits >= 8:
                    return True
    return False


def _client_point(hwnd: int, width: int, height: int) -> tuple[int, int]:
    """把窗口相对比例换算成客户区坐标（PostMessage 用的是客户区坐标）。"""
    user32 = _u()
    crect = _RECT()
    user32.GetClientRect(hwnd, ctypes.byref(crect))
    cw = max(crect.right - crect.left, 1)
    ch = max(crect.bottom - crect.top, 1)
    return int(cw * REFRESH_REL_X), int(ch * REFRESH_REL_Y)


def _post_click(hwnd: int, x: int, y: int) -> None:
    """向窗口投递鼠标消息——断线会话里唯一有效的点击方式。"""
    user32 = _u()
    lp = (y << 16) | (x & 0xFFFF)
    user32.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lp)
    time.sleep(0.10)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.08)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)


def _mouse_click(hwnd: int, x: int, y: int) -> None:
    """真实鼠标注入（会话有输入桌面时才有效，断线时静默落空）。"""
    user32 = _u()
    origin = _POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    user32.SetCursorPos(origin.x + x, origin.y + y)
    time.sleep(0.15)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def _click_and_verify(log=None, *, require_expired: bool = True) -> tuple[bool, str]:
    """点一次「刷新」并验证二维码真的换了。返回 (ok, detail)。

    先判过期：企微只在码过期后才渲染「刷新」链接，正常码上点这一下什么都不会发生
    （21:14/21:15 两次「未生效」就是这么来的，不是点击失败，是没东西可点）。

    顺序：PostMessage（断线可用）→ 比对截图 → 没变则 mouse_event 兜底 → 再比对。
    两条路都不换图就如实返回失败原因，不假装成功。
    """
    win = _find_login_window()
    if not win:
        return False, "没找到企微登录窗（可能已登录，或窗口被隐藏）"
    hwnd, left, top, width, height = win
    if require_expired:
        expired = _refresh_link_visible(hwnd)
        if expired is False:
            return True, "二维码当前有效，企微不显示「刷新」；无需点击"
        if expired is None:
            return False, "截不到登录窗画面，无法判断二维码是否过期"
    x, y = _client_point(hwnd, width, height)
    before = _capture_hash(hwnd)

    try:
        _post_click(hwnd, x, y)
    except Exception as exc:  # noqa: BLE001
        return False, f"投递点击异常：{type(exc).__name__}: {exc}"
    if log:
        log(f"[qr-refresh] 登录窗 ({left},{top}) {width}x{height}，PostMessage 点击 ({x},{y})")
    time.sleep(_VERIFY_DELAY)
    after = _capture_hash(hwnd)
    if before and after and after != before:
        return True, "已点击刷新，二维码已更新（PostMessage）"

    try:
        _mouse_click(hwnd, x, y)
    except Exception as exc:  # noqa: BLE001
        return False, f"鼠标点击异常：{type(exc).__name__}: {exc}"
    if log:
        log("[qr-refresh] PostMessage 未生效，改用鼠标注入兜底")
    time.sleep(_VERIFY_DELAY)
    after2 = _capture_hash(hwnd)
    if after and after2 and after2 != after:
        return True, "已点击刷新，二维码已更新（鼠标注入）"
    if not before or not after:
        return True, "已投递点击，但无法截图验证（窗口未渲染）"
    return False, "点击已投递但二维码没变（企微界面可能未响应）"


def maybe_refresh_expired_qr(log=None) -> bool:
    """login_required 时调用：确认码真的过期才点「刷新」。

    返回 True 表示本次执行了点击动作。线程化执行，立即返回，不阻塞主循环。
    先判过期再点——正常码上没有「刷新」链接，盲点只会每 90 秒白忙一次。
    """
    global _last_click_ts
    if sys.platform != "win32":
        return False
    with _lock:
        if time.time() - _last_click_ts < REFRESH_COOLDOWN_SECONDS:
            return False
    win = _find_login_window()
    if not win:
        return False
    if _refresh_link_visible(win[0]) is not True:
        return False
    with _lock:
        if time.time() - _last_click_ts < REFRESH_COOLDOWN_SECONDS:
            return False
        _last_click_ts = time.time()

    def _worker():
        try:
            ok, detail = _click_and_verify(log=log, require_expired=False)
            if log:
                log(f"[qr-refresh] 自动刷新：{'成功' if ok else '未生效'} — {detail}")
        except Exception as exc:  # noqa: BLE001
            if log:
                log(f"[qr-refresh] 异常（忽略）：{exc!r}")

    threading.Thread(target=_worker, daemon=True).start()
    return True


def click_now(log=None) -> tuple[bool, str]:
    """网页手动请求刷新：同步点一次并验证，返回 (ok, detail)。

    与 maybe_refresh_expired_qr 的区别：
    - 同步：指令通道要拿结果回执，不能后台跑；
    - 跳过 90 秒冷却：这是用户主动点的；点完仍登记时间，避免自动流程紧接着再点；
    - 返回失败原因：找不到登录窗、点击没换图都如实回给网页，不假装成功。

    码还有效时企微没有「刷新」可点，此时返回 (True, "二维码当前有效…")——
    调用方照常截一帧上传，用户拿到的仍是最新画面。
    """
    global _last_click_ts
    if sys.platform != "win32":
        return False, "当前不是 Windows，无法点击登录窗"
    ok, detail = _click_and_verify(log=log)
    if ok:
        with _lock:
            _last_click_ts = time.time()
    return ok, detail

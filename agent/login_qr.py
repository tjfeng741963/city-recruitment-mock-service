"""企微登录二维码：截下来送到服务端，让用户在我们的网页上扫。

为什么需要
----------
专用机在云端（134.175.40.31 这类），没人能看到那块屏幕。企微被风控登出后
桌面会弹出扫码窗，但运营和客户都碰不到它——不把二维码送出去，自动回复就
只能无限期停摆，等现场有人去看屏幕。

链路
----
    企微登录窗 → PrintWindow 截图 → 缩到约 6 成 → PNG → base64
        → POST /api/v1/bridge/devices/{code}/login-qr（桥接令牌）
        → 网页设备页定时拉取 → 用户用手机扫

三条红线
--------
1. **绝不影响主循环**：截图/编码/上传任何一步失败都只记一行日志，异常不出本模块。
2. **只在 login_required 时动作**：别把正常聊天界面当二维码传上去。
3. **约 30 秒一次**：企微二维码约 2 分钟刷新，传太勤没必要，传太慢用户看到过期图。

恢复后要清掉服务端那张图——否则网页会一直显示一张已经无效的二维码，用户扫了没反应。
"""

from __future__ import annotations

import ctypes
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

# 上传间隔（秒）。二维码 2 分钟刷新一次，30 秒既能看到新码也不会刷屏。
PUSH_INTERVAL = 30.0

# pythonw 拉起时没有控制台，tasklist 会自己新建一个黑窗口；见 autopilot.py 的说明。
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# 缩小比例：登录窗原始约 380x520；高 DPI 下可能到 760x1040，
# 缩到 6 成仍是二维码可扫的清晰度，体积却降到三分之一。
SCALE = 0.6

# 登录窗类名（与 login_watch.py 保持一致）
LOGIN_CLASS = "WeChatLogin"

_CST = timezone(timedelta(hours=8))


def _now() -> float:
    return time.time()


def _iso_now() -> str:
    return datetime.now(_CST).isoformat(timespec="seconds")


def _wxwork_pids() -> set[int]:
    """WXWork.exe 的 pid 集合。与 login_watch 同一写法，失败返回空集。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, encoding="gbk", errors="ignore", timeout=10,
            creationflags=_CREATE_NO_WINDOW,
        ).stdout
    except Exception:  # noqa: BLE001
        return set()
    pids: set[int] = set()
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) > 1 and parts[1].isdigit():
            pids.add(int(parts[1]))
    return pids


def find_login_window() -> int:
    """只找登录窗（WeChatLogin），找不到返回 0。

    为什么不复用 login_watch 的 _find_window：那个优先返回主窗口——
    主窗口残留在后台时截出来是聊天列表，不是二维码。
    """
    if sys.platform != "win32":
        return 0
    pids = _wxwork_pids()
    if not pids:
        return 0
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
    except Exception:  # noqa: BLE001
        return 0
    from ctypes import wintypes as wt

    found: list[int] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _lparam):
        pid = wt.DWORD()
        try:
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        except Exception:  # noqa: BLE001
            return True
        if pid.value not in pids:
            return True
        buf = ctypes.create_unicode_buffer(128)
        try:
            user32.GetClassNameW(hwnd, buf, 128)
        except Exception:  # noqa: BLE001
            return True
        if buf.value == LOGIN_CLASS:
            found.append(int(hwnd))
            return False      # 找到一个就停
        return True

    try:
        user32.EnumWindows(_cb, 0)
    except Exception:  # noqa: BLE001
        return 0
    return found[0] if found else 0


class LoginQrPusher:
    """把登录二维码定期推到服务端。进程内一份，自己在内部做节流。"""

    def __init__(self) -> None:
        self._last_push = 0.0
        # 上一轮是不是登录态：用来识别「刚恢复」，恢复时清掉服务端旧图
        self._was_login_required = False
        self._last_error_logged = 0.0

    def reset(self) -> None:
        self._last_push = 0.0
        self._was_login_required = False
        self._last_error_logged = 0.0

    def tick(self, state: str, bridge, log=print) -> bool:
        """每个自检轮次调一次。返回是否真的上传了一帧。

        `bridge` 是 client.BridgeClient；None 或未配置时直接跳过。
        """
        try:
            return self._tick(state, bridge, log)
        except Exception as exc:  # noqa: BLE001 - 绝不能冒到主循环
            self._log_throttled(log, f"[登录二维码] 上传失败（忽略）：{type(exc).__name__}: {exc}")
            return False

    def _tick(self, state: str, bridge, log) -> bool:
        if state != "login_required":
            # 刚恢复：清掉服务端那张已经失效的二维码，免得网页一直显示
            if self._was_login_required and bridge is not None and getattr(bridge, "enabled", False):
                self._was_login_required = False
                self._last_push = 0.0
                try:
                    bridge.clear_login_qr()
                    log("[登录二维码] 已恢复登录，清除网页上的旧二维码")
                except Exception as exc:  # noqa: BLE001
                    self._log_throttled(log, f"[登录二维码] 清除失败（忽略）：{type(exc).__name__}: {exc}")
            return False

        self._was_login_required = True
        if bridge is None or not getattr(bridge, "enabled", False):
            return False
        if _now() - self._last_push < PUSH_INTERVAL:
            return False

        hwnd = find_login_window()
        if not hwnd:
            self._log_throttled(log, "[登录二维码] 看到登录态但没找到登录窗，等下一轮")
            return False

        import screenshot

        image_b64, width, height = screenshot.png_base64(hwnd, scale=SCALE)
        # PrintWindow 抓硬件加速窗口时常返回一整张纯色图（全黑/全白），压完只有
        # 几百字节。这种图发给用户等于让他扫一块黑屏，必须换全屏 BitBlt 再试。
        # 阈值取 4KB（base64 后）：真实的登录窗截图即便缩到 6 成也有 20KB 以上。
        if len(image_b64) < 4000:
            image_b64, width, height = screenshot.png_base64(hwnd, scale=SCALE, method="screen")
        bridge.upload_login_qr(image_b64, width, height, _iso_now())
        self._last_push = _now()
        log(f"[登录二维码] 已上传到网页（{width}x{height}，{len(image_b64) // 1024}KB）")
        return True

    def _log_throttled(self, log, message: str) -> None:
        """同一条错误 60 秒内只记一次，避免每轮刷屏。"""
        now = _now()
        if now - self._last_error_logged < 60:
            return
        self._last_error_logged = now
        try:
            log(message)
        except Exception:  # noqa: BLE001
            pass


__all__ = ["LoginQrPusher", "find_login_window", "PUSH_INTERVAL", "SCALE"]

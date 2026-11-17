"""企微掉登录：把窗口拉到前台 + 提醒扫码。

背景
----
autopilot 每 30 秒自检一次企微状态（online / hidden / login_required /
not_running）。状态变成 login_required（已退回登录页）时窗口常常躺在托盘里或
最小化着，用户毫无察觉，自动回复就静默停摆几十分钟。本模块干两件事：

1. 把企业微信窗口从托盘/最小化恢复、置前、尝试激活；
2. 打一行醒目的 ``[注意]`` 日志 + 系统提示音（``winsound.MessageBeep``）。

红线
----
- 只用 ``ctypes`` 调 user32，不引入第三方依赖（psutil 可选，没有就走 tasklist）；
- 窗口操作一律静默失败：权限不足、焦点被前台锁占用、非 Windows 都很常见，
  **绝不让异常冒到 autopilot 主循环**；
- 不弹阻塞对话框（会卡住主循环）；
- 防骚扰：只在「进入」login_required 的那一刻提醒，持续处于该状态时 120 秒内
  不重复；状态回到 online 时重置（下次掉线立刻再提醒）；
- 非 Windows（CI / Linux）导入不崩：win32 相关全部惰性加载。

集成方式（在 autopilot 自检处调用一行）
--------------------------------------
``agent/autopilot.py`` 主循环里，拿到 ``detect_wecom_state()`` 的结果后加一行即可
（本模块自带去抖，每轮都调也没关系）：

    from login_watch import alert_login_required
    ...
    state = detect_wecom_state()          # 已有
    alert_login_required(state, log=log)  # ← 就这一行

返回值：True = 这次完整触发了提醒（窗口已置前 + 日志 + 声音）；
False = 没触发（非登录态 / 冷却中 / 平台不支持），或提醒了但窗口没找到
（这种情况日志和声音照发，只是没能置前）。
"""

from __future__ import annotations

import ctypes
import subprocess
import sys
import time

# 同一状态两次提醒的最小间隔（秒）。30 秒一轮自检 → 120 秒 = 最多每 4 轮响一次。
COOLDOWN = 120.0

# 先按标题找（企微主窗口标题就是「企业微信」），老版本/国际版可能叫 WeCom。
WINDOW_TITLES = ("企业微信", "WeCom")

# 企微的窗口类名：主窗口 / 登录窗口。类名比标题稳，枚举进程时用它过滤。
MAIN_CLASS = "WeWorkWindow"
LOGIN_CLASS = "WeChatLogin"

SW_RESTORE = 9

_IS_WINDOWS = sys.platform == "win32"

# ── 进程内去抖状态（模块级，单进程一份）─────────────────────────────────────
_last_state: str | None = None
_last_alert_at: float = 0.0

_user32 = None


def _now() -> float:
    """单独抽出来，测试可以替换掉，不必真的 sleep。"""
    return time.time()


def reset() -> None:
    """清空去抖状态。正常进程不需要调，测试之间用它隔离。"""
    global _last_state, _last_alert_at
    _last_state = None
    _last_alert_at = 0.0


# ── user32 惰性加载 ─────────────────────────────────────────────────────────
def _api():
    """返回 user32 句柄；非 Windows 或加载失败返回 None。"""
    global _user32
    if not _IS_WINDOWS:
        return None
    if _user32 is None:
        try:
            _user32 = ctypes.WinDLL("user32", use_last_error=True)
        except Exception:  # noqa: BLE001 - 老系统/Wine 可能没有
            return None
    return _user32


# ── 找窗口 ─────────────────────────────────────────────────────────────────
def _wxwork_pids() -> set[int]:
    """WXWork.exe 的 pid 集合；psutil 可用就用它，否则 tasklist。"""
    pids = _pids_via_psutil()
    return pids or _pids_via_tasklist()


def _pids_via_psutil() -> set[int]:
    try:
        import psutil  # 可选依赖，缺了就走 tasklist
    except Exception:  # noqa: BLE001
        return set()
    try:
        return {
            int(proc.info["pid"])
            for proc in psutil.process_iter(["pid", "name"])
            if str(proc.info.get("name") or "").lower() == "wxwork.exe"
        }
    except Exception:  # noqa: BLE001
        return set()


def _pids_via_tasklist() -> set[int]:
    """纯查询，不碰窗口、不发输入事件（和 sender.py 同一写法）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="gbk",
            errors="ignore",
            timeout=10,
        ).stdout
    except Exception:  # noqa: BLE001
        return set()
    pids: set[int] = set()
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) > 1 and parts[1].isdigit():
            pids.add(int(parts[1]))
    return pids


def _find_window_by_pid(user32) -> int:
    """EnumWindows 里挑企微的顶层窗口：主窗口优先，其次登录窗；可见的优先。"""
    from ctypes import wintypes as wt

    pids = _wxwork_pids()
    if not pids:
        return 0

    candidates: list[tuple[int, int, int]] = []  # (类名优先级, 不可见优先级, hwnd)

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
        cls = buf.value
        if cls not in (MAIN_CLASS, LOGIN_CLASS):
            return True
        try:
            visible = 0 if user32.IsWindowVisible(hwnd) else 1
        except Exception:  # noqa: BLE001
            visible = 1
        candidates.append((0 if cls == MAIN_CLASS else 1, visible, int(hwnd)))
        return True

    try:
        user32.EnumWindows(_cb, 0)
    except Exception:  # noqa: BLE001
        return 0
    if not candidates:
        return 0
    candidates.sort()
    return candidates[0][2]


def _find_window() -> int:
    """企微窗口句柄；找不到返回 0，绝不抛异常。"""
    user32 = _api()
    if user32 is None:
        return 0
    for title in WINDOW_TITLES:
        try:
            hwnd = int(user32.FindWindowW(None, title))
        except Exception:  # noqa: BLE001
            hwnd = 0
        if hwnd:
            return hwnd
    try:
        return _find_window_by_pid(user32)
    except Exception:  # noqa: BLE001
        return 0


def _bring_to_front(hwnd: int) -> bool:
    """恢复 + 置前 + 激活。返回是否（看起来）成功了，绝不抛异常。"""
    user32 = _api()
    if not hwnd or user32 is None:
        return False
    try:
        user32.ShowWindow(hwnd, SW_RESTORE)
    except Exception:  # noqa: BLE001
        pass
    # 从托盘/最小化回来时窗口还没「活」，先提到最上层再抢前台，成功率高一点
    try:
        user32.BringWindowToTop(hwnd)
    except Exception:  # noqa: BLE001
        pass
    try:
        return bool(user32.SetForegroundWindow(hwnd))
    except Exception:  # noqa: BLE001 - 前台锁 / 权限不足，静默失败
        return False


# ── 提醒 ───────────────────────────────────────────────────────────────────
def _beep() -> bool:
    """系统提示音；非 Windows 或 winsound 不可用时静默跳过。"""
    if not _IS_WINDOWS:
        return False
    try:
        import winsound
    except Exception:  # noqa: BLE001
        return False
    try:
        winsound.MessageBeep()
        return True
    except Exception:  # noqa: BLE001
        return False


def _build_message(window_ok: bool) -> str:
    msg = "[注意] 企业微信已退出登录，请扫码重新登录"
    if window_ok:
        return msg + "（已把窗口拉到前台）"
    return msg + "（未能自动置前，请手动切到企业微信）"


def alert_login_required(state: str, log=print) -> bool:
    """状态为 login_required 时：拉窗口到前台 + 日志 + 提示音。

    去抖规则：
    - 「进入」login_required 时立刻提醒一次；
    - 持续处于该状态时，COOLDOWN（120s）内不重复，过了冷却再响；
    - 状态回到 online 时清空计时，下次掉线立刻提醒。

    返回 True 表示这次完整触发（窗口已置前 + 日志 + 声音）；False 表示没触发，
    或提醒发了但窗口没找到/没抢到前台——调用方不需要区别处理，任何情况下都不抛异常。
    """
    global _last_state, _last_alert_at

    if state != "login_required":
        _last_state = state
        if state == "online":
            _last_alert_at = 0.0  # 已恢复：下次掉线立刻再提醒
        return False

    now = _now()
    entered = _last_state != "login_required"
    _last_state = "login_required"

    if not entered and (now - _last_alert_at) < COOLDOWN:
        return False  # 还是那个登录页，冷却期内不打扰

    # 窗口找不到也要提醒：用户至少得知道该扫码了
    window_ok = False
    try:
        hwnd = _find_window()
        if hwnd:
            window_ok = _bring_to_front(hwnd)
    except Exception:  # noqa: BLE001
        window_ok = False

    try:
        log(_build_message(window_ok))
    except Exception:  # noqa: BLE001 - 调用方传进来的 log 出错也不能影响主循环
        pass
    _beep()

    _last_alert_at = now
    return bool(window_ok)

"""给客户设置备注（企微 UI 路线，2026-11-25 实测打通）。

为什么需要它
------------
真同名撞车时（两个不同的人都叫「小王」），搜索框只给一个结果列表，程序分不清
哪条才是目标会话。给客户设一个唯一备注后：会话显示名变成备注 → 搜索唯一命中，
守卫也不再判撞车。备注本身就是「人工可读的唯一标识」，比任何内部 id 都稳。

实测路径（1044×694 窗口下逐屏截图确认）
--------------------------------------
    通讯录 → 搜索框（清空后输入名字）→ 点第一条结果
    → 资料卡「设置备注和描述」→ 备注名输入框 → 确定

坑
--
- 搜索框会保留上次输入：不先 Ctrl+A + Delete，会拼成 "GarboGarbo" 搜不到
- 资料卡和弹窗都是「窗口居中」布局，坐标按窗口宽高比例算，不写死像素
- 成功后**回读本地库**（external_user_relation_v3.remarks）确认真的写进去了，
  不看界面猜

约束
----
只新增「点击 / 快捷键 / 粘贴」三类既有动作，不引入新的输入方式；
整个过程由指令队列驱动，与消息发送串行，不会和发消息抢焦点。
"""
from __future__ import annotations

import ctypes
import time
from typing import Callable

from wecom_io_core import win

# 相对窗口宽高的比例（实测 1044×694，换算成比例后换窗口尺寸也不跑偏）
_R_SIDEBAR_CONTACTS = (0.034, 0.576)   # 左侧「通讯录」
_R_SEARCH = (0.278, 0.053)             # 通讯录搜索框
_R_FIRST_RESULT = (0.259, 0.127)       # 搜索结果第一条
_R_SET_REMARK = (0.575, 0.291)         # 资料卡「设置备注和描述」
_R_DIALOG_REMARK_INPUT = (0.0, -0.232)  # 弹窗内备注名输入框（相对弹窗中心）
_R_DIALOG_OK = (-0.073, 0.291)          # 弹窗内「确定」


def _click_ratio(rect: tuple[int, int, int, int], ratio: tuple[float, float]) -> None:
    left, top, width, height = rect
    win.click(int(left + width * ratio[0]), int(top + height * ratio[1]))


def _click_dialog(rect: tuple[int, int, int, int], offset: tuple[float, float]) -> None:
    """弹窗按窗口居中：中心点 + 偏移（偏移按宽高比例给）。"""
    left, top, width, height = rect
    win.click(int(left + width / 2 + width * offset[0]), int(top + height / 2 + height * offset[1]))


def read_remark(user_id: str) -> str | None:
    """回读本地库里的备注；读不到返回 None（区别于「读到空字符串」）。"""
    try:
        from wecom_io_core.store import Store

        con = Store()._conn("user.db")
        if con is None:
            return None
        try:
            row = con.execute(
                "select remarks from external_user_relation_v3 where user_id=?", (str(user_id),)
            ).fetchone()
            return str(row[0] or "") if row else ""
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        return None


def _force_foreground(hwnd: int) -> bool:
    """把窗口强行提到前台并置顶。

    直接 SetForegroundWindow 经常被 Windows 拒绝（调用进程不是当前前台，
    返回成功但窗口没上来）。这里用 SetWindowPos 置顶 + AttachThreadInput
    把输入队列挂到前台线程上，再 SetForegroundWindow——这是不注入的前提下
    唯一稳定的办法（2026-11-26 实测：直接调必然「抢不到前台」）。
    """
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
    except Exception:  # noqa: BLE001
        return False
    SW_RESTORE = 9
    HWND_TOP = 0
    SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0040
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    fg = user32.GetForegroundWindow()
    if fg == hwnd:
        return True
    cur_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    tgt_tid = user32.GetWindowThreadProcessId(hwnd, None)
    attached = False
    if cur_tid and tgt_tid and cur_tid != tgt_tid:
        attached = bool(user32.AttachThreadInput(cur_tid, tgt_tid, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(cur_tid, tgt_tid, False)
    time.sleep(0.25)
    return user32.GetForegroundWindow() == hwnd


def set_remark(
    name: str,
    remark: str,
    log: Callable[[str], None] = lambda _s: None,
    *,
    user_id: str = "",
) -> tuple[bool, str]:
    """把客户「name」的备注改成「remark」。

    user_id 给了就回读数据库校验（强烈建议给）；没给只能按界面走完就报成功。
    """
    name = (name or "").strip()
    remark = (remark or "").strip()
    if not name:
        return False, "缺少客户名，无法定位"
    if not remark:
        return False, "备注不能为空"

    target = win.find_window()
    if not target:
        # 远程桌面断开 / 窗口最小化到托盘时找不到窗口，界面自动化一律不能跑
        return False, "企微窗口不可见（远程桌面可能已断开或窗口最小化），备注未设置"
    hwnd = target["hwnd"]
    rect = target["rect"]
    try:
        # 直接 ensure_foreground 常被系统拒绝，这里用 AttachThreadInput 强抢
        if not (_force_foreground(hwnd) or win.ensure_foreground(hwnd, tries=3)):
            return False, "抢不到前台，设置备注中止"
        if not win.wait_visible(hwnd, timeout=8):
            return False, "企微窗口不可见，设置备注中止"

        # 1) 通讯录
        _click_ratio(rect, _R_SIDEBAR_CONTACTS)
        time.sleep(0.9)

        # 2) 搜索框：先清空再输入（残留会拼成 GarboGarbo 这种搜不到的词）
        _click_ratio(rect, _R_SEARCH)
        time.sleep(0.35)
        win.hotkey("ctrl", "a")
        win.tap("delete")
        time.sleep(0.2)
        win.set_clipboard(name)
        win.hotkey("ctrl", "v")
        time.sleep(1.5)

        # 3) 第一条结果
        _click_ratio(rect, _R_FIRST_RESULT)
        time.sleep(1.1)

        # 4) 资料卡「设置备注和描述」
        _click_ratio(rect, _R_SET_REMARK)
        time.sleep(1.1)

        # 5) 弹窗：备注名 → 确定
        _click_dialog(rect, _R_DIALOG_REMARK_INPUT)
        time.sleep(0.3)
        win.hotkey("ctrl", "a")
        win.tap("delete")
        time.sleep(0.2)
        win.set_clipboard(remark)
        win.hotkey("ctrl", "v")
        time.sleep(0.4)
        _click_dialog(rect, _R_DIALOG_OK)
        time.sleep(1.2)

        if not user_id:
            log(f"[备注] {name} → {remark} 已提交（未回读校验）")
            return True, f"已设置备注 {remark}（未校验）"

        # 6) 回读数据库确认（界面会说谎，库不会）
        for attempt in range(4):
            current = read_remark(user_id)
            if current == remark:
                log(f"[备注] {name} → {remark} 已写入并回读确认")
                return True, f"已设置备注 {remark}"
            if attempt < 3:
                time.sleep(0.6)
        return False, f"已操作界面但库里备注仍是「{read_remark(user_id) or '空'}」，请人工确认"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        try:
            win.release_modifiers()
        except Exception:  # noqa: BLE001
            pass

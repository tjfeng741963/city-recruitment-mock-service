"""发送：严格照搬 wecom-group-sender 的动作序列。

动作序列（与原项目一一对应，不额外加键）：
  0. 检查 WXWork.exe 是否存活 → 激活窗口 → 等可见
  1. Ctrl+F                          唤出搜索
  2. Ctrl+A → Ctrl+V                 粘贴会话名（先全选，避免与上次搜索拼接）
  3. 等搜索结果                       search_delay
  4. Enter                           进第一个搜索结果
  5. Ctrl+A → Delete                 清空输入框残留草稿（焦点此时在输入框）
  6. 等可见 → Ctrl+V                 粘贴正文
  7. Ctrl+A → Ctrl+C 回读            哨兵法确认字真的进了输入框
  8. 等可见 → Enter                  发送
  外层整体重试 2 次；任一步失败先 Esc + 释放修饰键再退出。

与原项目的唯一差异：发送后用解密库（含 WAL）回读，确认消息真的落到目标会话。
这是本项目「读 + 写」合体的价值所在，不额外产生任何按键。

⚠️ 本模块会模拟键鼠，属于企业微信协议的违规操作，实测会触发风控处置。
"""
from __future__ import annotations

import time
from typing import Callable

from . import win

SENTINEL = "__WECOM_IO_SENTINEL__"
FAST_MODE = True           # 与原项目一致：单条 5 秒内结束，快于风控 9 秒处置窗口
SEARCH_DELAY = 0.8         # 粘贴会话名后等搜索结果
RESULT_DELAY = 1.0         # 回车进会话后等渲染
MAX_ATTEMPTS = 2           # 原项目 FAST_MODE 下也是 2 次整段重试


def _log_default(msg: str) -> None:
    print(msg, flush=True)


def _norm(s: str) -> str:
    """企微输入框是富文本，回车会被规范成 \r\n，比对时统一。"""
    return (s or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _esc_cleanup(hwnd: int) -> None:
    """原项目 esc_cleanup：Esc 关掉搜索框，再释放可能卡住的修饰键。"""
    try:
        win.tap("esc")
    except Exception:
        pass
    try:
        win.release_modifiers()
    except Exception:
        pass
    time.sleep(0.3)


def _wait_visible(hwnd: int, stage: str) -> str | None:
    """等窗口可见；不可见说明被风控隐藏了，直接返回错误文案。"""
    if win.wait_visible(hwnd, timeout=15.0):
        return None
    return f"企微窗口持续隐藏（{stage}），已中止"


def verify_input_box(text: str, retries: int = 5) -> tuple[bool, str]:
    """原项目 verify_input_box 的等价实现：哨兵法回读输入框。

    先把剪贴板覆盖成哨兵，再 Ctrl+A / Ctrl+C：
      - 读回哨兵 → Ctrl+C 没复制到东西（焦点不在输入框或为空）→ 重试
      - 读回等于正文 → 通过
      - 其他内容 → 焦点在别处（比如消息列表）→ 重试
    """
    sentinel_hit = False
    got = ""
    for attempt in range(retries):
        win.set_clipboard(SENTINEL)
        time.sleep(0.12)
        win.hotkey("ctrl", "a")
        time.sleep(0.2)
        win.hotkey("ctrl", "c")
        time.sleep(0.3)
        got = win.get_clipboard()
        if got and _norm(got) == _norm(text):
            return True, "粘贴已确认"
        if got and got.strip() == SENTINEL:
            sentinel_hit = True
            time.sleep(0.4)
            continue
        sentinel_hit = False
        if attempt < retries - 1:
            time.sleep(0.4)
    if sentinel_hit:
        return False, "焦点未落在输入框（Ctrl+C 未生效，剪贴板仍是哨兵）"
    return False, f"输入框内容不符：{got[:40]!r}"


def _send_once(
    hwnd: int,
    name: str,
    text: str,
    dry: bool,
    log: Callable[[str], None],
) -> tuple[bool, str]:
    """单次完整流程，返回 (ok, status)。对标原项目 _send_once。"""

    # 0. 进程是否还活着（原项目第一步就查这个）
    if not win.wxwork_alive():
        return False, "企业微信已退出，停止发送"

    if not win.ensure_foreground(hwnd, tries=4):
        return False, "抢不到前台，已中止"
    if _wait_visible(hwnd, "激活后") is not None:
        return False, "企微窗口持续隐藏（可能被防自动化机制隐藏），无法发送"
    time.sleep(0.3 if FAST_MODE else 0.5)
    log("步骤0 前台就位、窗口可见")

    # 1. Ctrl+F 唤搜索
    win.hotkey("ctrl", "f")
    time.sleep(0.4 if FAST_MODE else 0.6)

    # 2. 全选 + 粘贴会话名
    win.set_clipboard(name)
    time.sleep(0.1)
    win.hotkey("ctrl", "a")
    time.sleep(0.1)
    win.hotkey("ctrl", "v")

    # 3. 等搜索结果
    time.sleep(SEARCH_DELAY)

    # 4. Enter 进第一个结果
    win.tap("enter")
    time.sleep(RESULT_DELAY)
    log("步骤1 已回车进入会话")

    if dry:
        return True, "DRY-RUN：已进会话，未发送（未清空输入框、未粘贴）"

    # 5. 清空输入框残留草稿（原项目明确：此时焦点默认已在输入框，不要点坐标）
    win.hotkey("ctrl", "a")
    time.sleep(0.08)
    win.tap("delete")
    time.sleep(0.08)
    log("步骤2 已清空输入框残留")

    # 6. 等可见 → 粘贴正文
    if _wait_visible(hwnd, "粘贴前") is not None:
        return False, "企微窗口持续隐藏，粘贴前中止"
    win.set_clipboard(text)
    time.sleep(0.1)
    win.hotkey("ctrl", "v")
    time.sleep(0.3 if FAST_MODE else 0.5)

    # 7. 回读校验
    passed, hint = verify_input_box(text, retries=5)
    if not passed:
        return False, f"输入框校验：{hint}"
    log(f"步骤3 输入框校验通过（{hint}）")

    # 8. 等可见 → Enter 发送
    if _wait_visible(hwnd, "发送前") is not None:
        return False, "企微窗口持续隐藏，发送前中止"
    win.tap("enter")
    time.sleep(0.4 if FAST_MODE else 0.8)
    log("步骤4 已回车发送")
    return True, "已发送"


def send(
    store,
    name: str,
    text: str,
    expect_id: str = "",
    log: Callable[[str], None] = _log_default,
    dry: bool = False,
    verify_db: bool = True,
) -> dict:
    """发一条消息到指定会话，返回 {ok, conversation_id, detail}。"""
    name = (name or "").strip()
    text = (text or "").strip()
    if not name or not text:
        return {"ok": False, "conversation_id": "", "detail": "会话名或内容为空"}

    target = win.find_window()
    if not target:
        return {"ok": False, "conversation_id": "", "detail": "没找到企业微信窗口"}
    hwnd = target["hwnd"]

    log(f"开始发送 -> 「{name}」：{text}")
    before = _sent_snapshot(store) if verify_db and not dry else set()

    ok = False
    status = ""
    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            if attempt > 1:
                log(f"第 {attempt} 次整段重试")
            ok, status = _send_once(hwnd, name, text, dry, log)
            if ok:
                break
            log(f"本轮失败：{status}")
            _esc_cleanup(hwnd)
            time.sleep(0.5)
    finally:
        win.release_modifiers()

    if not ok:
        return {"ok": False, "conversation_id": "", "detail": status}

    if dry:
        return {"ok": True, "conversation_id": "", "detail": status}

    if not verify_db:
        return {"ok": True, "conversation_id": "", "detail": status + "（未回读）"}

    # ---------- 发送后回读解密库（含 WAL），确认落点 ----------
    try:
        store.refresh()
        cid = _find_new_sent(store, text, before)
    except Exception as exc:
        return {"ok": True, "conversation_id": "", "detail": f"已发送但回读失败：{exc}"}

    if not cid:
        return {"ok": True, "conversation_id": "",
                "detail": "已发送，但库里还没读到（WAL 可能有延迟），请人工看一眼"}

    if expect_id and cid != expect_id:
        return {"ok": False, "conversation_id": cid,
                "detail": f"发到了别的会话！期望 {expect_id}，实际 {cid}"}

    log(f"步骤5 回读确认：消息已落到 {cid}")
    return {"ok": True, "conversation_id": cid, "detail": "已发送并回读确认"}


def _sent_snapshot(store) -> set:
    """发送前记录「我」已发出的消息主键，用于发后只找新增的那条。"""
    con = store._conn("message.db")
    if not con:
        return set()
    try:
        me = store.self_id()
        rows = con.execute(
            "select rowid from message_table where sender_id = ? "
            "order by send_time desc limit 200", (me,)
        ).fetchall()
        return {r[0] for r in rows}
    except Exception:
        return set()
    finally:
        con.close()


def _find_new_sent(store, text: str, before: set) -> str:
    """在「我发出的、发送前不存在」的消息里找内容匹配的那条，返回会话 id。"""
    from .store import _pb_text

    con = store._conn("message.db")
    if not con:
        return ""
    try:
        me = store.self_id()
        rows = con.execute(
            "select rowid, conversation_id, content from message_table "
            "where sender_id = ? order by send_time desc limit 200", (me,)
        ).fetchall()
    except Exception:
        rows = []
    finally:
        con.close()

    for r in rows:
        if r["rowid"] in before:
            continue
        if _pb_text(r["content"]).strip() == text:
            return r["conversation_id"]
    return ""

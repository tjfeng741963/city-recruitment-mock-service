"""自动回复：轮询本地解密库 → 登记到 reply_log → 按队列逐条回复。

设计约束（照 wecom_io 的做法，不自己发明）：
- 读：只读解密后的 SQLite（含 WAL 叠加），**零输入事件**
- 写：完整交给 `wecom_io_core.send.send()`，动作序列一行不改
- **所有会话**都监听（排除企微自带的应用/系统会话），按到达顺序排队
- 记录：本地 `reply_log.db`，状态 pending/sent/failed/skipped
- **重启后自动补发** pending 与 failed 的条目

场景与回复：
    该会话还没回过 → reply_first（默认 "1"）
    已经回过       → reply_next （默认 "233"）

用法：
    uv run python autopilot.py --watch        # 常驻
    uv run python autopilot.py --once         # 扫一轮
    uv run python autopilot.py --once --dry   # 只登记不发送
    uv run python autopilot.py --list         # 看回复历史
    uv run python autopilot.py --reset        # 把待发条目全部作废

上报与心跳（纯 HTTP，零键鼠事件）：
    每 30 秒向服务端发一次设备心跳 + 增量上报本地新消息；
    同一周期顺带向 Node 桥接（4222）报一次设备心跳（双通道）；
    主循环每轮先自检企微状态，非 online 时**一条都不发**，只继续心跳。

人工指令（4222 控制台主动发消息）：
    每 10 秒向桥接 claim 一条人工指令，用同一套键鼠发送函数真实发出，
    成功/失败都回执（receipts）；与自动回复串行 + 共享冷却，不会同时抢键鼠。
"""

from __future__ import annotations

import argparse
import ctypes
import getpass
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
from copy import deepcopy
import time
import traceback
from contextlib import closing, contextmanager
from ctypes import wintypes as wt
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PureWindowsPath
from time import monotonic
from urllib.parse import quote
from urllib.error import HTTPError
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# 计划任务用 pythonw.exe 拉起本进程，进程本身没有控制台。此时 subprocess 启动
# tasklist / python.exe 这类控制台程序，Windows 会为每个子进程新建一个控制台窗口
# ——屏幕上就是「隔一会儿跳一下的黑窗口」（每轮自检闪一次）。CREATE_NO_WINDOW
# 让子进程继承「无控制台」，不再弹窗；非 Windows 平台取 0，参数无效但无害。
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

LOG_DIR = ROOT / "logs"
LOG_PATH = LOG_DIR / "run.log"
# Small local protocol consumed by the Windows management window.  It is kept
# next to the existing logs so it survives code updates but is never packaged
# as source or sent to the server.
CLIENT_STATE_PATH = LOG_DIR / "client-state.json"
# 单文件 20MB，保留 5 份（run.log.1 .. run.log.5），总上限约 120MB。
LOG_MAX_BYTES = int(os.environ.get("AGENT_LOG_MAX_BYTES", 20 * 1024 * 1024))
LOG_BACKUP_COUNT = max(1, int(os.environ.get("AGENT_LOG_BACKUPS", 5)))
_log_lock = threading.Lock()


def write_client_state(
    status: str,
    *,
    detail: str = "",
    wecom_state: str | None = None,
    error: str = "",
) -> None:
    """Publish startup/business readiness for the local Windows manager.

    The file is deliberately written atomically.  A manager reading during a
    transition sees either the previous complete state or the new complete
    state, never a half-written JSON document.  State writes are best effort:
    they must not turn a login or database problem into a second crash.
    """
    if status not in {"starting", "waiting_wecom", "waiting_login", "initializing", "ready", "failed", "stopped"}:
        raise ValueError(f"invalid client state: {status}")
    payload = {
        "status": status,
        "pid": os.getpid(),
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "detail": str(detail or ""),
    }
    if wecom_state:
        payload["wecom_state"] = wecom_state
    if error:
        payload["error"] = str(error)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CLIENT_STATE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, CLIENT_STATE_PATH)
    except Exception:  # noqa: BLE001
        pass

# pythonw.exe 启动时没有控制台，sys.stdout / sys.stderr 是 None：print、reconfigure
# 都会抛异常。2026-11-16 实测这样跑一轮日志就全丢、drain 循环还会被日志异常打断。
# 统一兜底成空写入器，真正的日志由 log() 直接落文件。
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

from wecom_io_core import win  # noqa: E402

win.set_dpi_aware()

import compat  # noqa: E402
import echo_guard  # noqa: E402
import login_watch  # noqa: E402
import login_qr  # noqa: E402
import login_refresh  # noqa: E402
import login_code  # noqa: E402
import media_fetch  # noqa: E402
import reply_store as rlog  # noqa: E402
import client as agent_client  # noqa: E402
import register as agent_register  # noqa: E402
import remote_config as remote_cfg  # noqa: E402
import favorite_sync  # noqa: E402
import flow_state as flow_state_mod  # noqa: E402

# 剪贴板兼容 + 长消息解析 + 进会话后点输入框。
# 抢前台仍用 core/win.py 原版（ShowWindow + AttachThreadInput）；compat 里
# 自己加 Alt / 点标题栏的版本会把焦点带偏，实测必失败，所以不启用。
compat.apply()
compat.apply_pb_text()   # 长消息（>127 字节）的长度前缀不是合法 UTF-8，原解析会丢成空
# 2026-11-07 实测：本版企业微信回车进会话后焦点不会自动落在输入框，
# 后续 Ctrl+A/Delete/Ctrl+V 全落在别处，verify_input_box 永远读到哨兵，
# 发送在「输入框校验」处中止。这个补丁本来就是为这个现象写的，之前被
# test_autopilot_sender_baseline 冻结；现在解冻（只解这一个，不动动作序列）。
compat.apply_click_input()
# 单一比例点会打偏（会话列表宽度、窗口布局变化）：校验失败时换候选点重试。
compat.apply_input_focus_retry()

from wecom_io_core import send as core_send  # noqa: E402
from wecom_io_core.store import Store, find_data_dir, _pb_text, direction_of  # noqa: E402
import location_card  # noqa: E402  # 原生位置卡：按坐标生成并粘贴发送
import remark as remark_ui  # noqa: E402  # 给客户设置备注（同名撞车时用）

# 企微自带的应用/系统会话，前缀命中就不回复
SYSTEM_PREFIXES = (
    "Y:", "E:", "M:", "O:",
    "MAIL", "CLOUD_DISK_ASSIST", "APPROVAL", "WORK_JOURNAL", "ANNOUNCE",
)

# 官方服务号：id 也是 S: 开头，只能按名字排除
SYSTEM_NAMES = (
    "企业微信团队", "我的客服", "微信团队", "服务通知", "通讯录助手",
    "文件传输助手", "企业微信", "智能总结", "智能机器人",
)

DEFAULTS = {
    "target": "all",
    "data_dir": "",
    "reply_first": "1",
    "reply_next": "233",
    "interval": 3.0,
    "cooldown": 8.0,
    "backfill_hours": 1.0,   # 首次初始化时，只把最近 N 小时的消息当作待补发
    "brain": None,           # {"mode":"kb","base_url":...} 时走知识库，否则固定文本
    "register_key": "",      # 空=关闭自注册；填了就在缺 token 时自动注册
    "device_name": "",       # 注册时展示的名字，留空用 device_code
}

# 进程退出码：企微账号目录变了，需要守护进程（计划任务）用新进程重新解析。
# 用非 0 值是为了让「正常退出」和「需要重启」在日志/计划任务里能分辨。
ACCOUNT_SWITCH_EXIT_CODE = 3


def account_switched(data_dir):
    """当前生效的企微账号目录是否已经不是 data_dir 了；变了就返回新目录。

    为什么需要（远端 2026-11-17 线上实测，合并时移植）：企微每个账号在
    Documents/WXWork/<vid>/Data 下有独立数据目录，Store 只在**启动时**解析一次，
    之后主循环一直盯着这一个目录。换账号（退登录再扫码）后旧目录不再写入，
    wal_signature 永远不变 → 扫不到任何新消息，日志只有「上报：无新增消息」，
    看起来像客户端在正常工作。只做判断不做热切换：换账号等于整套上下文都换，
    直接退出（退出码 3）让计划任务重新拉起最稳。
    """
    if not data_dir:
        return None
    try:
        current = find_data_dir()
    except Exception:  # noqa: BLE001 目录读不到就当下次再说，绝不能因此崩掉
        return None
    if not current:
        return None
    try:
        if Path(data_dir).resolve() == Path(current).resolve():
            return None
    except OSError:
        return None
    return current


_last_reply_at = 0.0
# 连续发送失败计数（自动回复 drain 用）。失败也消耗冷却，且连续失败把间隔
# 拉长到最多 4 倍：2026-11-16 实测失败"零成本"立即重试下一个会话，3 秒内
# 对企微连做 3 次键鼠发送，正是触发风控掉登录的操作模式。
_consecutive_send_failures = 0

# 「落点不确定」和「链路不可用」要分开算（2026-11-24）：
# 键鼠链路正常、只是回车后消息落到了别的会话（搜索命中歧义/换账号残留），
# 说明输入框、前台、窗口都是好的，下一条消息会重新搜索定位。
# 之前这种也算进 _consecutive_send_failures，一次发错就把全局自动回复锁死
# （reception_ready 直接返回 auto_send_failed），累计到 2 还会误判成
# login_required 去推登录二维码——业务整体停摆，比个别会话发错更严重。
# 现在这类只把该会话 hold 住，不影响全局发送能力。
_TARGET_MISS_HINTS = ("回读发现消息落到其他会话", "未回读到目标会话中唯一的新消息")


def _is_target_miss(detail: str) -> bool:
    """落点不确定（不是链路坏了）。"""
    return any(hint in (detail or "") for hint in _TARGET_MISS_HINTS)

# ── 人工指令（4222 控制台主动发消息）────────────────────────────────────────
# 主循环里与自动回复串行执行（同一个线程），共享 _last_reply_at 冷却，
# 保证任意时刻只有一个键鼠发送者。轮询按时间戳判断，不额外起线程。
CLAIM_INTERVAL = 10.0
_last_claim_at = 0.0
# 指令泵自检日志节流：登录态下领不到刷新指令时，5 分钟记一行，
# 让「网页点了刷新、客户端到底有没有来领」这件事在日志里能查。
_last_pump_log_at = 0.0
_last_ghost_cleanup_at = 0.0
_last_ghost_cleanup_at = 0.0
# 泵入口探针节流（60 秒一行，pump_safely 用）
_last_pump_entry_at = 0.0
_last_receipt_retry_at = 0.0
RECEIPT_RETRY_INTERVAL = 10.0

# ── 上报与心跳 ───────────────────────────────────────────────────────────────
# 只做 HTTP，不产生任何键鼠事件。失败一律忽略，下一轮自然补。
REPORT_STATE = ROOT / ".report_state.json"   # 游标 + 上次成功的 device_code
# 已发过「加好友首句」的会话集合。放本地文件而不是只放内存：重启客户端很常见，
# 只放内存会在重启后把老客户当新好友重新打招呼（对方看到两条首句）。
GREET_STATE = ROOT / ".greeted.json"
GREET_STATE_LIMIT = 2000                     # 只留最近 N 个会话，文件不会无限长
REPORT_INTERVAL = 30.0                       # 心跳/上报间隔（按时间戳判断，不 sleep）
RECOVERY_REPLY_MAX_AGE = 3600
REPORT_MAX_MESSAGES = 50                     # 单次上报最多条数
REPORT_FIRST_WINDOW = 24 * 3600              # 首次没有游标时只补最近 24 小时

# 最近一次发送错误，随心跳上报（契约里截断 200 字）
_last_error = ""
# 上一次"因掉线暂停发送"的日志时间，避免每轮刷屏
_last_block_log = 0.0
_last_contact_scan_error_at = 0.0

# ── 桥接心跳（Node 桥 4222，与主心跳同一周期、同一线程触发）──────────────────
# 桥只认 online/offline/scanning。映射要保守：只有确认 online 才报 online，
# hidden / login_required / not_running / unknown 一律 offline（宁可显示掉线）。
BRIDGE_STATE_MAP = {"online": "online"}


def map_bridge_state(wecom_state: str) -> str:
    return BRIDGE_STATE_MAP.get(wecom_state, "offline")

# 自检状态的中文说明，只用于日志
WECOM_STATE_TEXT = {
    "online": "正常",
    "login_required": "已退回登录页，需扫码",
    "not_running": "WXWork.exe 没在跑",
    "hidden": "窗口被隐藏，可能已被风控",
    "unknown": "探测不到窗口",
}

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_user32.GetForegroundWindow.restype = wt.HWND
_user32.GetWindowThreadProcessId.argtypes = (wt.HWND, ctypes.POINTER(wt.DWORD))
_user32.GetClassNameW.argtypes = (wt.HWND, wt.LPWSTR, ctypes.c_int)


_PHONE_RE = re.compile(r"(?<!\d)(1[3-9]\d{9})(?!\d)")
_ID_RE = re.compile(r"(?<!\d)(\d{17}[\dXx])(?!\d)")
_SENSITIVE_FIELDS = {"content", "text", "reply_text", "preview", "reason", "error", "detail"}
_SCOPE_PREFIXES = (
    ("[心跳]", "heartbeat"),
    ("[桥接]", "bridge"),
    ("[上报]", "ingest"),
    ("[指令]", "manual"),
    ("[回执]", "manual"),
    ("[自检]", "wecom"),
    ("[媒体]", "media"),
    ("[远端配置]", "config"),
    ("[brain]", "flow"),
    ("[flow]", "flow"),
    ("[kb]", "flow"),
    ("[首句]", "flow"),
    ("[线索]", "leads"),
)


def _redact_text(text: str, limit: int | None = None) -> str:
    """日志里的客户内容先打码；limit 用于截断，避免整段回复落盘。"""
    out = _PHONE_RE.sub(lambda m: f"{m.group(1)[:3]}****{m.group(1)[-4:]}", text or "")
    out = _ID_RE.sub(lambda m: f"{m.group(1)[:4]}**********{m.group(1)[-4:]}", out)
    if limit is not None and len(out) > limit:
        return out[:limit] + f"…({len(out)}字)"
    return out


def _infer_level(msg: str) -> str:
    if "Traceback" in msg:
        return "error"
    if any(word in msg for word in ("异常", "失败", "错误", "冲突", "超时", "拒绝", "中止")):
        return "warning"
    return "info"


def _infer_scope(msg: str) -> str:
    for prefix, scope in _SCOPE_PREFIXES:
        if msg.startswith(prefix) or f" {prefix}" in msg:
            return scope
    return ""


def _rotate_log_locked() -> None:
    """调用方已持有 _log_lock；失败绝不抛，日志不能影响业务。"""
    try:
        for index in range(LOG_BACKUP_COUNT - 1, 0, -1):
            src = LOG_PATH.with_name(f"{LOG_PATH.name}.{index}")
            dst = LOG_PATH.with_name(f"{LOG_PATH.name}.{index + 1}")
            if src.exists():
                os.replace(src, dst)
        if LOG_PATH.exists():
            os.replace(LOG_PATH, LOG_PATH.with_name(f"{LOG_PATH.name}.1"))
    except OSError:
        pass


def log(msg: str, *, level: str | None = None, scope: str | None = None, **fields: object) -> None:
    """结构化运行日志：日期 + 级别 + 模块 + 关联字段；单文件轮转。

    `level/scope` 不传时按文案推断，保持现有 100+ 个调用点不用改。
    """
    message = _redact_text(str(msg))
    level = (level or _infer_level(message)).lower()
    scope = scope if scope is not None else _infer_scope(message)
    parts = [f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]", f"[{level.upper()}]"]
    if scope:
        parts.append(f"[{scope}]")
    parts.append(message)
    for key, value in fields.items():
        if value is None or value == "":
            continue
        rendered = _redact_text(str(value), 200) if key in _SENSITIVE_FIELDS else str(value)
        parts.append(f"{key}={rendered}")
    text = " ".join(parts)

    # 直接落文件：客户端现在由 pythonw 无窗口启动（不再有 run.cmd 的 >> 重定向），
    # 只靠 stdout 的话日志会整个消失，出问题时没有任何现场可查。
    try:
        with _log_lock:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            if LOG_PATH.exists() and LOG_PATH.stat().st_size >= LOG_MAX_BYTES:
                _rotate_log_locked()
            with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as fh:
                fh.write(text + "\n")
    except Exception:  # noqa: BLE001 日志写不进去也绝不能中断业务
        pass
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        # 模型回复带 emoji 时 GBK 控制台写不进去——2026-11-13 实测整个 drain
        # 循环被日志异常打断，机器静默半天。降级输出，日志绝不能中断业务
        enc = sys.stdout.encoding or "gbk"
        print(text.encode(enc, "replace").decode(enc, "replace"), flush=True)
    except Exception:  # noqa: BLE001 无控制台（pythonw）时 stdout 不可写，忽略
        pass


def wal_signature(data_dir: Path) -> tuple:
    sig = []
    for name in ("message.db", "message.db-wal", "session.db", "session.db-wal", "user.db", "user.db-wal"):
        p = data_dir / name
        try:
            st = p.stat()
            sig.append((name, st.st_mtime_ns, st.st_size))
        except OSError:
            sig.append((name, 0, 0))
    return tuple(sig)


def _group_source_stamp(store: Store) -> tuple | None:
    data_dir = getattr(store, "data_dir", None)
    if not isinstance(data_dir, Path):
        return None
    stamp = []
    for filename in ("session.db", "session.db-wal"):
        try:
            info = (data_dir / filename).stat()
            stamp.append((info.st_mtime_ns, info.st_size))
        except FileNotFoundError:
            if filename == "session.db":
                return None
            stamp.append(None)
        except OSError:
            return None
    return (data_dir, *stamp)


def refresh_store(store: Store) -> None:
    """Do not acknowledge a new signature while any database is still stale."""
    source_stamp = _group_source_stamp(store)
    store._group_source_stamp = None
    result = store.refresh()
    if isinstance(result, dict) and result.get("failed", 0):
        raise RuntimeError("企微数据库刷新未完成，保留原变化签名，下轮重试")
    if source_stamp == _group_source_stamp(store):
        store._group_source_stamp = source_stamp


def _group_conversations(store: Store, expected: tuple[str, str] | None = None) -> list[dict] | None:
    """Read the current account's local group conversations, or check a queued target."""
    stamp = _group_source_stamp(store)
    if stamp is None or stamp != getattr(store, "_group_source_stamp", None):
        return None
    conn = store._conn("session.db")
    if conn is None:
        return None
    with closing(conn):
        columns = {row[1] for row in conn.execute("PRAGMA table_info(conversation_table)")}
        remark = "TRIM(COALESCE(roomname_remark,''))" if "roomname_remark" in columns else "''"
        name = f"COALESCE(NULLIF({remark},''),TRIM(COALESCE(name,'')))"
        if expected is not None:
            conversation_id, label = expected
            key = _recipient_key(label)
            rows = conn.execute(f"SELECT id,{name},COALESCE(name,'') FROM conversation_table")
            matches = {(cid, shown) for cid, shown, base in rows
                       if key in (_recipient_key(shown), _recipient_key(base))}
            recipients = _recipient_names(store, allow_missing_remarks=True)
            if (matches == {expected} and recipients is not None
                    and key not in recipients[2] and stamp == _group_source_stamp(store)):
                return [{"conv_id": conversation_id, "name": label}]
            return []
        rows = conn.execute(
            f"SELECT id, {name} FROM conversation_table WHERE id GLOB 'R:*' AND LENGTH(id)>2 "
            "ORDER BY last_message_time DESC, id",
        )
        groups = [{"conv_id": str(row[0]), "name": row[1]} for row in rows if row[1]]
        return groups if stamp == _group_source_stamp(store) else None


def is_system_conv(conv_id: str, name: str = "") -> bool:
    if any(conv_id.startswith(p) for p in SYSTEM_PREFIXES):
        return True
    # 群聊（R: 前缀）不可能是官方服务号；群名里出现「企业微信招聘群」这类
    # 字样很常见，按名字拦会误杀正常群消息（2026-11-23 代码核对）。
    if conv_id.startswith("R:"):
        return False
    return any(n in (name or "") for n in SYSTEM_NAMES)


# 媒体消息在会话页上的占位标签。企微的消息类型码（collector 的 content_type
# 是 "type<code>"）里，图片常见 3/13、视频 43、文件 49、位置 48；
# 这里不追求精确，只保证「这条消息确实发过」在网页上看得见。
_MEDIA_LABELS = {
    3: "[图片]",
    13: "[图片]",
    43: "[视频]",
    48: "[位置]",
    49: "[文件]",
}


def _media_label(content_type: object) -> str:
    """非文本消息的占位标签；认不出的类型统一记 [媒体]，绝不返回空串。"""
    raw = str(content_type or "")
    match = re.fullmatch(r"type(\d+)", raw)
    if match:
        return _MEDIA_LABELS.get(int(match.group(1)), "[媒体]")
    return "[媒体]"


# 入站非文本消息的可读提示。定位（48）是客户最常用的替代打字方式：
# 问「在哪里面试」时直接把当前位置甩过来。store 只对文本类型（2/573）提取
# 正文，这类消息的 in_text 恒为空，于是被当成「空系统事件」跳过——客户明明
# 发了东西，Agent 既不推进流程也不回话，界面上只剩「消息没有文本（type=48）」
# （2026-11-20 线上反馈）。
# 只映射语义明确的类型；加好友、撤回这类系统提示（type≈1011）不在表里，
# 仍旧按空事件跳过，不会突然开始回复系统消息。
_INBOUND_HINTS = {
    48: "客户发来一个定位，可能是在问面试地点或确认自己的位置。",
}


def _inbound_hint(item: dict) -> str:
    """取入站消息文本；已登记的非文本类型退化成可读提示，其余返回空串。"""
    text = str(item.get("in_text") or "").strip()
    if text:
        return text
    try:
        kind = int(item.get("in_type") or 0)
    except (TypeError, ValueError):
        return ""
    return _INBOUND_HINTS.get(kind, "")


# ── 企微状态自检（只读探测，绝不激活窗口）─────────────────────────────────────
def _wxwork_pids() -> set[int]:
    """进程探测：tasklist 查 WXWork.exe 的 pid。

    和 sender.py 用同一种写法（那边已验证可用）。纯查询，不碰窗口、不发输入事件。
    """
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="gbk",
            errors="ignore",
            timeout=10,
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


def _wecom_windows(pids: set[int]) -> list[tuple[str, bool]]:
    """枚举这些 pid 下的企微窗口：[(类名, 是否可见)]。

    **只调用只读 API**：EnumWindows / GetWindowThreadProcessId / GetClassNameW /
    IsWindowVisible。不用 SetForegroundWindow、不用 ShowWindow——任何会让窗口
    状态变化的调用都不许出现在这里。
    """
    found: list[tuple[str, bool]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def callback(hwnd, _lparam):
        pid = wt.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        buf = ctypes.create_unicode_buffer(128)
        _user32.GetClassNameW(hwnd, buf, 128)
        name = buf.value
        if name not in ("WeWorkWindow", "WeChatLogin"):
            return True
        found.append((name, bool(_user32.IsWindowVisible(hwnd))))
        return True

    try:
        _user32.EnumWindows(callback, 0)
    except Exception:  # noqa: BLE001
        return []
    return found


def detect_wecom_state() -> str:
    """返回 online / login_required / not_running / hidden / unknown。

    判定表见 docs/_contract/设备心跳与看板契约.md，不要自行加减分支。
    """
    try:
        pids = _wxwork_pids()
        if not pids:
            return "not_running"
        windows = _wecom_windows(pids)
        # 登录窗口优先级最高：主窗口还残留在后台但已退回登录页，也是掉线
        if any(cls == "WeChatLogin" for cls, _visible in windows):
            return "login_required"
        if any(cls == "WeWorkWindow" and visible for cls, visible in windows):
            return "online"
        if any(cls == "WeWorkWindow" for cls, _visible in windows):
            return "hidden"
        return "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


# ── 增量上报 / 心跳 ─────────────────────────────────────────────────────────
def _to_ts(value: object) -> int:
    """企微时间戳有的是秒有的是毫秒，统一成秒。"""
    try:
        ts = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
    if ts <= 0:
        return 0
    while ts > 32_503_680_000:
        ts /= 1000
    return int(ts)


def _iso(ts: int) -> str | None:
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _conv_kind(cid: str) -> str:
    if cid.startswith("R:"):
        return "group"      # 群聊也上报
    if cid.startswith("S:"):
        return "single"
    return "system"


def pending_count() -> int:
    """待发送条数（pending + failed），作为心跳的 queue_size。"""
    try:
        st = rlog.stats()
        return int(st.get("pending", 0)) + int(st.get("failed", 0))
    except Exception:  # noqa: BLE001
        return 0


def _read_client_commit() -> str:
    """当前安装的客户端 git 版本；读不到返回空串。

    心跳（RuntimeHeartbeat 和 _send_bridge 两条通道）和配置同步都要用。
    空串是合法值：开发环境或没装更新器的旧安装没有 .client-version.json。
    """
    try:
        data = json.loads((ROOT / ".client-version.json").read_text(encoding="utf-8-sig"))
        candidate = data.get("commit") if isinstance(data, dict) else None
        if isinstance(candidate, str) and re.fullmatch(r"[0-9a-fA-F]{40}", candidate):
            return candidate.lower()
    except (OSError, ValueError, TypeError):
        pass
    return ""


class RuntimeHeartbeat:
    """A bounded connection heartbeat driven by recent sender observations."""

    def __init__(self, bridge):
        self.bridge = bridge
        self.sample = ("unknown", "", "starting", time.monotonic(), None)
        self.last_error = ""
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="bridge-heartbeat")

    def start(self):
        self._thread.start()

    def close(self):
        self._stop.set()

    def observe(self, wecom, account="", reason="starting", reporter=None):
        self.sample = (wecom, account, reason, time.monotonic(), reporter)

    def payload(self) -> dict:
        wecom, account, reason, observed, reporter = self.sample
        if time.monotonic() - observed > 90:
            reason = "loop_stalled"
        if self.last_error == "authorization" and reason != "loop_stalled":
            reason = "authorization"
        queued = len(reporter._bridge_pending) if reporter is not None else 0
        quarantined = reporter._bridge_quarantined if reporter is not None else 0
        remaining = reporter._bridge_remaining if reporter is not None else 0
        sync = "error" if reporter is not None and (reporter._bridge_capture_error or quarantined) else "catching_up" if queued or remaining else "current"
        if reporter is None or (not reporter._bridge_sampled and not reporter._bridge_capture_error):
            sync = "unknown"
        bridge_state = "online" if wecom == "online" and account else "scanning" if wecom == "login_required" else "offline"
        return {"state": bridge_state, "account_id": account,
                # commit 让服务端知道这台机器装的是哪个版本，看板上直接能看；
                # 旧服务端忽略未知字段，不影响心跳。
                "commit": _read_client_commit(),
                "runtime": {"wecom_available": wecom == "online" and bool(account),
                            "reply_ready": reason == "ready", "reason": reason,
                            "sync": sync, "backlog": min(1_000_000, queued + remaining)}}

    def _loop(self):
        path = f"/api/v1/bridge/devices/{quote(self.bridge.device_code, safe='')}/heartbeat"
        while not self._stop.is_set():
            try:
                self.bridge._request("POST", path, self.payload())
                self.last_error = ""
            except HTTPError as exc:
                self.last_error = "authorization" if exc.code in (401, 403) else "network"
                log(f"[客户端状态] 心跳 HTTP {exc.code}", level="warning")
            except Exception as exc:  # Network loss must not stop the worker.
                self.last_error = "network"
                log(f"[客户端状态] 心跳失败：{type(exc).__name__}", level="warning")
            self._stop.wait(15)


class Reporter:
    """心跳 + 会话增量上报。

    线程分工（避免和 store.refresh 抢读写解密库）：
    - 主线程：按游标挑新增消息、构造 payload
    - 后台线程：发 HTTP、成功后推进游标、写 state 文件

    时序约束：
    - 每 `interval` 秒最多触发一次，按时间戳判断，不 sleep；
    - 上一批还没回来就跳过本轮，绝不排队堆积；
    - 任何异常只记日志，进程不退出，发送不受影响。
    """

    def __init__(
        self,
        api: agent_client.AgentClient,
        store: Store,
        state_path: Path = REPORT_STATE,
        *,
        interval: float = REPORT_INTERVAL,
        device_code: str = "",
        bridge: agent_client.BridgeClient | None = None,
        cfg: dict | None = None,
        remote_config: "remote_cfg.RemoteConfig | None" = None,
    ) -> None:
        self.api = api
        self.store = store
        self.state_path = state_path
        self.interval = interval
        # Node 桥接客户端（4222）；None 表示未配置，完全跳过桥接上报
        self.bridge = bridge
        # 远端配置热更：cfg 是主循环共享的同一份字典，改 interval/cooldown 即时生效
        self.cfg = cfg
        self.remote_config = remote_config
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._last_at = 0.0
        self.runtime_heartbeat = None

        self._state = self._load()
        # device_code 来源优先级：显式传入 > state 里上次成功的值 > client 上已配置的值。
        # 显式传入的那一层由 main() 从 --device-code / 环境变量 / config.json 收上来。
        self.device_code = (
            device_code
            or self._state.get("device_code")
            or getattr(api, "device_code", "")
            or ""
        ).strip()
        if self.api is not None:
            self.api.device_code = self.device_code
        self._cursor: dict[str, int] = {
            str(k): int(v) for k, v in (self._state.get("cursor") or {}).items()
        }
        self._bridge_pending: dict[str, dict] = dict(self._state.get("bridge_pending") or {})
        self._bridge_pages = dict(self._state.get("bridge_pages") or {})
        self._bridge_remaining = 0
        self._bridge_capture_error = False
        self._bridge_sampled = False
        self._bridge_account = ""
        self._bridge_paged = False
        self._bridge_quarantined = 0
        self._favorite_last = 0.0
        # 首次没有游标时，只把最近 24 小时当作"新增"，避免把历史全灌一遍
        self._baseline = int(self._state.get("baseline_ts") or 0) or int(
            time.time() - REPORT_FIRST_WINDOW
        )

    # ---------- state 文件 ----------
    def _load(self) -> dict:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> bool:
        with self._lock:
            data = {
                "device_code": self.device_code,
                "cursor": dict(self._cursor),
                "bridge_pending": dict(self._bridge_pending),
                "bridge_pages": dict(self._bridge_pages),
                "baseline_ts": self._baseline,
                "last_report_at": datetime.now(timezone.utc).isoformat(),
            }
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.state_path)
            return True
        except OSError as exc:
            log(f"[上报] 游标写盘失败（忽略）：{exc}")
            return False

    # ---------- 对外入口 ----------
    def tick(self, wecom_state: str, queue_size: int, *, force: bool = False) -> None:
        """主线程每轮调用；到点才真正发，立刻返回。"""
        now = time.time()
        if not force and now - self._last_at < self.interval:
            return
        if self._thread is not None and self._thread.is_alive():
            return  # 上一批还没回来，本轮跳过
        self._last_at = now
        batch = self._collect() if self.api is not None else {"messages": []}
        if self.bridge is not None and self.bridge.enabled:
            self._bridge_paged = True
            batch["bridge_paged"] = True
            try:
                self._bridge_account = str(self.store.self_id() or "")
                active = [item for item in self._bridge_pending.values()
                          if item.get("destination") == self._bridge_destination()]
                current_queued = sum(item.get("account") == self._bridge_account for item in active)
                self._bridge_quarantined = len(active) - current_queued
                if current_queued < 500:
                    # Store.refresh replaces the decrypted files in place. Read
                    # them on the sender thread, then hand the page to HTTP.
                    batch["bridge_page"] = self._collect_bridge_page()
            except Exception as exc:
                self._bridge_capture_error = True
                log(f"[桥接] 读取消息快照失败：{type(exc).__name__}", level="warning")
            if wecom_state == "online" and self._bridge_account not in ("", "unknown"):
                try:
                    groups = _group_conversations(self.store)
                    if groups is not None and self.store.self_id() == self._bridge_account:
                        batch["group_snapshot"] = (self._bridge_account, groups)
                except Exception as exc:
                    log(f"[群聊] 无法读取会话列表：{type(exc).__name__}", level="warning")
            if time.time() - self._favorite_last >= 300:
                self._favorite_last = time.time()
                try:
                    snapshot_id, complete, favorites = favorite_sync.collect(self.store)
                    if snapshot_id:
                        sync_items = []
                        for item in favorites:
                            raw = dict(item)
                            card_b64 = raw.pop("data_base64", "")
                            if card_b64:
                                try:
                                    card = self.bridge.upload_location_card(card_b64, self._bridge_account, str(raw.get("favorite_id") or ""))
                                    raw["location_card_sha"] = str(card.get("sha256") or "")
                                except Exception as exc:
                                    log(f"[收藏] 位置卡上报失败（保留元数据）：{type(exc).__name__}", level="warning")
                            sync_items.append(raw)
                        batch["favorite_sync"] = {"account_id": self._bridge_account, "snapshot_id": snapshot_id,
                                                   "complete": complete, "items": sync_items}
                except Exception as exc:
                    log(f"[收藏] 读取失败（不清理服务端收藏）：{type(exc).__name__}", level="warning")
        heartbeat = {
            "wecom_state": wecom_state,
            "queue_size": int(queue_size),
            "last_error": _last_error,
        }
        self._thread = threading.Thread(
            target=self._run, args=(heartbeat, batch), name="reporter", daemon=True
        )
        self._thread.start()

    def wait(self, timeout: float = 20.0) -> None:
        """--once 模式用：等后台那一批发完再退出进程。"""
        t = self._thread
        if t is not None:
            t.join(timeout)

    # ---------- 采集（主线程） ----------
    def _collect(self) -> dict:
        batch = {
            "account_uid": self.store.self_id() or "unknown",
            "account_name": "企业微信(本机)",
            "conversations": [],
            "messages": [],
        }
        try:
            rows = self.store.recent(limit=200)
        except Exception as exc:  # noqa: BLE001
            log(f"[上报] 读本地库失败（忽略）：{type(exc).__name__}: {exc}")
            return batch

        with self._lock:
            cursor = dict(self._cursor)

        fresh: list[dict] = []
        for m in rows:
            cid = m.get("conv_id") or ""
            if not cid:
                continue
            try:
                mid = int(m.get("id") or 0)
            except (TypeError, ValueError):
                continue
            if mid and mid <= cursor.get(cid, 0):
                continue
            ts = _to_ts(m.get("time"))
            # 没有游标的会话（首次运行/新会话）：太老的不要
            if cid not in cursor and ts and ts < self._baseline:
                continue
            fresh.append(m)

        fresh.sort(key=lambda x: (_to_ts(x.get("time")), int(x.get("id") or 0)))
        fresh = fresh[:REPORT_MAX_MESSAGES]

        convs: dict[str, dict] = {}
        inbound_pool: list[dict] = []
        for m in rows:
            if m.get("is_self") or not (m.get("text") or "").strip():
                continue
            inbound_pool.append({
                "external_conversation_id": m.get("conv_id") or "",
                "external_msgid": str(m.get("id") or ""),
                "direction": "inbound",
                "content": m.get("text") or "",
                "sent_at": _to_ts(m.get("time")),
            })
        for m in fresh:
            cid = m["conv_id"]
            ts = _to_ts(m.get("time"))
            item = convs.get(cid)
            if item is None:
                convs[cid] = {
                    "external_id": cid,
                    "name": m.get("conv_name") or "",
                    "kind": _conv_kind(cid),
                    "last_message_at": _iso(ts),
                }
            elif ts and (not item["last_message_at"] or _iso(ts) > item["last_message_at"]):
                item["last_message_at"] = _iso(ts)
            batch["messages"].append(
                {
                    "external_conversation_id": cid,
                    "external_msgid": str(m.get("id") or ""),
                    "direction": m.get("direction") or ("outbound" if m.get("is_self") else "inbound"),
                    "content": (m.get("text") or "")[:20000],
                    "content_type": "text" if m.get("is_text") else f"type{m.get('type') or 0}",
                    "sent_at": _iso(ts),
                }
            )
        # 防御层：方向判错时客户原话会以 outbound 上报（历史 bug），这里按内容兜一层。
        kept, echoes = echo_guard.filter_echo_messages(batch["messages"], pool=inbound_pool)
        if echoes:
            self._drop_echoes(echoes)
            batch["messages"] = kept
        batch["conversations"] = list(convs.values())
        return batch

    def _collect_bridge_page(self) -> dict:
        account = str(self.store.self_id() or "")
        if not account or account == "unknown":
            raise RuntimeError("企微账号未确认")
        self._bridge_account = account
        scope = json.dumps([*self._bridge_destination(), account], ensure_ascii=False)
        with self._lock:
            checkpoint = self._bridge_pages.get(scope)
        # Legacy report state kept only a recent window and per-conversation
        # high watermarks. Replay from its known baseline once; server event
        # IDs make that replay safe even if the old window had holes.
        after = checkpoint if checkpoint is not None else (0, "")
        connection = self.store._conn("message.db")
        if connection is None:
            raise RuntimeError("企微消息快照尚不可读")
        try:
            rows = connection.execute(
                """SELECT message_id,conversation_id,send_time,sender_id,content_type,content
                   FROM message_table WHERE (message_id,conversation_id)>(?,?)
                   AND (send_time>=? AND send_time<32503680000 OR send_time>=?)
                   ORDER BY message_id,conversation_id LIMIT ?""",
                (*after, self._baseline, self._baseline * 1000, REPORT_MAX_MESSAGES),
            ).fetchall()
            if rows:
                tail = tuple(rows[-1])[:2]
                remaining = connection.execute(
                    "SELECT COUNT(*) FROM message_table WHERE (message_id,conversation_id)>(?,?) AND (send_time>=? AND send_time<32503680000 OR send_time>=?)",
                    (*tail, self._baseline, self._baseline * 1000),
                ).fetchone()[0]
            else:
                tail = after
                remaining = 0
        finally:
            connection.close()

        names = {str(row["id"]): str(row["name"] or "") for row in self.store.sessions(limit=10000)}
        conversations = []
        messages = []
        for message_id, cid, stamp, sender, kind, content in rows:
            if not cid or message_id is None or is_system_conv(cid, names.get(cid, "")):
                continue
            text = _pb_text(content) if kind in (2, 573) else ""
            direction = direction_of(str(sender), account, cid)
            conversations.append({"external_id": cid, "name": names.get(cid, "")})
            messages.append({
                "external_conversation_id": cid, "external_msgid": str(message_id),
                "direction": direction, "content": (text or "")[:20000],
                "content_type": "text" if text else f"type{kind or 0}", "sent_at": _iso(_to_ts(stamp)),
            })
        return {"messages": messages, "conversations": conversations,
                "bridge_checkpoint": (scope, tail), "bridge_remaining": remaining}

    def _drop_echoes(self, echoes: list[tuple[dict, dict, float]]) -> None:
        """丢弃回声并把游标推过去，避免同一条消息每轮被反复挑出来刷日志。"""
        with self._lock:
            for item, matched, score in echoes:
                try:
                    mid = int(item.get("external_msgid") or 0)
                except (TypeError, ValueError):
                    mid = 0
                cid = item.get("external_conversation_id") or ""
                if mid > self._cursor.get(cid, 0):
                    self._cursor[cid] = mid
        for item, matched, score in echoes:
            log(
                f"[回声] 疑似方向错乱已纠正 msgid={item.get('external_msgid')} "
                f"文本={(item.get('content') or '')[:20]!r} "
                f"会话={item.get('external_conversation_id')} "
                f"命中 inbound msgid={matched.get('external_msgid')} 相似度={score:.0%}（已丢弃 outbound）"
            )
        self._save()

    # ---------- 发送（后台线程） ----------
    def _run(self, heartbeat: dict, batch: dict) -> None:
        try:
            self._send_heartbeat(heartbeat)
        except Exception as exc:  # noqa: BLE001
            log(f"[心跳] 异常（忽略）：{agent_client.describe_error(exc)}")
        # 双通道：与主心跳同一处触发，不另起线程；任何桥接异常都不影响主心跳
        if self.runtime_heartbeat is None:
            try:
                self._send_bridge(heartbeat.get("wecom_state") or "unknown")
            except Exception as exc:  # noqa: BLE001
                log(f"[桥接] 异常（忽略）：{agent_client.describe_error(exc)}")
        try:
            self._send_config_sync()
        except Exception as exc:  # noqa: BLE001
            log(f"[配置同步] 摘要上报失败（忽略）：{type(exc).__name__}")
        if "group_snapshot" in batch:
            self._send_groups(*batch["group_snapshot"])
        favorite = batch.get("favorite_sync")
        if isinstance(favorite, dict):
            try:
                self.bridge.sync_location_favorites(
                    str(favorite.get("account_id") or ""), str(favorite.get("snapshot_id") or ""),
                    bool(favorite.get("complete")), list(favorite.get("items") or []),
                )
                log(f"[收藏] 已同步 {len(favorite.get('items') or [])} 条，完整={bool(favorite.get('complete'))}")
            except Exception as exc:
                log(f"[收藏] 同步失败（下轮重试）：{type(exc).__name__}", level="warning")
        # 远端配置：每个心跳周期比对一次 version，变了重拉并热更运行参数
        try:
            if self.remote_config is not None:
                self.remote_config.sync(self.cfg)
                # brain_mode 变了要重建 Brain：Brain 在启动时构造一次，
                # 只改 cfg["brain"]["mode"] 不会切换行为。
                if "brain_mode" in getattr(self.remote_config, "last_changed", []):
                    global _brain
                    _brain = build_brain(self.cfg, log)
                    log("[远端配置] 回复来源已切换，即时生效")
        except Exception as exc:  # noqa: BLE001
            log(f"[远端配置] 异常（忽略）：{agent_client.describe_error(exc)}")
        # Persist bridge work before the primary ingest can advance the shared cursor.
        try:
            if batch.get("bridge_paged"):
                page = batch.get("bridge_page")
                if page is not None:
                    self._bridge_capture_error = not self._queue_bridge_messages(page)
                    self._bridge_remaining = page["bridge_remaining"]
                    self._bridge_sampled = not self._bridge_capture_error
            elif not self._queue_bridge_messages(batch):
                return
        except Exception as exc:  # noqa: BLE001
            self._bridge_capture_error = True
            log(f"[桥接] pending persistence failed: {agent_client.describe_error(exc)}")
        try:
            self._send_ingest(batch)
        except Exception as exc:  # noqa: BLE001
            log(f"[上报] 异常（忽略）：{agent_client.describe_error(exc)}")
        try:
            self._send_bridge_messages()
            _publish_recipient_reports(self.bridge)
        except Exception as exc:  # noqa: BLE001
            log(f"[桥接] messages 异常（忽略）：{agent_client.describe_error(exc)}")

    def _send_heartbeat(self, heartbeat: dict) -> None:
        if self.api is None:
            return  # 服务端客户端未配置（纯桥接模式），桥接心跳由 _send_bridge 负责
        if not self.device_code:
            log("[心跳] 跳过：没有 device_code（config.json 加 device_code 或设 AGENT_DEVICE_CODE）")
            return
        try:
            res = self.api.heartbeat(**heartbeat)
            log(
                f"[心跳] {self.device_code} wecom_state={heartbeat['wecom_state']} "
                f"待发 {heartbeat['queue_size']} → ok={res.get('ok')}"
            )
            self._state["device_code"] = self.device_code
            self._save()
        except Exception as exc:  # noqa: BLE001
            log(f"[心跳] 失败（忽略，下轮自然补）：{agent_client.describe_error(exc)}")

    @staticmethod
    def _client_commit() -> str:
        """当前安装的客户端 git 版本；与 RuntimeHeartbeat 共用同一份读取逻辑。"""
        return _read_client_commit()

    def _send_config_sync(self) -> None:
        """Background only: refresh and report configuration identity, not sessions."""
        brain = _brain
        if brain is None or not hasattr(brain, "report_config_sync"):
            return
        brain.report_config_sync(self._client_commit())

    def _send_bridge(self, wecom_state: str) -> None:
        """向 Node 桥接（4222）报设备心跳。

        健壮性红线：未配置 → 完全跳过；请求失败 → 打一行日志继续跑，
        绝不影响主心跳和主循环。
        """
        bridge = self.bridge
        if bridge is None or not bridge.enabled:
            return  # 未配置桥接（启动时已打一行日志说明）
        state = map_bridge_state(wecom_state)
        try:
            account_id = self.store.self_id() or ""
        except Exception:  # noqa: BLE001
            account_id = ""
        try:
            bridge.heartbeat(state, account_id=account_id, commit=self._client_commit())
            log(f"[桥接] {self.device_code} → {state} ok=True")
        except Exception as exc:  # noqa: BLE001
            log(f"[桥接] 失败（忽略，不影响主心跳）：{agent_client.describe_error(exc)}")

    def _send_groups(self, account_id: str, groups: list[dict]) -> None:
        """Report a successful read, including a real empty result for the current account."""
        bridge = self.bridge
        if bridge is None or not bridge.enabled:
            return
        try:
            code = quote(bridge.device_code, safe="")
            result = bridge._request("POST", f"/api/v1/bridge/devices/{code}/groups", {
                "account_id": account_id, "complete": True, "groups": groups,
            })
            log(f"[群聊] 已上报 {result.get('count', len(groups))} 个群聊")
        except Exception as exc:  # noqa: BLE001
            log(f"[群聊] 上报失败（忽略，下轮再报）：{agent_client.describe_error(exc)}")

    def _bridge_destination(self) -> list[str]:
        return [getattr(self.bridge, "base_url", ""), getattr(self.bridge, "device_code", self.device_code)]

    def _queue_bridge_messages(self, batch: dict) -> bool:
        """Stage both directions durably, independently of the primary cursor."""
        bridge = self.bridge
        if bridge is None or not bridge.enabled:
            return True
        names = {
            c.get("external_id"): (c.get("name") or "")
            for c in (batch.get("conversations") or [])
        }
        destination = self._bridge_destination()
        checkpoint = batch.get("bridge_checkpoint")
        if checkpoint:
            with self._lock:
                previous_queue = dict(self._bridge_pending)
        for m in batch.get("messages") or []:
            direction = m.get("direction")
            if direction not in ("inbound", "outbound"):
                continue
            cid = (m.get("external_conversation_id") or "").strip()
            msg_id = str(m.get("external_msgid") or "").strip()
            text = (m.get("content") or "").strip()
            # 媒体消息（图片/视频/文件/位置）本来没有文本。以前「没文本就跳过」
            # 把它们整条丢掉：图确实发出去了，网页会话页却一条记录都没有，
            # 运营以为没发（2026-11-15 线上实测点④）。这里给一个占位标签再上报，
            # 4222 的接口要求 content 非空，占位符正好满足契约。
            # 只给「确实是媒体类型」的补标签：content_type 为空或 text 的
            # 空正文仍旧跳过——那是脏数据，没东西可展示。
            if not text and re.fullmatch(r"type\d+", str(m.get("content_type") or "")):
                text = _media_label(m.get("content_type"))
            if not cid or not msg_id or not text:
                continue
            name = names.get(cid, "")
            if is_system_conv(cid, name):
                continue  # 系统/官方会话不进 4222 会话页
            event_id = f"{cid}:{msg_id}"
            key = json.dumps([*destination, *([self._bridge_account] if checkpoint else []), event_id], ensure_ascii=False)
            with self._lock:
                staged = self._bridge_pending.get(key)
                if staged is not None and staged.get("direction") != direction:
                    # 同一条消息只有一个真实方向；队列里留着旧方向就会在原时间点
                    # 多出一条反向气泡（4222 的唯一索引是 source_event_id+direction）
                    log(f"[桥接] {event_id} 方向 {staged.get('direction')}→{direction}，以本次为准")
                    staged = None
                if staged is None:
                    self._bridge_pending[key] = {
                        "destination": destination,
                        "account": self._bridge_account if checkpoint else "",
                        "direction": direction,
                        "event": {"event_id": event_id, "contact_id": cid, "content": text,
                                  "nickname": name, "sent_at": m.get("sent_at") or ""},
                    }
        if not checkpoint:
            return self._save() if self._bridge_pending else True
        scope, cursor = checkpoint
        with self._lock:
            previous = self._bridge_pages.get(scope)
            if previous == list(cursor) and previous_queue == self._bridge_pending:
                return True
            self._bridge_pages[scope] = list(cursor)
        if self._save():
            return True
        with self._lock:
            self._bridge_pending = previous_queue
            if previous is None:
                self._bridge_pages.pop(scope, None)
            else:
                self._bridge_pages[scope] = previous
        return False

    def _advance_cursor_locked(self, event: dict) -> None:
        """按已成功上报的事件推进会话游标（调用方必须已持 self._lock）。

        event_id 形如 "<conv_id>:<msg_id>"，conv_id 自己也带冒号
        （S:1688..._7881...），所以只能从右边切一次。
        """
        cid = str(event.get("contact_id") or "")
        if not cid:
            return
        try:
            mid = int(str(event.get("event_id") or "").rsplit(":", 1)[-1])
        except (TypeError, ValueError):
            return
        if mid > self._cursor.get(cid, 0):
            self._cursor[cid] = mid

    def _send_bridge_messages(self) -> None:
        """Retry pending records; the bridge deduplicates stable event IDs."""
        bridge = self.bridge
        if bridge is None or not bridge.enabled:
            return
        destination = self._bridge_destination()
        with self._lock:
            pending = [
                (key, item.get("direction", "inbound"), item["event"]) for key, item in self._bridge_pending.items()
                if item["destination"] == destination and (item.get("account") == self._bridge_account if self._bridge_paged else not item.get("account") or item["account"] == self._bridge_account)
            ]
        if not pending:
            return
        batch = pending[:REPORT_MAX_MESSAGES]
        sent = 0
        for key, direction, event in batch:
            try:
                bridge._request("POST", f"/api/v1/bridge/devices/{quote(bridge.device_code, safe='')}/{direction}", event)
                with self._lock:
                    self._bridge_pending.pop(key, None)
                    # 桥接上报成功也要推进游标。以前只有 _send_ingest 成功才推进，
                    # 而云端机器没配 server/device_token（api=None），那条路从不执行，
                    # 游标就永远停在旧值：_collect 每轮都挑出同一批「最早」的消息，
                    # 正序截断 50 条后，新消息永远排不进去——网页端于是一直看不到
                    # 新对话（2026-11-19 实测：15:52 之后的消息一条都没到 4222）。
                    self._advance_cursor_locked(event)
                self._save()
                sent += 1
            except Exception as exc:  # noqa: BLE001
                desc = agent_client.describe_error(exc)
                # 服务器返回 502 且 status=processed：消息本身已入库，只是
                # 自动回复投递失败（指令已终态）。这种重试永远不会成功，
                # 留在队首还会堵住后面的消息（2026-11-11 实测）→ 直接放弃。
                # 图片等媒体消息：发送本体已凭人工指令回执入库，观察上报
                # 与回执内容判定不一致（图片消息无文本）会永远 409 → 放弃
                if "conflicts with command receipt" in desc:
                    with self._lock:
                        self._bridge_pending.pop(key, None)
                    self._save()
                    log(f"[桥接] {direction} {event['event_id']} 与指令回执冲突（媒体消息），放弃重试")
                    continue
                # 服务器返回 502 且 status=processed：消息本身已入库，只是
                # 自动回复投递失败（指令已终态）。这种重试永远不会成功 → 直接放弃。
                if "reply_status" in desc and ("Device delivery failed" in desc or '"failed"' in desc):
                    with self._lock:
                        self._bridge_pending.pop(key, None)
                    self._save()
                    log(f"[桥接] {direction} {event['event_id']} 服务器已处理但自动回复投递失败，放弃重试")
                    continue
                log(f"[桥接] {direction} {event['event_id']} 失败（忽略）：{desc}; retry next cycle")
                status = exc.code if isinstance(exc, HTTPError) else None
                if self._bridge_paged and (isinstance(exc, (TimeoutError, OSError)) and status is None
                        or status in (401, 403, 408, 429) or (status is not None and status >= 500)):
                    break  # Connectivity, authorization or server outage affects the whole batch.
                if self._bridge_paged:
                    with self._lock:
                        failed = self._bridge_pending.pop(key, None)
                        if failed is not None:
                            self._bridge_pending[key] = failed
                continue
        if sent:
            log(f"[桥接] messages 上报 {sent} 条")

    def _send_ingest(self, batch: dict) -> None:
        messages = batch.get("messages") or []
        if not messages:
            log("[上报] 无新增消息")
            return
        if self.api is None:
            # 纯桥接模式：消息走 _send_bridge_messages 进 4222，不走服务端 ingest
            return
        try:
            res = self.api.ingest(batch)
        except Exception as exc:  # noqa: BLE001
            # 不重试、不推进游标：下一轮会原样再挑出来
            log(f"[上报] {len(messages)} 条失败（忽略，下轮自然补）：{agent_client.describe_error(exc)}")
            return
        log(
            f"[上报] 新消息 {len(messages)} 条 / 会话 {len(batch.get('conversations') or [])} 个 → "
            f"新建会话 {res.get('conversations_created')} 消息 {res.get('messages_created')} "
            f"跳过 {res.get('messages_skipped')}"
        )
        # 只有上报成功才推进游标
        with self._lock:
            for m in messages:
                cid = m["external_conversation_id"]
                try:
                    mid = int(m["external_msgid"])
                except (TypeError, ValueError):
                    continue
                if mid > self._cursor.get(cid, 0):
                    self._cursor[cid] = mid
        self._save()


def resolve_device_code(cfg: dict) -> str:
    """device_code 从哪来：命令行/配置文件 > 环境变量 > state 缓存。

    cfg["device_code"] 由 main() 填（--device-code 优先，其次 config.json）。
    最后一级在 Reporter 里兜底：上次心跳成功过就记住了。
    """
    return (
        (cfg.get("device_code") or "").strip()
        or os.environ.get("AGENT_DEVICE_CODE", "").strip()
    )


def match_target(m: dict, target: str) -> bool:
    if target == "all":
        return not is_system_conv(m.get("conv_id") or "", m.get("conv_name") or "")
    name = m.get("conv_name") or ""
    cid = m.get("conv_id") or ""
    return target in name or target in cid


def scan_added_contacts(store: Store, cfg: dict) -> int:
    """Welcome newly observed WeChat contacts without requiring inbound text.

    The first readable external-contact snapshot is baseline only.
    Explicit target mode retains its existing operator-selected welcome path.
    Never use the mixed corporate address book for unsolicited all-contact scans.
    """
    global _last_contact_scan_error_at
    target = str(cfg.get("target") or "all")
    try:
        self_id = str(store.self_id() or "")
        if self_id in ("", "unknown"):
            return 0
        sessions = {str(row.get("id") or "") for row in store.sessions(with_names=False)}
        search_contacts = store.contacts()
        contacts = search_contacts if target != "all" else {}
    except Exception as exc:  # noqa: BLE001 - 联系人读取失败不影响消息扫描
        log(f"[加好友] 联系人读取失败（忽略）：{type(exc).__name__}: {exc}", level="warning")
        return 0

    external = None
    con = None
    try:
        if not (Path(store.data_dir) / "user.db").is_file():
            raise RuntimeError("当前账号通讯录源文件不存在")
        con = store._conn("user.db")
        if con is None:
            raise RuntimeError("通讯录缓存不可用")
        # This is the same external WeChat table supported by Store.contacts().
        # A missing/unsupported table is not an authoritative empty snapshot.
        external = {str(row[0]): str(row[1] or "").strip() for row in con.execute(
            "SELECT wxid,name FROM wechat_contactV1 WHERE wxid IS NOT NULL",
        ) if str(row[0]) and str(row[0]) != self_id}
    except Exception as exc:  # explicit targets can still use their established path
        if target == "all":
            if time.monotonic() - _last_contact_scan_error_at >= 60:
                _last_contact_scan_error_at = time.monotonic()
                log(f"[加好友] 普通微信联系人读取失败，未更新基线：{type(exc).__name__}", level="warning")
            return 0
    finally:
        if con is not None:
            con.close()

    account_key = f"{Path(store.data_dir).resolve()}:{self_id}" if external is not None else ""
    observations = {}
    if external is not None:
        initialized, observations = rlog.observe_contacts(account_key, list(external))
        if initialized:
            log(f"[加好友] 已建立普通微信联系人基线（{len(external)} 人），不补发历史欢迎语", scope="flow")
        if target == "all":
            contacts = {contact_id: external[contact_id] for contact_id in observations if contact_id in external}

    # Dify deliberately owns its opening; don't leave empty Agent triggers to
    # be replayed when the operator later switches the account back to Agent.
    provider = getattr(_brain, "reply_provider", "agent")
    if provider not in ("agent", "dify"):
        # Brain starts without an acknowledged provider. Keep observations
        # pending until reply-mode sync establishes who owns the opening.
        return 0
    mode_status = getattr(_brain, "reply_mode_status", {})
    if isinstance(mode_status, dict) and mode_status.get("phase") in ("waiting", "applying"):
        return 0
    if provider == "dify":
        for contact_id in observations:
            rlog.resolve_contact_welcome(account_key, contact_id)
        return 0

    greeted = _load_greeted()
    name_ids: dict[str, set[str]] = {}
    for contact_id, name in {**search_contacts, **(external or {})}.items():
        normalized = str(name or "").strip().casefold()
        if normalized:
            name_ids.setdefault(normalized, set()).add(str(contact_id))
    added = 0
    for contact_id, name in contacts.items():
        contact_id, name = str(contact_id or ""), str(name or "").strip()
        if not contact_id or contact_id == self_id or not name:
            continue
        if len(name_ids.get(name.casefold(), ())) > 1:
            # The frozen sender searches by display name. A post-send ID check
            # is too late to make an ambiguous name safe; keep this observation.
            continue
        # 已有会话直接沿用数据库中的真实 id；尚未产生消息的新单聊按当前
        # 企微版本的实际写法先用 S:<self>_<contact>，发送后仍会回读校验。
        candidates = [f"S:{self_id}_{contact_id}", f"S:{contact_id}_{self_id}"]
        ordered_id = next((value for value in candidates if value in sessions), candidates[0])
        candidate = {"conv_id": ordered_id, "conv_name": name}
        if not match_target(candidate, target):
            if contact_id in observations:
                rlog.resolve_contact_welcome(account_key, contact_id)
            continue
        # Different客户端版本可能把单聊成员顺序写反；已有会话优先沿用实际 id。
        conv_id = candidate["conv_id"]
        if is_system_conv(conv_id, name) or any(not _is_first_contact(value, greeted) for value in candidates):
            if contact_id in observations:
                rlog.resolve_contact_welcome(account_key, contact_id)
            continue
        trigger = {
            "id": f"contact-added:{conv_id}",
            "conv_id": conv_id,
            "conv_name": name,
            "text": "",
            "type": 1011,
            "time": int(observations.get(contact_id, time.time())),
        }
        registered = (rlog.resolve_contact_welcome(account_key, contact_id, trigger)
                      if contact_id in observations else rlog.record_incoming(trigger))
        if registered:
            added += 1
            log(f"[加好友] 发现目标联系人 {name}，登记欢迎流程", scope="flow")
    # Even with an explicit target, consume additions outside that scope so a
    # later scope expansion does not welcome a backlog of old contacts.
    if target != "all":
        for contact_id in observations:
            if not any(match_target(
                {"conv_id": cid, "conv_name": external.get(contact_id, "")}, target
            ) for cid in (f"S:{self_id}_{contact_id}", f"S:{contact_id}_{self_id}")):
                rlog.resolve_contact_welcome(account_key, contact_id)
    return added


def _direct_contact_names(store: Store) -> tuple[str, dict[str, str], dict[str, set[str]]]:
    try:
        account = _recipient_account(store)
        contacts = store.contacts() if account else {}
        if not isinstance(contacts, dict):
            return "", {}, {}
    except (OSError, sqlite3.Error, AttributeError):
        return "", {}, {}
    owners: dict[str, set[str]] = {}
    for contact_id, label in contacts.items():
        key = _recipient_key(str(label or ""))
        if key:
            owners.setdefault(key, set()).add(str(contact_id))
    return account, contacts, owners


def _name_from_direct_contact(cid: str, names: tuple[str, dict[str, str], dict[str, set[str]]]) -> str:
    account, contacts, owners = names
    other = _recipient_other(account, cid)
    name = str(contacts.get(other) or "").strip()
    return name if other and owners.get(_recipient_key(name)) == {other} else ""


def _needs_direct_name(cid: str, name: object) -> bool:
    return cid.startswith("S:") and str(name or "").strip() in ("", cid)


def scan(store: Store, cfg: dict) -> int:
    """把新的对方消息登记进 reply_log。返回新增条数。"""
    added = 0
    names = None
    for m in store.recent(limit=60):
        if m.get("is_self"):
            continue
        cid = m.get("conv_id") or ""
        if not cid:
            continue
        if _needs_direct_name(cid, m.get("conv_name")):
            if names is None:
                names = _direct_contact_names(store)
            name = _name_from_direct_contact(cid, names)
            if name:
                m = {**m, "conv_name": name}
        if not match_target(m, cfg["target"]):
            continue
        if rlog.record_incoming(m):
            added += 1
    return added + scan_unread(store, cfg)


def scan_unread(store: Store, cfg: dict) -> int:
    """補掃企微未讀游標，避免舊會話未讀消息落在全局最近 60 條之外。"""
    session_db = store._conn("session.db")
    message_db = store._conn("message.db")
    if session_db is None or message_db is None:
        if session_db is not None:
            session_db.close()
        if message_db is not None:
            message_db.close()
        return 0

    added = 0
    cursor_message_count = 0
    cursor_fallback_count = 0
    selected_count = 0
    unmatched_count = 0
    contact_names = None
    try:
        try:
            unread_rows = session_db.execute(
                "SELECT conversation_id,begin_cursor,current_cursor,unread_count "
                "FROM unread_conversation_table WHERE unread_count>0"
            ).fetchall()
        except Exception:  # noqa: BLE001 - 企微不同版本可能没有未读游标表
            return 0

        names = {str(row.get("id") or ""): str(row.get("name") or "") for row in store.sessions()}
        self_id = str(store.self_id() or "")
        if not self_id:
            return 0  # Cannot distinguish customer messages from our own sends.
        for unread in unread_rows:
            cid = str(unread["conversation_id"] or "")
            if not cid:
                continue
            try:
                cursor_rows = message_db.execute(
                    "SELECT message_id FROM message_table "
                    "WHERE conversation_id=? AND server_id>=? AND server_id<=? "
                    "ORDER BY server_id",
                    (cid, int(unread["begin_cursor"]), int(unread["current_cursor"])),
                ).fetchall()
            except Exception:  # noqa: BLE001 - skip an unsupported/corrupt conversation row
                continue
            ids = {str(row["message_id"]) for row in cursor_rows}
            id_order = {str(row["message_id"]): index for index, row in enumerate(cursor_rows)}

            count = max(1, int(unread["unread_count"] or 1))
            messages = store.messages(cid, limit=min(5000, max(100, count * 8 + 20)))
            inbound = [
                message for message in messages
                if not (self_id and str(message.get("sender_id") or "") == self_id)
            ]
            if ids:
                cursor_message_count += len(ids)
                incoming = [message for message in inbound if str(message.get("id")) in ids]
            else:
                # Some client builds store unread cursors and message server_id
                # in different domains. Fall back to this conversation's newest
                # inbound rows, bounded by its unread count and reply ledger.
                cursor_fallback_count += 1
                incoming = inbound[-count:]
            if not incoming:
                unmatched_count += 1
                continue

            # Match drain(): prefer the newest readable text to system/non-text
            # records that can follow a customer's message in the unread cursor.
            readable = [message for message in incoming if str(message.get("text") or "").strip()]
            candidates = readable or incoming
            latest = max(
                candidates,
                key=lambda message: (
                    id_order.get(str(message.get("id")), -1),
                    int(message.get("time") or 0), inbound.index(message),
                ),
            )
            selected_count += 1
            item = {
                "id": latest.get("id"),
                "conv_id": cid,
                "conv_name": names.get(cid, "") or cid,
                "text": latest.get("text") or "",
                "type": latest.get("type") or 0,
                "time": latest.get("time") or 0,
            }
            if _needs_direct_name(cid, item["conv_name"]):
                if contact_names is None:
                    contact_names = _direct_contact_names(store)
                item["conv_name"] = _name_from_direct_contact(cid, contact_names) or cid
            if not match_target(item, cfg["target"]):
                continue
            # An unread badge cannot revive an already consumed flow trigger.
            has_flow = _flow_state is not None and _flow_state.get(cid) is not None
            if rlog.record_unread(item, allow_requeue=not has_flow):
                added += 1
    finally:
        session_db.close()
        message_db.close()
    if unread_rows:
        log(
            f"[未读扫描] 会话 {len(unread_rows)}，游标消息 {cursor_message_count}，"
            f"游标回退 {cursor_fallback_count}，"
            f"可处理 {selected_count}，入队/重排 {added}，未匹配 {unmatched_count}"
        )
    return added


def bootstrap(store: Store, cfg: dict) -> None:
    """首次建表：太老的历史消息直接标 skipped，避免一次性回几百条。"""
    if rlog.stats().get("total"):
        return
    cutoff = time.time() - cfg["backfill_hours"] * 3600
    kept = skipped = 0
    for m in store.recent(limit=60):
        if m.get("is_self"):
            continue
        cid = m.get("conv_id") or ""
        if not cid or not match_target(m, cfg["target"]):
            continue
        if not rlog.record_incoming(m):
            continue
        if int(m.get("time") or 0) < cutoff:
            rlog.mark_skipped(str(m["id"]), cid, "历史消息（初始化跳过）")
            skipped += 1
        else:
            kept += 1
    log(f"初始化：保留最近 {cfg['backfill_hours']:g} 小时 {kept} 条待补发，跳过历史 {skipped} 条")


def pick_reply(conv_id: str, cfg: dict) -> tuple[str, str]:
    """按场景选回复：该会话没回过 -> 首次，否则 -> 后续。"""
    if rlog.sent_count(conv_id) == 0:
        return cfg["reply_first"], "首次接触"
    return cfg["reply_next"], "继续对话"


_brain = None  # 由 main() 注入；None 表示用固定文本
_flow_state: flow_state_mod.FlowState | None = None
_flow_cache: dict | None = None
_last_flow_followup_at = 0.0


def _flow_store() -> flow_state_mod.FlowState:
    """Lazy-open the durable flow cursor; tests can replace the module global."""
    global _flow_state
    if _flow_state is None:
        _flow_state = flow_state_mod.FlowState(ROOT / "state" / "flow_state.db")
    return _flow_state


class FlowConfigUnavailable(RuntimeError):
    """The device must wait for its flow configuration before sending."""


def _load_flow(*, force: bool = False) -> dict | None:
    global _flow_cache
    if _brain is None or not hasattr(_brain, "flow"):
        return None
    data = _brain.flow(force=force)
    if isinstance(data, dict) and data.get("blocked"):
        raise FlowConfigUnavailable(str(data.get("detail") or "流程配置不可执行，暂停自动发送"))
    if isinstance(data, dict) and data.get("pending"):
        raise FlowConfigUnavailable("流程配置尚未同步成功，保留本轮待发")
    generation = getattr(_brain, "reply_mode_generation", None)
    if isinstance(generation, str) and (
        data.get("reply_mode_id", "") != generation
        or data.get("provider", "agent") != _brain.reply_provider
    ):
        raise FlowConfigUnavailable("本机流程版本与已确认的回复来源不一致")
    _flow_cache = data if isinstance(data, dict) and data.get("ok", True) and data.get("nodes") else None
    return _flow_cache


def _flow_node(flow: dict, key: str) -> dict | None:
    return next((node for node in flow.get("nodes", []) if node.get("node_key") == key), None)


def _is_prior_flow(snapshot: dict) -> bool:
    generation = getattr(_brain, "reply_mode_generation", None)
    return isinstance(generation, str) and (
        _brain.reply_provider == "dify" or snapshot.get("reply_mode_id", "") != generation
    )


def _flow_for_row(row: dict | None, fallback: dict | None) -> dict | None:
    """Use the per-conversation snapshot so publishing a new flow cannot rewrite an in-flight chat."""
    if row:
        raw = row.get("snapshot_json")
        if raw:
            try:
                snapshot = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(snapshot, dict) and snapshot.get("nodes"):
                    if _is_prior_flow(snapshot):
                        return None
                    return snapshot
            except (TypeError, ValueError):
                pass
    return fallback


def _flow_next(flow: dict, from_key: str, trigger: str, hint: str = "") -> dict | None:
    edges = sorted([edge for edge in flow.get("edges", []) if edge.get("from_key") == from_key],
                   key=lambda edge: int(edge.get("priority") or 0), reverse=True)
    if trigger == "reply":
        lowered = hint.casefold()
        keyword = [edge for edge in edges if edge.get("trigger") == "keyword" and str(edge.get("condition_value") or "").casefold() in lowered]
        if keyword:
            return _flow_node(flow, keyword[0].get("to_key", ""))
        edges = [edge for edge in edges if edge.get("trigger") == "any_reply"]
    elif trigger == "timeout":
        edges = [edge for edge in edges if edge.get("trigger") == "timeout"]
    else:
        edges = [edge for edge in edges if edge.get("trigger") == "default"]
    return _flow_node(flow, edges[0].get("to_key", "")) if edges and edges[0].get("to_key") else None


def _foreground_sample() -> dict:
    try:
        hwnd = _user32.GetForegroundWindow()
        if hwnd:
            pid = wt.DWORD()
            window_class = ctypes.create_unicode_buffer(128)
            _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            _user32.GetClassNameW(hwnd, window_class, len(window_class))
            return {"foreground_pid": pid.value, "window_class": re.sub(r"[^\w.-]", "_", window_class.value)}
    except Exception:  # A diagnostic must never interrupt a send.
        pass
    return {}


def _is_wecom_window_owner(pid: int) -> bool:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wt.DWORD, wt.BOOL, wt.DWORD)
    kernel.OpenProcess.restype = wt.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = (wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD))
    kernel.CloseHandle.argtypes = (wt.HANDLE,)
    process = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not process:
        return False
    try:
        path = ctypes.create_unicode_buffer(32768)
        size = wt.DWORD(len(path))
        return bool(kernel.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size))) and (
            PureWindowsPath(path.value).name.casefold() == "wxwork.exe"
        )
    finally:
        kernel.CloseHandle(process)


def desktop_send_ready(route: str) -> tuple[bool, str]:
    """Check the sender's target before and after any send-time restoration."""
    hwnd = pid = 0
    visible = False
    reason = "desktop_unavailable"
    try:
        restored = None
        for _ in range(2):
            if not _reply_desktop_active():
                reason = "desktop_unavailable"
                break
            target = win.find_window()
            if not target:
                reason = "window_missing"
                break
            hwnd = target["hwnd"]
            gui = win.win32gui
            if not gui.IsWindow(hwnd):
                reason = "window_missing"
                break
            _, pid = win.win32process.GetWindowThreadProcessId(hwnd)
            if restored and (hwnd, pid) != restored:
                reason = "window_changed"
                break
            visible = bool(gui.IsWindowVisible(hwnd))
            if not target["visible"] or not visible:
                reason = "window_hidden"
                break
            cloaked = wt.DWORD()
            dwm = ctypes.WinDLL("dwmapi")
            dwm.DwmGetWindowAttribute.argtypes = (wt.HWND, wt.DWORD, ctypes.c_void_p, wt.DWORD)
            if dwm.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) != 0:
                reason = "window_probe_failed"
                break
            if cloaked.value or not gui.IsWindowEnabled(hwnd):
                reason = "window_unavailable"
                break
            if gui.GetClassName(hwnd) != "WeWorkWindow" or not _is_wecom_window_owner(pid):
                reason = "window_owner_unverified"
                break
            if route == "health" or not win.user32.IsIconic(hwnd):
                return True, ""
            reason = "window_minimized"
            if restored:
                break
            restored = (hwnd, pid)
            win.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.4)
    except Exception:  # A failed probe cannot authorize sending.
        reason = "window_probe_failed"
    if route != "health":
        log("wecom_send_window_blocked", level="warning", scope="send", route=route,
            reason_code=reason, hwnd=hwnd, window_pid=pid, visible=visible, **_foreground_sample())
    return False, "企微发送窗口不可用，本次未执行发送"


_recipient_reports: dict[tuple[str, str], tuple[str, str]] = {}
_recipient_report_lock = threading.Lock()


def _recipient_account(store: Store) -> str:
    account = store.self_id()
    return account if isinstance(account, str) and account not in ("", "unknown") else ""


def _recipient_other(account: str, cid: str) -> str:
    if not account or not cid.startswith("S:"):
        return ""
    members = cid[2:]
    prefix, suffix = account + "_", "_" + account
    other = (members[len(prefix):] if members.startswith(prefix) else
             members[:-len(suffix)] if members.endswith(suffix) else "")
    return other if other != account else ""


def _recipient_names(store: Store, *, allow_missing_remarks: bool = False) -> tuple[dict, dict, dict[str, set[str]]] | None:
    """Read nickname and both searchable remark fields from the current Store."""
    try:
        contacts = store.contacts()
        con = store._conn("user.db")
        if con is None:
            return None
        remarks = {}
        with closing(con):
            columns = ({row[1] for row in con.execute("PRAGMA table_info(external_user_relation_v3)")}
                       if allow_missing_remarks else {"user_id", "real_remarks", "remarks"})
            if "user_id" in columns:
                real_column = "real_remarks" if "real_remarks" in columns else "''"
                fallback_column = "remarks" if "remarks" in columns else "''"
                for contact_id, real, fallback in con.execute(
                    f"SELECT user_id,{real_column},{fallback_column} FROM external_user_relation_v3 "
                    f"WHERE TRIM(COALESCE({real_column},''))<>'' OR TRIM(COALESCE({fallback_column},''))<>''"
                ):
                    remarks[str(contact_id)] = (str(real or "").strip(), str(fallback or "").strip())
        owners: dict[str, set[str]] = {}
        for contact_id in set(contacts) | set(remarks):
            values = (str(contacts.get(contact_id) or ""), *remarks.get(contact_id, ()))
            for value in values:
                key = _recipient_key(value)
                if key:
                    owners.setdefault(key, set()).add(str(contact_id))
        return contacts, remarks, owners
    except (OSError, sqlite3.Error, AttributeError, TypeError):
        return None


def _resolve_recipient(store: Store, cid: str, binding: dict | None,
                       names: tuple[dict, dict, dict[str, set[str]]] | None = None) -> tuple[str, str]:
    """Return a safe search term and any binding status to publish."""
    other = _recipient_other(_recipient_account(store), cid)
    if not other or (binding and binding["status"] in {"conflict", "needs_confirmation"}):
        return "", ""
    names = names if names is not None else _recipient_names(store)
    if names is None:
        return "", ""
    contacts, remarks, search_owners = names
    nickname = str(contacts.get(other) or "").strip()
    real_remark, fallback = remarks.get(other, ("", ""))
    term = binding["remark"] if binding else (real_remark or fallback or nickname)
    key = _recipient_key(term)
    if not key:
        return "", ""
    owners = search_owners.get(key, set())
    if binding:
        if (real_remark or fallback) != term or owners != {other}:
            return "", "needs_confirmation" if binding["status"] == "verified" else ""
        return term, "verified"
    return (term, "") if owners == {other} else ("", "conflict")


def _queue_recipient_report(account: str, cid: str, status: str, remark: str = "") -> None:
    if not account or not status:
        return
    with _recipient_report_lock:
        _recipient_reports[(account, cid)] = (status, remark)


def _publish_recipient_reports(bridge) -> None:
    if not bridge or not getattr(bridge, "enabled", False):
        return
    with _recipient_report_lock:
        work = list(_recipient_reports.items())[:10]
    for (account, cid), (status, remark) in work:
        try:
            bridge.report_recipient_binding(account, cid, status, remark)
        except HTTPError as exc:
            if exc.code not in (404, 409, 422):
                return
        except (OSError, ValueError):
            return
        with _recipient_report_lock:
            if _recipient_reports.get((account, cid)) == (status, remark):
                _recipient_reports.pop((account, cid))


def _latest_recipient_outbound(store: Store, account: str, cid: str) -> float | None:
    try:
        con = store._conn("message.db")
        if con is None:
            return None
        with closing(con):
            row = con.execute("SELECT max(send_time) FROM message_table WHERE conversation_id=? AND sender_id=?",
                              (cid, account)).fetchone()
        return float(row[0] or 0) if row else None
    except (OSError, ValueError, sqlite3.Error):
        return None


def _missing_name_recovery_history(store: Store, account: str, cid: str, row: dict) -> float | None:
    """Prove the stored inbound still identifies the live turn and has no later outbound."""
    peer = _recipient_other(account, cid)
    if not peer:
        return None
    try:
        database = store._conn("message.db")
        if database is None:
            return None
        with closing(database):
            latest = database.execute(
                """SELECT message_id,send_time FROM message_table
                   WHERE conversation_id=? AND CAST(sender_id AS TEXT)=?
                     AND content_type IN (0,2,573) AND length(content)>0
                   ORDER BY send_time DESC,message_id DESC LIMIT 1""", (cid, peer),
            ).fetchone()
            outbound = database.execute(
                "SELECT max(send_time) FROM message_table WHERE conversation_id=? AND CAST(sender_id AS TEXT)=?",
                (cid, account),
            ).fetchone()
        if latest and str(latest[0]) == str(row["message_id"]) and float(latest[1]) == float(row["msg_time"]):
            return float(outbound[0] or 0) if outbound else None
    except (OSError, ValueError, TypeError, sqlite3.Error):
        pass
    return None


def _recover_missing_direct_names(store: Store, cfg: dict, account: str) -> None:
    cutoff = time.time() - RECOVERY_REPLY_MAX_AGE
    candidates = rlog.recipient_blocked_conversations(cutoff)
    if not candidates or not account:
        return
    names = _direct_contact_names(store)
    if names[0] != account:
        return
    unavailable = remote_cfg.takeover_sessions() | remote_cfg.abandoned_sessions()
    for cid in candidates:
        name = _name_from_direct_contact(cid, names)
        if not name or cid in unavailable or not match_target({"conv_id": cid, "conv_name": name}, cfg["target"]):
            continue
        row = rlog.recipient_blocked(cid)
        if not row or row["error"] != "会话没有可搜索的名字":
            continue
        outbound = _missing_name_recovery_history(store, account, cid, row)
        if rlog.restore_recipient_blocked(cid, row["message_id"], conv_name=name,
                                         cutoff=cutoff, outbound_at=outbound, missing_name=True):
            log("会话名称已恢复，重新排队", scope="send", conv_id=cid, message_id=row["message_id"])


def _recovered_name_still_safe(store: Store, account: str, cid: str, row: dict, name: str) -> bool:
    try:
        refresh_store(store)
    except (OSError, RuntimeError, sqlite3.Error):
        return False
    names = _direct_contact_names(store)
    if names[0] != account or _name_from_direct_contact(cid, names) != name:
        return False
    outbound = _missing_name_recovery_history(store, account, cid, row)
    return outbound is not None and outbound < float(row["msg_time"] or 0)


def _refresh_recipient_recoveries(store: Store) -> None:
    account = _recipient_account(store)
    if not account or not remote_cfg.recipient_binding_account_active(account):
        return
    now = time.time()
    bindings = remote_cfg.recipient_bindings(account)
    unavailable = remote_cfg.takeover_sessions() | remote_cfg.abandoned_sessions()
    blocked_conversations = set(rlog.recipient_blocked_conversations(now - REPORT_FIRST_WINDOW))
    if not bindings and not blocked_conversations:
        return
    names = _recipient_names(store)
    if names is None:
        return
    for cid in set(bindings) | blocked_conversations:
        if cid in unavailable or not _recipient_other(account, cid):
            continue
        binding = bindings.get(cid)
        name, report = _resolve_recipient(store, cid, binding, names)
        if report and (not binding or report != binding["status"]):
            _queue_recipient_report(account, cid, report, binding["remark"] if binding else "")
        if not name or not binding or binding["status"] != "verified":
            continue
        blocked = rlog.recipient_blocked(cid)
        if blocked and blocked["msg_time"] >= now - RECOVERY_REPLY_MAX_AGE:
            outbound = _latest_recipient_outbound(store, account, cid)
            rlog.restore_recipient_blocked(
                cid, blocked["message_id"], conv_name=name,
                cutoff=now - RECOVERY_REPLY_MAX_AGE, outbound_at=outbound,
            )



_guard_recipient = False
_recipient_binding_enabled = False
_RecipientHeading = tuple[int, bytes, bytes]
_recipient_proof: tuple[str, _RecipientHeading] | None = None
_RECIPIENT_BLOCKED = "发送前无法核对企微当前会话，已保留待回复记录"


class _RecipientUnverified(Exception):
    pass


def _recipient_key(name: str) -> str:
    # OCR can omit underscore glyphs or insert spaces. Apply the same matching
    # rules to all saved names so lossy matches cannot hide a duplicate.
    return "".join(re.split(r"[\s_]+", name.casefold()))


def _unique_direct_recipient(store: Store, name: str, cid: str) -> bool:
    try:
        me = store.self_id()
        if not isinstance(me, str) or me in ("", "unknown") or not cid.startswith("S:"):
            return False
        members = cid[2:]
        other = (members[len(me) + 1:] if members.startswith(me + "_") else
                 members[:-len(me) - 1] if members.endswith("_" + me) else "")
        key = _recipient_key(name)
        owners = {str(contact_id) for contact_id, label in store.contacts().items()
                  if key and _recipient_key(str(label or "")) == key}
        return bool(other and other != me and owners == {other})
    except Exception:
        return False


def _recipient_heading() -> _RecipientHeading | None:
    """Read the title from the selected, foreground WeCom main window."""
    from screenshot import encode_png, grab

    try:
        target = win.find_window()
        hwnd = target["hwnd"] if target and target.get("visible") else 0
        if not hwnd or win.win32gui.GetForegroundWindow() != hwnd:
            return None
        width, height, pixels = grab(hwnd, method="screen")
        if win.win32gui.GetForegroundWindow() != hwnd:
            return None
        # The title sits just right of the conversation list. Read only its
        # header strip, and require the adjacent green external-contact badge.
        x1, x2 = int(width * .225), int(width * .47)
        y1, y2 = int(height * .01), int(height * .085)
        ink = []
        badge = []
        for y in range(y1, y2):
            for x in range(x1, x2):
                offset = (width * y + x) * 4
                blue, green, red = pixels[offset:offset + 3]
                high, low = max(red, green, blue), min(red, green, blue)
                if high <= 165 and high - low < 45:
                    ink.append((x, y))
                if green - max(blue, red) >= 22:
                    badge.append(x)
        if not ink or len(badge) < 24:
            return None
        left, right = min(x for x, _ in ink), max(x for x, _ in ink)
        top, bottom = min(y for _, y in ink), max(y for _, y in ink)
        if left <= x1 or right >= x2 - 1 or sum(x > right for x in badge) < 24:
            return None
        if top <= y1 or bottom >= y2 - 1:
            return None
        # Keep OCR input deterministic and only retain dark title pixels.
        # Padding and 3x enlargement help with short, mixed-script names.
        scale, pad_x, pad_y = 3, 34, 39
        w = (right - left + 1) * scale + pad_x + 259
        h = (bottom - top + 1) * scale + 2 * pad_y
        image = bytearray(b"\xff" * (w * h * 4))
        for x, y in ink:
            origin = ((y - top) * scale + pad_y) * w + (x - left) * scale + pad_x
            for row in range(scale):
                pos = (origin + row * w) * 4
                image[pos:pos + 4 * scale] = b"\0" * (4 * scale)
        # Preserve the original grayscale strokes for short Chinese titles that
        # Windows OCR cannot read after binarization. Both crops share one frame.
        gray_margin = 14
        gw = (right - left + 5) * 2 + 2 * gray_margin
        gh = (bottom - top + 5) * 2 + 2 * gray_margin
        gray = bytearray(b"\xff" * (gw * gh * 4))
        for y in range(top - 2, bottom + 3):
            for x in range(left - 2, right + 3):
                offset = (width * y + x) * 4
                shade = sum(pixels[offset:offset + 3]) // 3
                point = ((2 * (y - top + 2) + gray_margin) * gw
                         + 2 * (x - left + 2) + gray_margin) * 4
                pair = bytes((shade, shade, shade, 255)) * 2
                gray[point:point + 8] = pair
                gray[point + gw * 4:point + gw * 4 + 8] = pair
        return hwnd, encode_png(w, h, image), encode_png(gw, gh, gray)
    except Exception:
        return None


_RECIPIENT_OCR_SCRIPT = r"""
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$file=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$mode=[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
$stream=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$decoder=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$bitmap=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$ocr=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$result=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$lang=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function ReadResult($operation,[Type]$type) {
    $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation))
    if (-not $task.Wait(2000)) { throw 'OCR timed out' }
    $task.Result
}
$f=ReadResult ($file::GetFileFromPathAsync($env:CITY_RECRUIT_HEADING_IMAGE)) $file
$s=ReadResult ($f.OpenAsync($mode::Read)) $stream
try {
    $d=ReadResult ($decoder::CreateAsync($s)) $decoder
    $im=ReadResult ($d.GetSoftwareBitmapAsync()) $bitmap
    try {
        $preferred=$env:CITY_RECRUIT_HEADING_LANGUAGE
        $engine=$ocr::TryCreateFromLanguage($lang::new($preferred))
        if (-not $engine -and $preferred -eq 'en-US') {
            $engine=$ocr::TryCreateFromLanguage($lang::new('zh-Hans-CN'))
        }
        if ($engine) { (ReadResult ($engine.RecognizeAsync($im)) $result).Text }
    } finally { $im.Dispose() }
} finally { $s.Dispose() }
"""


def _recipient_search_field() -> tuple[int, bytes] | None:
    """Capture only the search field above the conversation list."""
    from screenshot import encode_png, grab

    try:
        target = win.find_window()
        hwnd = target["hwnd"] if target and target.get("visible") else 0
        if not hwnd or win.win32gui.GetForegroundWindow() != hwnd:
            return None
        width, height, pixels = grab(hwnd, method="screen")
        if win.win32gui.GetForegroundWindow() != hwnd:
            return None
        x1, x2 = int(width * .047), int(width * .218)
        y1, y2 = int(height * .032), int(height * .103)
        if x2 <= x1 or y2 <= y1:
            return None
        crop = b"".join(pixels[(y * width + x1) * 4:(y * width + x2) * 4] for y in range(y1, y2))
        return hwnd, encode_png(x2 - x1, y2 - y1, crop)
    except (OSError, ValueError, AttributeError):
        return None


def _recognize_recipient_heading(heading: tuple[int, bytes] | _RecipientHeading, name: str) -> str:
    try:
        with tempfile.TemporaryDirectory(prefix="city-recruit-heading-") as folder:
            file = Path(folder) / "heading.png"
            # Chinese OCR can misread short Latin names and issued remark codes.
            language = "en-US" if name.isascii() and re.search(r"[A-Za-z]", name) else "zh-Hans-CN"
            env = dict(os.environ, CITY_RECRUIT_HEADING_IMAGE=str(file), CITY_RECRUIT_HEADING_LANGUAGE=language)
            ps = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            images = heading[1:2] if name.isascii() else heading[1:]
            for image in images:
                file.write_bytes(image)
                result = subprocess.run(
                    [str(ps), "-NoProfile", "-NonInteractive", "-Command", _RECIPIENT_OCR_SCRIPT],
                    capture_output=True, env=env, timeout=8, creationflags=_CREATE_NO_WINDOW,
                )
                if result.returncode:
                    return ""
                text = result.stdout.decode("utf-8-sig").strip()
                if text:
                    return text
        return ""
    except (OSError, KeyError, UnicodeError, subprocess.TimeoutExpired):
        return ""


@contextmanager
def _check_recipient_at_enter(enabled, check, *, before_paste=False):
    """Gate existing input events on the current recipient."""
    if not enabled:
        yield
        return
    tap = win.tap
    hotkey = win.hotkey

    def checked_tap(key: str) -> None:
        if key == "enter" and not check():
            raise _RecipientUnverified
        tap(key)

    def checked_hotkey(*keys: str) -> None:
        if keys == ("ctrl", "v") and not check():
            raise _RecipientUnverified
        hotkey(*keys)

    win.tap = checked_tap
    if before_paste:
        win.hotkey = checked_hotkey
    try:
        yield
    finally:
        win.tap = tap
        if before_paste:
            win.hotkey = hotkey


def _recipient_guard_enabled(cid: str) -> bool:
    if not cid.startswith("S:"):
        return False
    return bool(_guard_recipient or _recipient_binding_enabled)


def _recipient_unchanged(store: Store, cid: str) -> bool:
    proof = _recipient_proof
    return not _recipient_guard_enabled(cid) or bool(
        proof and proof[0] == cid and _recipient_heading() == proof[1]
    )



def _send_text(store: Store, name: str, cid: str, body: str, *, route: str,
               log_fn, readback_before: dict[str, str] | None = None,
               require_recipient: bool = False, authorize=None, open_only: bool = False,
               **context: object) -> tuple[str, str, str]:
    """Run the existing sender and classify its send or navigation evidence."""
    global _recipient_proof
    _recipient_proof = None
    require_recipient = require_recipient or open_only
    strict_search = _recipient_binding_enabled or open_only
    account = _recipient_account(store)
    managed = _recipient_binding_enabled and remote_cfg.recipient_binding_account_active(account)
    binding = remote_cfg.recipient_bindings(account).get(cid) if managed else None
    if require_recipient and not _recipient_other(account, cid):
        return "blocked", _RECIPIENT_BLOCKED, ""
    guard = _recipient_guard_enabled(cid) or require_recipient
    if _recipient_binding_enabled and guard and not managed:
        return "blocked", _RECIPIENT_BLOCKED, ""
    if guard and _recipient_binding_enabled:
        name, report = _resolve_recipient(store, cid, binding)
        if report and managed and (not binding or report != binding["status"]):
            _queue_recipient_report(account, cid, report, binding["remark"] if binding else "")
        if not name or (binding and binding["status"] != "verified"):
            return "blocked", _RECIPIENT_BLOCKED, ""
    elif require_recipient:
        name, _ = _resolve_recipient(store, cid, None)
        if not name:
            return "blocked", _RECIPIENT_BLOCKED, ""
    elif guard and not _unique_direct_recipient(store, name, cid):
        return "blocked", _RECIPIENT_BLOCKED, ""
    heading = None
    search_before = None
    phase = "start"
    send_enter_verified = False
    send_enter_dispatched = False
    started = monotonic()
    attempt_id = uuid4().hex
    if route != "manual" and not open_only:
        readback_before = _outbound_snapshot(store, cid)

    def event(phase: str, **fields: object) -> None:
        log("wecom_send", scope="send", route=route, phase=phase, attempt_id=attempt_id,
            sender_pid=os.getpid(), **context, **_foreground_sample(), **fields)

    def authorize_enter() -> bool:
        nonlocal send_enter_verified
        if phase == "send":
            if require_recipient and _recipient_account(store) != account:
                return False
            if _recipient_binding_enabled:
                current_account = _recipient_account(store)
                if (current_account != account or not remote_cfg.recipient_binding_account_active(account)
                        or remote_cfg.recipient_bindings(account).get(cid) != binding):
                    return False
            send_enter_verified = bool((authorize is None or authorize()) and heading and _recipient_heading() == heading)
            return send_enter_verified
        if phase == "search" and not strict_search:
            return True
        if phase != "search" or not search_before:
            return False
        search = _recipient_search_field()
        if not search or search == search_before or search[0] != search_before[0]:
            return False
        if _recipient_key(_recognize_recipient_heading(search, name)) != _recipient_key(name):
            return False
        if open_only and authorize is not None and not authorize():
            return False
        return _recipient_search_field() == search

    def on_step(message: str) -> None:
        nonlocal heading, search_before, phase, send_enter_dispatched
        # The core's start message contains the entire body. Keep only the
        # structured start event and avoid the clipboard hint in step 3.
        if message.startswith("开始发送 ->"):
            return
        step, _, _ = message.partition(" ")
        if guard and step == "步骤0":
            heading = None
            phase = "search"
            search_before = _recipient_search_field() if strict_search else None
        if guard and step == "步骤1":
            phase = "chat"
            heading = _recipient_heading()
            if not heading or _recipient_key(_recognize_recipient_heading(heading, name)) != _recipient_key(name):
                raise _RecipientUnverified
        if guard and step == "步骤3":
            phase = "send"
            if not heading or _recipient_heading() != heading:
                raise _RecipientUnverified
        if step == "步骤4":
            send_enter_dispatched = send_enter_verified
        if step in ("步骤0", "步骤3", "步骤4"):
            event(f"core_{step[-1]}")
        if step == "步骤3":
            log_fn("步骤3 输入框校验通过")
        elif message.startswith("本轮失败：输入框校验"):
            log_fn("本轮失败：输入框校验")
        else:
            log_fn(message)

    event("start")
    ready, detail = desktop_send_ready(route)
    if not ready:
        event("result", level="warning", outcome="blocked", reason_code="send_window_unavailable",
              duration_ms=int((monotonic() - started) * 1000))
        return "blocked", detail, ""
    try:
        with _check_recipient_at_enter(guard, authorize_enter):
            if open_only:
                # Frozen dry mode stops immediately after opening the search result.
                result = core_send.send(store, name, name, expect_id=cid, dry=True,
                                        verify_db=False, log=on_step)
            else:
                result = core_send.send(store, name, body, expect_id=cid if cid.startswith(("S:", "R:")) else "",
                                        verify_db=True, log=on_step)
    except _RecipientUnverified:
        event("result", level="warning", outcome="blocked", reason_code="recipient_unverified",
              duration_ms=int((monotonic() - started) * 1000))
        return "blocked", _RECIPIENT_BLOCKED, ""
    except Exception as exc:
        event("result", level="warning", outcome="unknown", reason_code="sender_exception",
              exception_type=type(exc).__name__, duration_ms=int((monotonic() - started) * 1000))
        return "unknown", f"发送过程异常（{type(exc).__name__}），请核对实际落点", ""

    if open_only:
        if result.get("ok") and heading and _recipient_heading() == heading:
            _recipient_proof = (cid, heading)
            return "ready", "已核对企微会话", ""
        return "failed", _RECIPIENT_BLOCKED, ""

    observed_cid = result.get("conversation_id") or ""
    target_match = observed_cid == cid
    detail = str(result.get("detail") or "发送结果缺失")
    message_id = ""
    if observed_cid and not target_match:
        status, reason = "unknown", "wrong_conversation"
        detail = "回读发现消息落到其他会话，请核对实际落点"
    elif not result.get("ok"):
        status, reason = "failed", "sender_failed"
        if detail.startswith("输入框校验"):
            reason = "input_validation_failed"
            detail = "输入框校验失败"
        elif detail.startswith("抢不到前台"):
            reason = "foreground_unavailable"
        elif "窗口持续隐藏" in detail:
            reason = "window_hidden"
    elif not target_match and route != "manual":
        status, reason = "unknown", "target_conversation_missing"
        detail = "已执行发送，企微库未确认目标会话，请核对实际落点"
        if (route in ("opening", "auto", "recontact") and send_enter_dispatched and readback_before is not None
                and account and _recipient_account(store) == account):
            after = _outbound_snapshot(store, cid, fragmented_only=True)
            normalized = _normalize_outbound_text(body)
            new_outbound = {mid: text for mid, text in (after or {}).items()
                            if mid not in readback_before}
            candidates = [mid for mid, text in new_outbound.items() if text == normalized]
            if len(new_outbound) == 1 and len(candidates) == 1:
                status, reason = "sent", "fragmented_target_message_confirmed"
                detail = "已发送并回读确认"
                message_id = f"{cid}:{candidates[0]}"
                target_match = True
            elif len(new_outbound) > 1:
                reason = "target_message_ambiguous"
    else:
        after = _outbound_snapshot(store, cid)
        normalized = _normalize_outbound_text(body)
        candidates = [mid for mid, text in (after or {}).items()
                      if readback_before is not None and mid not in readback_before and text == normalized]
        if len(candidates) == 1:
            status, reason = "sent", "target_message_confirmed"
            message_id = f"{cid}:{candidates[0]}"
        else:
            status = "unknown"
            reason = ("snapshot_unavailable" if readback_before is None or after is None
                      else "target_message_ambiguous" if candidates else "target_message_missing")
            detail = "未回读到目标会话中唯一的新消息，请核对实际落点"
    if guard and status == "sent" and heading:
        _recipient_proof = (cid, heading)
    event("result", level="info" if status == "sent" else "warning", outcome=status, reason_code=reason,
          has_conversation=bool(observed_cid), target_match=target_match, outbound_id=message_id.rpartition(":")[2],
          duration_ms=int((monotonic() - started) * 1000))
    return status, detail, message_id


def _send_media(store: Store, cid: str, name: str, log_fn, *, route: str, authorize=None) -> tuple[str, str]:
    if not _recipient_unchanged(store, cid):
        return "blocked", _RECIPIENT_BLOCKED
    ready, detail = desktop_send_ready(route)
    if not ready:
        return "blocked", detail
    vetoed = False

    def permitted() -> bool:
        nonlocal vetoed
        vetoed = not (_recipient_unchanged(store, cid) and (authorize is None or authorize()))
        return not vetoed

    if authorize is not None and not permitted():
        return "blocked", _RECIPIENT_BLOCKED
    with _check_recipient_at_enter(_recipient_guard_enabled(cid) or authorize is not None,
                                   permitted, before_paste=authorize is not None):
        ok, detail = core_send.paste_media(name, log=log_fn)
    if authorize is not None and vetoed:
        return "blocked", _RECIPIENT_BLOCKED
    return ("sent" if ok else "unknown"), str(detail)


def _send_location_to_recipient(store: Store, cid: str, *args, **kwargs):
    if not _recipient_unchanged(store, cid):
        return False, _RECIPIENT_BLOCKED
    with _check_recipient_at_enter(_recipient_guard_enabled(cid),
                                   lambda: _recipient_unchanged(store, cid)):
        return location_card.send_card(*args, **kwargs)


def _send_dify_media(store: Store, cid: str, step: dict, log_fn) -> tuple[str, str]:
    """Use the existing media sender and require target conversation readback."""
    me = store.self_id()
    if not me or me == "unknown":
        return "failed", "无法核验本机企微账号"
    kinds = (3, 13) if step["type"] == "image" else (43, 49)

    def sent_ids() -> set[str]:
        return {str(msg["id"]) for msg in store.messages(cid, 40)
                if msg.get("id") and msg.get("sender_id") == me and msg.get("type") in kinds}

    before = sent_ids()
    status, detail = _send_media(store, cid, step["name"], log_fn, route="dify")
    if status == "blocked":
        return status, detail
    if status != "sent" or len(sent_ids() - before) != 1:
        return "unknown", "未回读到目标会话中唯一的新媒体消息，请核对实际发送"
    return "sent", str(detail)


def _media_outbound_snapshot(store: Store, cid: str, kind: str) -> set[str] | None:
    try:
        me = store.self_id()
        if not isinstance(me, str) or me in ("", "unknown"):
            return None
        con = store._conn("message.db")
        if con is None:
            return None
        # 2026-11-25 实测修正：本版企微把「粘贴发送的视频」落成 content_type=23
        # （内容里直接带 `/安检.mp4` 文件名），图片落成 14。原来只查 43/49，
        # 于是视频其实已经到达、回读却永远读不到，开场被硬生生截断在视频那一步。
        # 老的 3/13（图片）、43/49（视频）保留，兼容别的企微版本。
        kinds = (3, 13, 14) if kind == "image" else (23, 43, 49)
        placeholders = ",".join("?" * len(kinds))
        with closing(con):
            return {str(row[0]) for row in con.execute(
                f"SELECT message_id FROM message_table WHERE conversation_id=? AND sender_id=? "
                f"AND content_type IN ({placeholders}) ORDER BY send_time DESC,message_id DESC LIMIT 100",
                (cid, me, *kinds),
            )}
    except Exception:
        return None


def _send_agent_media(store: Store, cid: str, name: str, kind: str, log_fn, *, route: str, authorize=None) -> tuple[str, str]:
    status, detail, _ = _send_agent_media_readback(store, cid, name, kind, log_fn, route=route, authorize=authorize)
    return status, detail


def _send_agent_media_readback(store: Store, cid: str, name: str, kind: str, log_fn, *, route: str,
                               authorize=None) -> tuple[str, str, str]:
    before = _media_outbound_snapshot(store, cid, kind)
    if before is None:
        return "failed", "媒体目标会话回读不可用，本次未执行媒体发送", ""
    status, detail = (_send_media(store, cid, name, log_fn, route=route) if authorize is None
                      else _send_media(store, cid, name, log_fn, route=route, authorize=authorize))
    if status != "sent":
        return status, detail, ""
    # 视频要等企微转码/写库，回车后不一定立刻能回读到：最多等 2 秒（4 次 × 0.5s）。
    # 只认「恰好新增 1 条」——多出来说明有别的媒体在动，按不确定处理。
    for attempt in range(4):
        try:
            refresh_store(store)
            after = _media_outbound_snapshot(store, cid, kind)
        except Exception:
            after = None
        new_ids = after - before if after is not None else set()
        if len(new_ids) == 1:
            return "sent", detail, f"{cid}:{next(iter(new_ids))}"
        if attempt < 3:
            time.sleep(0.5)
    return "unknown", "未回读到目标会话中唯一的新媒体消息，请人工核对，不自动重发", ""


def _reply_source_identity() -> tuple:
    return getattr(_brain, "reply_provider", None), getattr(_brain, "reply_mode_generation", None)


def _same_name_ids(store: Store, table: str, id_col: str, normalized: str) -> set[str] | None:
    """某张联系人表里显示名等于 normalized 的 id 集合；表读不到返回 None。

    为什么要分表：同一个人会在 user_table（企微侧）和 wechat_contactV1（微信侧）
    各存一份，名字完全一样。store.contacts() 把两张表合起来，于是「一个人」看起来
    像「两个同名客户」，守卫就误拦（Garbo_C 就是：企微 id 7881301055908323 +
    微信 wxid ozynqsk… 同名）。真撞车要分表看，不能看合并结果。
    """
    try:
        con = store._conn("user.db")
    except Exception:  # noqa: BLE001
        return None
    if con is None:
        return None
    try:
        return {
            str(row[0])
            for row in con.execute("select %s,name from %s" % (id_col, table))
            if str(row[1] or "").strip().casefold() == normalized
        }
    except Exception:  # noqa: BLE001
        return None
    finally:
        try:
            con.close()
        except Exception:  # noqa: BLE001
            pass


def _hide_ghost_windows() -> int:
    """隐藏「可见但整块纯黑」的 WeWorkWindow——企微切换账号留下的残留实例。

    2026-11-25 现场：两个 WeWorkWindow 同时可见，旧实例 1180×694 但 PrintWindow
    亮度 0.0（纯黑），盖在真窗口 1044×694（亮度 227）上面。后果是所有按屏幕坐标
    的点击都打在黑窗口上，表现为「窗口明明开着却发不出去 / 设备注点不动」。
    只隐藏不杀进程（可逆），且只在存在 ≥2 个窗口时动手，避免把唯一窗口也藏了。
    """
    hidden = 0
    try:
        import ctypes
        from ctypes import wintypes as wt

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        found: list[tuple[int, int, int]] = []

        @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        def _cb(hwnd, _):
            buf = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, buf, 64)
            if buf.value == "WeWorkWindow" and user32.IsWindowVisible(hwnd):
                rect = wt.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                w, h = rect.right - rect.left, rect.bottom - rect.top
                if w > 400 and h > 300:
                    found.append((hwnd, w, h))
            return True

        user32.EnumWindows(_cb, None)
        if len(found) < 2:
            return 0
        for hwnd, w, h in found:
            if not win._renders_content(hwnd, w, h):
                user32.ShowWindow(hwnd, 0)  # SW_HIDE
                hidden += 1
    except Exception:  # noqa: BLE001
        return hidden
    return hidden


def _sequence_block_reason(cid: str, cfg: dict, source: tuple, store: Store, name: str) -> str:
    if cid in remote_cfg.takeover_sessions():
        return "会话已被人工接管，停止后续介绍"
    if cid in remote_cfg.abandoned_sessions():
        return "客户已流失，停止后续介绍"
    if cfg.get("_reply_mode_enabled") and not _check_reply_mode("online"):
        return "回复来源尚未就绪，停止后续介绍"
    if _reply_source_identity() != source:
        return "回复来源已切换，停止旧介绍"
    try:
        me = store.self_id()
        binding = remote_cfg.recipient_bindings(me).get(cid) if _recipient_binding_enabled and isinstance(me, str) else None
        if binding:
            term, _ = _resolve_recipient(store, cid, binding)
            return "" if term and binding["status"] == "verified" else _RECIPIENT_BLOCKED
        # Only actual two-member IDs can identify the counterpart. Do not
        # guess by splitting underscores, which can occur in external IDs.
        if isinstance(me, str) and me not in ("", "unknown") and cid.startswith("S:"):
            members = cid[2:]
            other = (members[len(me) + 1:] if members.startswith(me + "_") else
                     members[:-len(me) - 1] if members.endswith("_" + me) else "")
            if other:
                contacts = store.contacts()
                normalized = name.strip().casefold()
                same_name = {str(key) for key, value in contacts.items()
                             if str(value or "").strip().casefold() == normalized}
                # 2026-11-25 放宽：原来要求「同名联系人集合恰好等于对方」，名字带 emoji、
                # 客户改昵称、同一个人在两表各存一份都会误判成「不能唯一搜索」，
                # 把客户挡在门外（Garbo_C 那条就是这样丢的）。
                # 现在只看**企微联系人表里的真撞车**：同名的企微联系人超过一个才拦，
                # 改名/emoji/微信侧影子记录都不再拦；落点安全由发送侧的 expect_id +
                # 发后回读数据库兜底（真发错了会记 unknown 并停下）。
                corp_same = _same_name_ids(store, "user_table", "id", normalized)
                wx_same = _same_name_ids(store, "wechat_contactV1", "wxid", normalized)
                if corp_same is None:
                    # 读不到表就退回合并口径（宁可保守）
                    if len(same_name) > 1:
                        return "同名联系人不止一个，停止介绍并待人工核对"
                elif other in corp_same:
                    # 会话的对方就在企微联系人里：只有企微侧真有两个同名才拦，
                    # 微信侧的影子记录（同一个人）不算
                    if len(corp_same) > 1:
                        return "同名联系人不止一个，停止介绍并待人工核对"
                elif wx_same is None:
                    if len(same_name) > 1:
                        return "同名联系人不止一个，停止介绍并待人工核对"
                elif len(wx_same) > 1:
                    # 对方不在企微表里（纯微信联系人）：微信侧同名超过一个才拦
                    return "同名联系人不止一个，停止介绍并待人工核对"
    except Exception:
        return "联系人搜索信息不可读，停止介绍"
    return ""


def _send_dify_plan(store: Store, name: str, cid: str, plan: list[dict], log_fn) -> tuple[str, str, int]:
    """Execute each server-supplied step after its delay, stopping on uncertain delivery."""
    global _last_reply_at
    status, detail, confirmed = "failed", "未发送", 0
    for step in plan:
        if step["delay_ms"]:
            time.sleep(step["delay_ms"] / 1000)
        if cid in remote_cfg.takeover_sessions() or cid in remote_cfg.abandoned_sessions():
            return "failed", "会话已接管或结束", confirmed
        _last_reply_at = time.time()
        if step["type"] == "text":
            status, detail, _ = _send_text(store, name, cid, step["content"], route="dify", log_fn=log_fn)
        else:
            status, detail = _send_dify_media(store, cid, step, log_fn)
        if status != "sent":
            break
        confirmed += 1
    return status, detail, confirmed


def _send_faq_plan(store: Store, cfg: dict, name: str, cid: str, plan: list[dict], log_fn, *,
                   authorize_asset, source: tuple | None = None) -> tuple[str, str, int]:
    """Execute the saved FAQ sequence against the same verified direct conversation."""
    global _last_reply_at
    if source is None:
        source = _reply_source_identity()
    account = _recipient_account(store)
    binding = deepcopy(remote_cfg.recipient_bindings(account).get(cid)) if account and _recipient_binding_enabled else None
    reason = _sequence_block_reason(cid, cfg, source, store, name)
    if reason:
        return "blocked", reason, 0
    # Group chats can receive the existing text reply, but lack direct-recipient proof.
    require_recipient = cid.startswith("S:")
    status, detail, _ = _send_text(
        store, name, cid, plan[0]["content"], route="auto", log_fn=log_fn, require_recipient=require_recipient,
    )
    if status != "sent":
        return status, detail, 0
    proof = _recipient_proof
    if not require_recipient or not proof or proof[0] != cid:
        return "blocked", _RECIPIENT_BLOCKED, 1

    def authorized() -> bool:
        return bool(
            account and _recipient_account(store) == account
            and _reply_source_identity() == source
            and cid not in remote_cfg.takeover_sessions() and cid not in remote_cfg.abandoned_sessions()
            and proof and proof[0] == cid and _recipient_proof == proof
            and (not _recipient_binding_enabled or (
                remote_cfg.recipient_binding_account_active(account)
                and remote_cfg.recipient_bindings(account).get(cid) == binding
            ))
            and _recipient_heading() == proof[1]
        )

    confirmed = 1
    for step in plan[1:]:
        try:
            if step["delay_ms"]:
                time.sleep(step["delay_ms"] / 1000)
            reason = _sequence_block_reason(cid, cfg, source, store, name)
            if reason or not authorized():
                return "blocked", reason or _RECIPIENT_BLOCKED, confirmed
            kind, filename = step["type"], step["name"]
            label = "图片" if kind == "image" else "视频"
            alias = re.fullmatch(r"dify-asset-[1-9]\d*-([a-f0-9]{64})\.(jpe?g|png|mp4)", filename)
            if not alias or (kind == "video") != (alias[2] == "mp4"):
                return "failed", f"{label}素材引用无效", confirmed
            ready, detail = media_fetch.ensure_media(
                filename, label, base_url=(cfg.get("bridge_server") or "").strip(),
                token=(cfg.get("bridge_token") or "").strip(), log=log_fn,
            )
            if not ready:
                return "failed", f"{label}素材未就绪：{detail}", confirmed
            path = media_fetch.local_file(filename)
            if path is None or sha256(path.read_bytes()).hexdigest() != alias[1]:
                return "failed", f"{label}素材校验失败", confirmed
            if not authorize_asset(filename):
                return "blocked", f"{label}已失效，或暂时无法核对问答素材计划", confirmed
            reason = _sequence_block_reason(cid, cfg, source, store, name)
            if reason or not authorized():
                return "blocked", reason or _RECIPIENT_BLOCKED, confirmed
            _last_reply_at = time.time()
            status, detail = _send_agent_media(store, cid, filename, kind, log_fn, route="faq", authorize=authorized)
        except Exception as exc:
            return "unknown", f"问答素材发送异常（{type(exc).__name__}），请核对实际落点", confirmed
        if status != "sent":
            return status, detail, confirmed
        confirmed += 1
    return "sent", "已回读目标会话的问答文字及对应类型的媒体消息", confirmed


def _location_value(card: object) -> dict | None:
    if not isinstance(card, dict):
        return None
    try:
        if isinstance(card.get("lng"), bool) or isinstance(card.get("lat"), bool):
            return None
        lng, lat = float(card["lng"]), float(card["lat"])
        name, address = card.get("name"), card.get("address")
        if (not math.isfinite(lng) or not math.isfinite(lat) or not lng or not lat
                or abs(lng) > 180 or abs(lat) > 90 or not isinstance(name, str) or not name.strip()
                or not isinstance(address, str) or not address.strip()):
            return None
        return {"lng": lng, "lat": lat, "name": name.strip(), "address": address.strip()}
    except (KeyError, TypeError, ValueError):
        return None


def _send_flow_part(store: Store, name: str, cid: str, part: dict, log_fn, *,
                    node_key: str, part_index: int) -> tuple[str, str]:
    """Send one flow part through the existing guarded core sender."""
    kind = str(part.get("kind") or "text")
    body = str(part.get("body") or "").strip()
    media = str(part.get("media_name") or "").strip()
    if kind == "favorite_location":
        if not body:
            return "failed", "地点缺少有效地址或坐标，导航消息未发送"
    if kind in ("text", "favorite_location") and body:
        status, detail, _ = _send_text(store, name, cid, body, route="node", log_fn=log_fn,
                                       node_key=node_key, part=part_index + 1)
        return status, detail
    if kind in ("image", "video") and media:
        # paste_media() deliberately assumes the guarded text sender has already
        # opened and verified the target conversation. A media-only node cannot
        # establish that target safely, so hold it for an operator instead of
        # risking a paste into whichever chat currently has focus.
        if not part.get("target_verified"):
            return "failed", "媒体节点前必须在本轮先发送已验证落点的文本消息，待人工核对"
        return _send_agent_media(store, cid, media, kind, log_fn, route="node")
    return "failed", "流程节点内容为空"


def _run_flow(store: Store, cfg: dict, cid: str, name: str, flow: dict, *, node_key: str, step_index: int = 0, hint: str = "") -> str:
    """Run from a node until the next await gate; no chat call is made here."""
    global _last_reply_at, _last_error, _consecutive_send_failures
    state = _flow_store()
    current = _flow_node(flow, node_key)
    if current is None:
        state.set_phase(cid, "held", error="流程节点不存在，待人工核对")
        return "held"
    flow_trace_id = ""
    if _brain is not None and not cfg.get("dry_run"):
        flow_trace_id = _brain.start_trace(
            position_id=int(flow.get("position_id") or 0),
            session_key=cid,
            request_text=hint or "流程节点执行",
            flow_version=int(flow.get("version") or 0),
            stage=f"Agent 流程节点：{str(current.get('title') or node_key)}",
            node_key=node_key,
        )
    state.set_phase(cid, "running")
    verified_target = False
    source = _reply_source_identity()
    visited = set()
    backoff = 1 + min(_consecutive_send_failures, 3)
    wait = float(cfg.get("cooldown", 8)) * backoff - (time.time() - _last_reply_at)
    if wait > 0:
        time.sleep(wait)
    while current:
        key = str(current.get("node_key"))
        if key in visited:
            state.set_phase(cid, "held", error="流程快照存在循环")
            return "held"
        visited.add(key)
        if current.get("status", "enabled") == "disabled":
            state.set_step(cid, key, 0)
            # Disabled nodes keep their connections for editing, but their
            # content and timeout/keyword conditions are not executed. Follow
            # the normal continuation, or the any-reply fallback of a wait
            # node, using this conversation's immutable flow snapshot.
            nxt = _flow_next(flow, key, "default") or _flow_next(flow, key, "reply", "")
            log(f"[流程] 跳过停用节点 {key}", scope="flow")
            if nxt is None:
                state.set_phase(cid, "expired")
                return "expired"
            current, step_index = nxt, 0
            continue
        state.set_step(cid, key, int(step_index))
        state.update(cid, wait_minutes=max(1, int(current.get("wait_minutes") or 15)))
        parts = current.get("parts") or []
        idx = int(step_index)
        while idx < len(parts):
            reason = _sequence_block_reason(cid, cfg, source, store, name)
            if reason:
                state.set_phase(cid, "held", error=reason)
                return "held"
            part = parts[idx] if isinstance(parts[idx], dict) else {}
            if part.get("kind") == "favorite_location" and not part.get("body"):
                # A flow started by the previous client can still have a native
                # card snapshot. Continue using the same location as a link.
                point = _location_value(part.get("location"))
                if point:
                    part = {**part, "body": f"{point['name']}：{point['address']}\n导航：https://uri.amap.com/marker?position={point['lng']},{point['lat']}"}
            if not state.claim_step(cid, key, idx, body=str(part.get("body") or ""), media_name=str(part.get("media_name") or "")):
                prior = next((row for row in state.outbox(cid, key) if row["part_index"] == idx), {})
                if prior.get("status") != "sent":
                    state.set_phase(cid, "held", error="当前条目未确认送达，不自动跳过或重发")
                    return "held"
                idx += 1
                state.set_step(cid, key, idx)
                continue
            try:
                if part.get("kind") == "favorite_location":
                    delay = part.get("delay_before_ms", 0)
                    if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not 0 <= delay <= 60_000:
                        raise ValueError("地点等待时间无效")
                    if delay:
                        time.sleep(delay / 1000)
                if part.get("kind") in ("image", "video"):
                    ok, detail = media_fetch.ensure_media(str(part.get("media_name") or ""),
                        "视频" if part.get("kind") == "video" else "图片",
                        base_url=str(cfg.get("bridge_server") or ""), token=str(cfg.get("bridge_token") or ""), log=log)
                    if not ok:
                        raise ValueError(f"媒体预取失败：{detail}")
                reason = (_sequence_block_reason(cid, cfg, source, store, name)
                          if part.get("kind") in ("image", "video", "favorite_location") else "")
                if reason:
                    status, detail = "failed", reason
                else:
                    _last_reply_at = time.time()
                    status, detail = _send_flow_part(store, name, cid, {**part, "target_verified": verified_target},
                                                   lambda msg: log(f"    [流程] {msg}"),
                                                   node_key=key, part_index=idx)
            except Exception as exc:  # a crash after Enter has an unknown result
                status, detail = "unknown", f"{type(exc).__name__}: {exc}"
            blocked = status == "blocked"
            if blocked:
                status = "failed"  # The outbox keeps the blocked step for operator review.
            state.mark_outbox(cid, key, idx, status, detail if status != "sent" else "")
            if _brain is not None and flow_trace_id:
                _brain.log_delivery(flow_trace_id, status if status in ("sent", "failed", "unknown") else "unknown",
                                    session_key=cid, node_key=key, detail=detail)
            if status != "sent":
                state.set_phase(cid, "held", error=detail)
                _last_error = detail[:200]
                if not blocked and not _is_target_miss(detail):
                    _consecutive_send_failures += 1
                log(f"[流程] {name} 暂停：{detail}", level="warning", scope="flow")
                return "held"
            if part.get("kind", "text") in ("text", "favorite_location"):
                verified_target = True
            _last_error, _consecutive_send_failures = "", 0
            idx += 1
            state.set_step(cid, key, idx)
            # Also keep the configured delay between two adjacent nodes.
            time.sleep(max(0.0, float(part.get("delay_ms", current.get("delay_ms", 2000))) / 1000.0))
        if current.get("node_type") == "followup":
            state.mark_followup_sent(cid)
            return "followup_sent"
        if bool(current.get("await_reply")):
            state.set_phase(cid, "awaiting", await_since=time.time())
            return "awaiting"
        nxt = _flow_next(flow, key, "reply" if current.get("node_type") == "branch" else "default", hint)
        if nxt is None and current.get("node_type") == "branch":
            nxt = _flow_next(flow, key, "default")
        if nxt is None:
            state.set_phase(cid, "expired")
            return "expired"
        current, step_index = nxt, 0
    state.set_phase(cid, "expired")
    return "expired"


def _flow_summary(cid: str) -> list[str]:
    rows = _flow_store().outbox(cid)
    return [str(row.get("body") or row.get("media_name") or "").strip() for row in rows if row.get("status") == "sent" and (row.get("body") or row.get("media_name"))]


def _flow_recovery_expired(row: dict, now: float) -> bool:
    stamp = _to_ts(row.get("last_inbound_at")) or _to_ts(row.get("await_since"))
    return bool(stamp and stamp < now - RECOVERY_REPLY_MAX_AGE)


def _flow_tick(store: Store, cfg: dict, wecom_state: str) -> None:
    """Run at most one due follow-up per minute, then close stale follow-ups."""
    global _last_flow_followup_at
    if cfg.get("dry_run"):
        return
    now = time.time()
    state = _flow_store()
    for row in state.stale_followups(now):
        state.set_phase(str(row["session_key"]), "expired", error="复聊后未回复")
    state.daily_snapshot(now)
    if wecom_state != "online" or _brain is None or _consecutive_send_failures:
        return
    if not desktop_send_ready("health")[0]:
        return
    try:
        flow = _load_flow()
    except FlowConfigUnavailable:
        return
    # Recovery must not require a fresh customer message to finish an interrupted
    # node. Only rows whose local outbox was reconciled can reach running here.
    for row in state.list(limit=10000):
        cid, name = str(row["session_key"]), str(row.get("conv_name") or "")
        if row["phase"] != "running" or cid in remote_cfg.takeover_sessions() or cid in remote_cfg.abandoned_sessions():
            continue
        if not name or name == cid or is_system_conv(cid, name):
            state.set_phase(cid, "held", error="流程续发缺少会话名")
            continue
        if cfg.get("_reply_mode_enabled") and _flow_recovery_expired(row, now):
            state.set_phase(cid, "held", error="流程已超过自动恢复时限，请人工核对")
            continue
        saved = _flow_for_row(row, None)
        if saved is None:
            state.set_phase(cid, "held", error="流程续发缺少快照")
            continue
        _run_flow(store, cfg, cid, name, saved, node_key=str(row["node_key"]), step_index=int(row["step_index"]))
        return
    if now - _last_flow_followup_at < 60:
        return
    # Windows may be configured for UTC; business quiet hours are always UTC+8.
    china_hour = (datetime.fromtimestamp(now, timezone.utc).hour + 8) % 24
    if china_hour >= 21 or china_hour < 9:
        return
    for row in state.due_followups(now):
        cid = str(row["session_key"])
        name = str(row.get("conv_name") or "")
        if cid in remote_cfg.takeover_sessions() or cid in remote_cfg.abandoned_sessions():
            continue
        if not name or name == cid or is_system_conv(cid, name):
            state.set_phase(cid, "held", error="复聊目标没有可验证的会话名")
            continue
        row_flow = _flow_for_row(row, flow)
        if row_flow is None:
            state.set_phase(cid, "held", error="流程快照与当前回复来源不一致或不存在")
            continue
        current = _flow_node(row_flow, str(row.get("node_key") or ""))
        if current and current.get("recontact_stage"):
            continue
        if cfg.get("_reply_mode_enabled") and _flow_recovery_expired(row, now):
            state.set_phase(cid, "held", error="复聊已超过自动恢复时限，请人工核对")
            continue
        nxt = _flow_next(row_flow, str(row.get("node_key") or ""), "timeout")
        if current is None or nxt is None:
            state.set_phase(str(row["session_key"]), "expired", error="没有可用的复聊节点")
            continue
        if not state.claim_device_followup(now):
            break
        if not state.claim_followup(cid):
            continue
        _last_flow_followup_at = now  # failed attempts also consume the minute
        result = _run_flow(store, cfg, cid, name, row_flow, node_key=str(nxt.get("node_key")), step_index=0)
        log(f"[流程] {cid} 复聊结果：{result}", scope="flow")
        break


def _reply_desktop_active() -> bool:
    if sys.platform != "win32":
        return True
    session = wt.DWORD()
    kernel = ctypes.WinDLL("kernel32")
    if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)) or not session.value:
        return False
    wts = ctypes.WinDLL("wtsapi32")
    buffer = ctypes.c_void_p()
    size = wt.DWORD()
    wts.WTSQuerySessionInformationW.argtypes = (
        wt.HANDLE, wt.DWORD, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.DWORD)
    )
    wts.WTSFreeMemory.argtypes = (ctypes.c_void_p,)
    if not wts.WTSQuerySessionInformationW(None, session.value, 8, ctypes.byref(buffer), ctypes.byref(size)):
        return False
    try:
        if size.value < ctypes.sizeof(ctypes.c_int) or ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int))[0] != 0:
            return False
    finally:
        wts.WTSFreeMemory(buffer)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.OpenInputDesktop.argtypes = (wt.DWORD, wt.BOOL, wt.DWORD)
    user32.OpenInputDesktop.restype = wt.HANDLE
    user32.CloseDesktop.argtypes = (wt.HANDLE,)
    user32.GetUserObjectInformationW.argtypes = (wt.HANDLE, ctypes.c_int, wt.LPVOID, wt.DWORD, ctypes.POINTER(wt.DWORD))
    desktop = user32.OpenInputDesktop(0, False, 0x0001)
    if not desktop:
        return False
    try:
        name = ctypes.create_unicode_buffer(64)
        length = wt.DWORD()
        return bool(user32.GetUserObjectInformationW(desktop, 2, name, ctypes.sizeof(name), ctypes.byref(length))
                    and name.value.casefold() == "default")
    finally:
        user32.CloseDesktop(desktop)


def _check_reply_mode(wecom_state: str, reporter=None) -> bool:
    if _brain is None or not hasattr(_brain, "sync_reply_mode"):
        return True
    bridge = reporter.bridge if reporter is not None else None
    receipts_ready = True
    if bridge is not None and bridge.enabled:
        try:
            receipts_ready = flush_manual_receipts(bridge)
        except Exception:  # A pending receipt remains in its durable journal.
            receipts_ready = False
    desktop = _reply_desktop_active()
    ready = _brain.sync_reply_mode(wecom_state == "online", can_prepare=receipts_ready, desktop=desktop)
    status = {**_brain.reply_mode_status, "pid": os.getpid(), "ready": ready, "local_at": time.time()}
    try:
        target = CLIENT_STATE_PATH.with_name("reply-mode-state.json")
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, target)
    except OSError:
        pass
    return ready


def _flow_report(cfg: dict) -> None:
    if _brain is None or not hasattr(_brain, "report_state") or _flow_state is None:
        return
    try:
        def iso(value):
            return datetime.fromtimestamp(float(value), timezone.utc).isoformat().replace("+00:00", "Z") if value else None
        rows = _flow_state.list(resolve_device_code(cfg))
        _brain.report_state([{
            "session_key": row.get("session_key"), "position_id": row.get("position_id", 0),
            "flow_version": row.get("flow_version", 0), "node_key": row.get("node_key", ""),
            "step_index": row.get("step_index", 0), "phase": row.get("phase", "idle"),
            "await_since": iso(row.get("await_since")), "followup_sent_at": iso(row.get("followup_sent_at")),
            "followup_round": row.get("followup_round", 0), "revision": row.get("revision", 1),
            "snapshot": json.loads(row.get("snapshot_json") or "{}"), "conv_name": row.get("conv_name", ""),
            "wait_minutes": row.get("wait_minutes", 15), "last_inbound_at": row.get("last_inbound_at", 0),
            "recontact_inbound_id": str(row.get("last_inbound_id") or ""),
            "last_error": row.get("last_error", ""),
        } for row in rows])
    except Exception as exc:  # noqa: BLE001
        log(f"[流程状态] 本地汇总失败：{exc}", level="warning")


def _flow_reconcile(cfg: dict) -> None:
    state = _flow_store()
    if _brain is not None and hasattr(_brain, "states"):
        rows = _brain.states()
        if rows is not None:
            state.restore_mirror(rows, resolve_device_code(cfg))
    state.reconcile(time.time())
    state.daily_snapshot()


def build_brain(cfg: dict, log_fn=print):
    """按 cfg["brain"] 构造回复来源。只有 mode=agent 一种：直连 4222 的受控编排。

    鉴权用的是 bridge_token（与心跳同一份设备令牌），接口在 4222：
    GET /api/v1/agent/opening、POST /api/v1/agent/chat。旧的 kb/flow 模式已废弃。
    """
    bcfg = cfg.get("brain") or {}
    mode = str(bcfg.get("mode") or "agent")
    if mode != "agent":
        log_fn(f"回复来源：固定文本（brain.mode={bcfg.get('mode')!r}，只有 agent 一种有效模式）")
        return None
    base = (cfg.get("bridge_server") or "").strip()
    token = (cfg.get("bridge_token") or "").strip()
    code = resolve_device_code(cfg)
    if not base or not token:
        log_fn(
            "回复来源：固定文本（config.json 缺 bridge_server / bridge_token，"
            "agent 模式要用设备令牌调 4222）"
        )
        return None
    import brain as brain_mod

    instance = brain_mod.Brain(
        base,
        code,
        token,
        timeout=float(bcfg.get("timeout") or 45),
    )
    log_fn(f"回复来源：Agent 会话 {base}（device_code={code or '未配置'}，失败暂停待人工）")
    return instance


def _load_greeted() -> set[str]:
    """读本地「已打过首句」的会话集合。文件不存在/损坏都当成空集合。"""
    try:
        data = json.loads(GREET_STATE.read_text(encoding="utf-8"))
        return {str(x) for x in (data.get("sessions") or []) if str(x).strip()}
    except (OSError, ValueError):
        return set()


def _save_greeted(seen: set[str]) -> None:
    """原子写回（.part → rename），写失败只记日志——首句状态丢了顶多重复打招呼。"""
    try:
        tmp = GREET_STATE.with_name(GREET_STATE.name + ".part")
        items = sorted(seen)[-GREET_STATE_LIMIT:]
        tmp.write_text(json.dumps({"sessions": items}, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, GREET_STATE)
    except OSError as exc:
        log(f"[首句] 写 {GREET_STATE.name} 失败（忽略）：{exc}")


def _is_first_contact(cid: str, seen: set[str]) -> bool:
    """该会话是否第一次出现。

    判定依据（按可靠性排序）：
    1. `.greeted.json` 里已有 → 不是首次（跨重启有效）；
    2. `reply_log` 里已有**开场白**发送成功记录 → 不是首次。

    2026-11-24 修正：第 2 条原来用「有任何 sent 记录」，本意是兼容"升级前
    就在聊"的老会话。但换账号后那批客户只被 Agent 回了几句话、从没收到过
    岗位信息开场白，也被一并算成"打过招呼"，开场白永远不发（全库 scene='开场'
    只有 1 条）。现在只认真正发过开场白，客户下次来消息会补上开场清单。
    """
    if cid in seen:
        return False
    try:
        if rlog.opening_sent(cid):
            seen.add(cid)
            _save_greeted(seen)
            return False
    except Exception:  # noqa: BLE001 查库失败就当首次，最坏是多打一次招呼
        pass
    return True


def _prefetch_media(parts: list[str], cfg: dict) -> None:
    """发送前把 parts 里引用的素材补到本地（缺什么下什么）。

    只下载，不改 parts——发送链路仍按原样解析标记，改一行都会碰到已验证的实现。
    失败的媒体只记日志，文字部分照发。
    """
    server = (cfg.get("server") or "").strip()
    token = (cfg.get("device_token") or "").strip()
    medias: list[tuple[str, str]] = []
    for raw in parts:
        try:
            _, found = core_send.split_media_marks(raw)
        except Exception:  # noqa: BLE001
            continue
        medias.extend(found)
    if not medias:
        return
    if not server or not token:
        log("    [媒体] 未配置 server/device_token，跳过预取（只发文字）")
        return
    try:
        media_fetch.prefetch(medias, base_url=server, token=token, log=log)
    except Exception as exc:  # noqa: BLE001
        log(f"    [媒体] 预取异常（忽略，只发文字）：{type(exc).__name__}: {exc}")


def _hold_expired_replies() -> int:
    return rlog.hold_before(time.time() - RECOVERY_REPLY_MAX_AGE)


def drain(store: Store, cfg: dict, *, dry: bool = False, wecom_state: str = "online") -> dict:
    """按消息时间正序处理 pending + failed。

    同一会话每轮只回复一次。Dify 保留合并的消息正文，Agent 留用最新一条。

    `wecom_state != "online"` 时**一条都不发**，直接返回：
    窗口被隐藏/退回登录页还继续点，就是 11-02 被强退的原因。
    """
    global _last_reply_at, _last_error, _last_block_log, _consecutive_send_failures
    stats = {"sent": 0, "failed": 0, "skipped": 0, "merged": 0, "blocked": 0, "unknown": 0}
    # 每轮读一次首句记录；drain 是单线程的，一轮内新增的会话就地写回
    greeted = _load_greeted()

    if wecom_state != "online" and not dry:
        left = len(rlog.pending(include_failed=True))
        stats["blocked"] = left
        # 状态不变时每 60 秒提示一次，常驻日志不被刷屏
        if time.time() - _last_block_log > 60:
            _last_block_log = time.time()
            log(
                f"[自检] 企微状态 {wecom_state}（{WECOM_STATE_TEXT.get(wecom_state, '未知')}），"
                f"本轮一条都不发，{left} 条待发保留"
            )
        return stats

    if not dry:
        stats["skipped"] += rlog.skip_superseded_reply_recoveries()
        if cfg.get("_reply_mode_enabled"):
            expired = _hold_expired_replies()
            stats["blocked"] += expired
            if expired:
                log("reply_recovery_age_hold", level="warning", scope="send", count=expired)
    account = _recipient_account(store) if not dry else ""
    managed = bool(_recipient_binding_enabled and account and remote_cfg.recipient_binding_account_active(account))
    bindings = remote_cfg.recipient_bindings(account) if managed else {}
    if managed:
        _refresh_recipient_recoveries(store)
    elif not dry and not _recipient_binding_enabled and _guard_recipient:
        _recover_missing_direct_names(store, cfg, account)
    items = rlog.pending(include_failed=True)
    if items and not dry and not desktop_send_ready("auto")[0]:
        stats["blocked"] += len(items)
        return stats
    # 每个会话选一条作为回复目标：优先「有文本」的最新一条。
    # 企业微信在加好友、撤回、系统提示时会插入 type=1011 之类的空文本记录，
    # 它们时间更晚；若只按时间取最新，真正要回的文本就被挤掉，知识库拿到
    # 空字符串直接拒答（实测：Garbo_C 加好友，三条记录里只有第一条有文字）。
    newest: dict[str, dict] = {}
    earlier_by_session: dict[str, list[dict]] = {}
    for it in items:
        cid = it["conv_id"]
        cur = newest.get(cid)
        if cur is None:
            newest[cid] = it
            continue
        cur_has_text = bool((cur["in_text"] or "").strip())
        it_has_text = bool((it["in_text"] or "").strip())
        if it_has_text != cur_has_text:
            if it_has_text:
                newest[cid] = it
            continue
        if int(it["msg_time"] or 0) >= int(cur["msg_time"] or 0):
            newest[cid] = it
    for it in items:
        if newest[it["conv_id"]]["message_id"] != it["message_id"]:
            earlier_by_session.setdefault(it["conv_id"], []).append(it)

    for it in sorted(newest.values(), key=lambda x: int(x["msg_time"] or 0)):
        if not dry and cfg.get("_reply_mode_enabled") and not _check_reply_mode(wecom_state):
            break
        mid = it["message_id"]
        cid = it["conv_id"]
        name = str(it["conv_name"] or "").strip()
        trace = it.get("trace_id") or ""
        dify_mode = getattr(_brain, "reply_provider", None) == "dify"
        earlier = earlier_by_session.get(cid, [])
        if not dify_mode:
            for entry in earlier:
                if not dry:
                    rlog.mark_skipped(entry["message_id"], cid, "同会话合并到最新一条")
                stats["merged"] += 1
        recovering = it.get("last_step") in ("recovery-queued", "recipient-recovery-queued")
        preview = (it["in_text"] or "").strip()[:20].replace("\n", " ") or f"[type={it['in_type']}]"
        agent_medias: list[tuple[str, str]] = []
        dify_plan: list[dict] = []
        faq_media_plan = False
        chat_source = None

        if is_system_conv(cid, name):
            if not dry:
                rlog.mark_skipped(mid, cid, "系统/官方会话")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：系统/官方会话")
            continue

        # 人工接管：网页点「接管」后，服务器把它写进 agent_conversations.takeover，
        # 随 /config 下发到这里。命中就整轮不碰这个会话——否则人工和 AI 会同时发言。
        if cid in remote_cfg.takeover_sessions():
            if not dry:
                rlog.mark_skipped(mid, cid, "人工接管中")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：人工接管中")
            continue

        # 已流失：客户说过「我不去了」（8090 标记 stage=gave_up →
        # recruit_status=disqualified）。按业务要求「只标记、不发消息」——
        # 整轮不碰这个会话，一句都不发，等运营在网页上手动恢复。
        if cid in remote_cfg.abandoned_sessions():
            if not dry:
                rlog.mark_skipped(mid, cid, "客户已流失")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：客户已流失")
            continue

        if _recipient_binding_enabled and not managed and cid.startswith("S:"):
            stats["blocked"] += 1
            continue
        recovered_name = not dry and it.get("last_step") == "name-recovery-queued"
        if recovered_name:
            if not _recipient_guard_enabled(cid) or not _recovered_name_still_safe(store, account, cid, it, name):
                rlog.mark_held(mid, cid, "入站或出站记录发生变化，等待核对")
                stats["blocked"] += 1
                continue
        if not dry and _needs_direct_name(cid, name):
            name = _name_from_direct_contact(cid, _direct_contact_names(store)) or name
        if managed and _recipient_other(account, cid):
            if it.get("last_step") == "recipient-recovery-queued":
                outbound = _latest_recipient_outbound(store, account, cid)
                if outbound is None:
                    stats["blocked"] += 1
                    continue
                if outbound >= float(it["msg_time"] or 0):
                    rlog.mark_held(mid, cid, "该会话已有更新的企微出站，补回前需核对")
                    stats["blocked"] += 1
                    continue
            binding = bindings.get(cid)
            name, report = _resolve_recipient(store, cid, binding)
            if not name or (binding and binding["status"] != "verified"):
                if report and (not binding or report != binding["status"]):
                    _queue_recipient_report(account, cid, report, binding["remark"] if binding else "")
                rlog.mark_recipient_blocked(mid, cid, _RECIPIENT_BLOCKED)
                stats["blocked"] += 1
                continue
        if not name or name == cid:
            if not dry:
                rlog.mark_skipped(mid, cid, "会话没有可搜索的名字")
            stats["skipped"] += 1
            log(f"跳过 {cid}：会话没有可搜索的名字")
            continue

        if not dry and rlog.has_unconfirmed_opening(cid):
            rlog.mark_held(mid, cid, "该会话开场结果待人工核对")
            stats["blocked"] += 1
            continue

        # 新节点流程推进期间是这一轮的唯一出口；最后一个等待节点没有
        # 后继时，本条客户回复直接交给 chat，不能消耗掉后再等客户重说。
        hint = _inbound_hint(it)
        if dify_mode:
            prior = [item for item in earlier if str(item.get("in_text") or "").strip()]
            lines = [str(item.get("dify_turn") or item["in_text"]).strip() for item in prior]
            hint = "\n".join(filter(None, [*lines, str(it.get("dify_turn") or hint)]))[-2000:]
            if earlier and not dry:
                rlog.merge_dify_turn(cid, mid, [item["message_id"] for item in earlier], hint)
                stats["merged"] += len(earlier)
        flow_state = _flow_store() if not dry else None
        flow_row = flow_state.get(cid) if flow_state is not None else None
        if recovering and flow_row is not None and flow_row.get("phase") not in ("expired", "followup_sent", "replied"):
            rlog.mark_held(mid, cid, "此会话有未完成的节点流程，请核对节点后人工处理")
            stats["blocked"] += 1
            continue
        try:
            flow = _flow_for_row(flow_row, _load_flow())
        except FlowConfigUnavailable as exc:
            if time.time() - _last_block_log > 60:
                _last_block_log = time.time()
                log(f"[流程] {exc}", level="warning")
            stats["blocked"] += 1
            continue
        if flow_row is not None and flow is None:
            try:
                snapshot = json.loads(flow_row.get("snapshot_json") or "{}")
            except (TypeError, ValueError):
                snapshot = {}
            if isinstance(snapshot, dict) and snapshot.get("nodes") and _is_prior_flow(snapshot):
                if str(mid) == flow_row.get("last_inbound_id"):
                    rlog.mark_skipped(mid, cid, "旧流程已处理该触发消息")
                    stats["skipped"] += 1
                    continue
                if flow_row.get("phase") in ("running", "awaiting", "followup_due"):
                    flow_state.set_phase(cid, "held", error="模式切换，保留旧流程待核对")
                # Keep the durable snapshot, but allow a new input from this
                # contact through the current provider's regular conversation.
                flow_row = {**flow_row, "phase": "expired"}
        if flow_row is not None and (flow_row.get("phase") == "held" or
                (flow is None and flow_row.get("phase") in ("running", "awaiting", "followup_due"))):
            flow_state.set_phase(cid, "held", error=str(flow_row.get("last_error") or "流程快照缺失"))
            rlog.mark_held(mid, cid, "流程待人工核对")
            stats["blocked"] += 1
            continue
        if flow_row is not None and flow_row.get("phase") != "running" and str(mid) == flow_row.get("last_inbound_id"):
            rlog.mark_skipped(mid, cid, "此入站消息已经推进过流程，重启后不重复消费")
            stats["skipped"] += 1
            continue
        # Old contacts stay in free conversation after the upgrade.
        first_contact = _is_first_contact(cid, greeted) if flow_row is None and not dry and not recovering else False
        if flow is not None and not dry and flow_state is not None and (
            (flow_row is None and first_contact) or
            (flow_row is not None and flow_row.get("phase") in ("idle", "running", "awaiting", "followup_due", "held"))
        ):
            if flow_row is None or flow_row.get("phase") == "idle":
                entry = _flow_node(flow, str(flow.get("entry_key") or "")) or (flow.get("nodes") or [None])[0]
                if entry is not None:
                    if recovered_name and not _recovered_name_still_safe(store, account, cid, it, name):
                        rlog.mark_held(mid, cid, "入站或出站记录发生变化，等待核对")
                        stats["blocked"] += 1
                        continue
                    flow_state.upsert(cid, device_code=resolve_device_code(cfg), position_id=int(flow.get("position_id") or 0),
                                      flow_version=int(flow.get("version") or 0), node_key=str(entry.get("node_key")),
                                      phase="running", conv_name=name, snapshot_json=json.dumps(flow, ensure_ascii=False))
                    flow_state.update(cid, last_inbound_at=float(it["msg_time"] or 0), last_inbound_id=str(mid))
                    result = _run_flow(store, cfg, cid, name, flow, node_key=str(entry.get("node_key")), step_index=0, hint=hint)
                    rlog.mark_skipped(mid, cid, "节点流程启动，首次消息不再同轮调用 chat")
                    stats["skipped"] += 1
                    if result == "held":
                        break  # do not expand a wrong-target failure to another contact
                    continue
            elif flow_row.get("phase") == "running":
                if cfg.get("_reply_mode_enabled") and _flow_recovery_expired(flow_row, time.time()):
                    flow_state.set_phase(cid, "held", error="流程已超过自动恢复时限，请人工核对")
                    rlog.mark_held(mid, cid, "旧流程需要人工核对")
                    stats["blocked"] += 1
                    continue
                result = _run_flow(store, cfg, cid, name, flow, node_key=str(flow_row.get("node_key")), step_index=int(flow_row.get("step_index") or 0), hint=hint)
                # Keep the new inbound pending; only the interrupted output ran.
                if str(mid) == flow_row.get("last_inbound_id"):
                    rlog.mark_skipped(mid, cid, "恢复已消费入站触发的流程，不重复推进")
                if result == "held":
                    break
                continue
            elif flow_row.get("phase") in ("awaiting", "followup_due"):
                if not hint:
                    rlog.mark_skipped(mid, cid, "空系统事件不推进等待节点")
                    stats["skipped"] += 1
                    continue
                current = _flow_node(flow, str(flow_row.get("node_key")))
                nxt = _flow_next(flow, str(flow_row.get("node_key")), "reply", hint)
                if current is not None and nxt is not None:
                    flow_state.update(cid, last_inbound_at=float(it["msg_time"] or 0), last_inbound_id=str(mid))
                    flow_state.set_phase(cid, "replied")
                    flow_state.set_step(cid, str(nxt.get("node_key")), 0)
                    result = _run_flow(store, cfg, cid, name, flow, node_key=str(nxt.get("node_key")), step_index=0, hint=hint)
                    rlog.mark_skipped(mid, cid, "客户回复推进节点，跳过 chat")
                    stats["skipped"] += 1
                    if result == "held":
                        break
                    continue
                flow_state.set_phase(cid, "replied")
                # No next node: keep this inbound available for the normal AI
                # path below. Its ledger result, rather than flow advancement,
                # records whether the reply was actually answered.
            else:  # held：只保留给人工，不自动推进
                rlog.mark_held(mid, cid, "流程发送失败，待人工处理")
                stats["skipped"] += 1
                continue

        if flow_row is not None:
            # Never fall through to the legacy opening after a completed flow.
            greeted.add(cid)
            _save_greeted(greeted)
            if not dry and flow_state is not None:
                flow_state.update(cid, last_inbound_at=float(it["msg_time"] or 0))
                if flow_row.get("phase") == "followup_sent":
                    flow_state.set_phase(cid, "replied")

        agent_trace_id = ""
        opening_claimed = False
        if _brain is not None:
            if not dify_mode:
                hint = _inbound_hint(it)
            agent_medias: list[tuple[str, str]] = []
            # 客户问定位时服务端会带一张位置卡（坐标+地址+名称），文本发完再补发。
            agent_card: dict | None = None
            res = {"ok": False, "detail": "Agent 未初始化"}
            try:
                # ── 开场：新会话按序播一遍 ────────────────────────────
                # 只在「该会话第一次出现消息」时拉开场清单。为什么不靠 hint：
                # 加好友会插入 type=1011 的空文本记录，首句常常没有文本；
                # 所以"是否首次"用会话维度判断（与旧 greet 同一思路）。
                # 每条都上报回执。文本未确认时停止开场和本轮发送。
                if not dry and not recovering and _is_first_contact(cid, greeted):
                    ores = deepcopy(_brain.opening())
                    if ores.get("blocked"):
                        raise RuntimeError("设备开场鉴权失效，暂停自动发送")
                    if ores.get("pending"):
                        # A background first fetch may still be running. Keep
                        # this inbound pending so the next loop can welcome it
                        # after the configuration arrives; no chat fallback.
                        stats["blocked"] += 1
                        log("[开场] 配置尚未同步成功，保留待发，下轮检查", scope="flow")
                        continue
                    if ores.get("ok") and ores.get("items"):
                        sent_items = 0
                        opening_uncertain = False
                        opening_source = _reply_source_identity()
                        opening_target_verified = False

                        def _finish_opening_on_media_failure(detail_m: str) -> None:
                            """媒体没确认时只记日志，收尾交给 for 循环之后的统一逻辑。

                            开场配的是「招聘要求 → 薪资班次 → 视频」，视频粘贴后企微要
                            上传转码，回读库常常超时。原来只要媒体没确认就把整条开场标
                            unknown，`has_unconfirmed_opening()` 随即把这个会话锁死，
                            客户后面问什么都不回（实测青冥「包吃包住吗」被 held）。
                            文本已经用哨兵法确认过落点，说明会话选对了、消息也发出去了，
                            媒体没确认不该否定整轮。

                            注意：这里**不做** greeted 登记和 mark_skipped——那两件事
                            由循环之后的统一收尾负责，否则会跳过「继续回复客户正文」。
                            """
                            log(f"[开场] {name} 文本已确认 {sent_items} 条，媒体未确认：{detail_m}",
                                level="warning", scope="send", message_id=mid, trace_id=trace)
                        for item in ores["items"]:
                            backoff = 1 + min(_consecutive_send_failures, 3)
                            wait = cfg["cooldown"] * backoff - (time.time() - _last_reply_at)
                            if wait > 0:
                                time.sleep(wait)
                            reason = _sequence_block_reason(cid, cfg, opening_source, store, name)
                            if reason:
                                if sent_items:
                                    rlog.mark_unknown(mid, cid, reason, "开场", partial=True)
                                else:
                                    rlog.mark_held(mid, cid, reason, "开场")
                                stats["blocked"] += 1
                                return stats
                            seq, kind = int(item["seq"]), str(item["kind"])
                            fake_id = f"opening:{cid}:{seq}"
                            if kind == "text" and (item["content"] or "").strip():
                                if not opening_claimed:
                                    if recovered_name and not _recovered_name_still_safe(store, account, cid, it, name):
                                        rlog.mark_held(mid, cid, "入站或出站记录发生变化，等待核对")
                                        stats["blocked"] += 1
                                        return stats
                                    if not rlog.begin_reply_attempt(mid, cid, "开场"):
                                        stats["blocked"] += 1
                                        return stats
                                    opening_claimed = True
                                _last_reply_at = time.time()
                                status, detail, _ = _send_text(
                                    store, name, cid, item["content"], route="opening",
                                    log_fn=lambda s: log(f"    {s}"), part=seq,
                                    message_id=mid, trace_id=trace,
                                )
                                if status == "sent":
                                    opening_target_verified = True
                                    _last_error, _consecutive_send_failures = "", 0
                                    rlog.mark_sent(fake_id, cid, "开场", str(item["content"]))
                                    opening_trace = _brain.log_receipt(cid, seq, kind, "sent")
                                    _brain.log_delivery(opening_trace, "sent", session_key=cid,
                                                        detail=detail)
                                    sent_items += 1
                                    log(f"    [开场 {seq}/{len(ores['items'])}] 已发送", scope="send")
                                    # This is the configured orchestration gap,
                                    # separate from the sender's guarded input timing.
                                    time.sleep(max(0.0, float(item.get("delay_ms", 2000)) / 1000.0))
                                else:
                                    if status != "blocked":
                                        _consecutive_send_failures += 1
                                    _last_error = detail[:200]
                                    if status == "unknown" or sent_items or opening_uncertain:
                                        reason = f"开场第 {seq} 项未完成，已有 {sent_items} 项执行成功：{detail}"
                                        rlog.mark_unknown(mid, cid, reason, "开场", str(item["content"]),
                                                          partial=bool(sent_items))
                                        stats["unknown"] += 1
                                        log("wecom_send_hold", level="warning", scope="send", route="opening",
                                            message_id=mid, trace_id=trace, part=seq, completed_items=sent_items)
                                    elif status == "blocked":
                                        if detail == _RECIPIENT_BLOCKED:
                                            rlog.mark_held(mid, cid, detail, "开场")
                                        else:
                                            rlog.mark_failed(mid, cid, detail, "开场")
                                        stats["blocked"] += 1
                                    else:
                                        rlog.mark_held(mid, cid, "开场发送失败，暂停本轮，待人工核对")
                                        stats["blocked"] += 1
                                    # The existing opening receipt contract has no unknown status.
                                    _brain.log_receipt(cid, seq, kind, "failed", _last_error)
                                    return stats
                            elif kind in ("image", "video") and (item["media_name"] or "").strip():
                                if not opening_target_verified:
                                    detail_m = "媒体开场前必须先有本轮已验证落点的文字，未执行媒体发送"
                                    rlog.mark_held(mid, cid, detail_m, "开场")
                                    _brain.log_receipt(cid, seq, kind, "failed", detail_m)
                                    stats["blocked"] += 1
                                    return stats
                                # 真实发送媒体：先检索本地 media 目录（约束 3：本地有
                                # 就不再下载），缺了再从 4222 媒体库拉（bridge 通道，
                                # 设备令牌鉴权）。粘贴用上游原有 paste_media，不新增动作。
                                ok_pre, pre_detail = media_fetch.ensure_media(
                                    item["media_name"],
                                    "视频" if kind == "video" else "图片",
                                    base_url=(cfg.get("bridge_server") or "").strip(),
                                    token=(cfg.get("bridge_token") or "").strip(),
                                    log=lambda s: log(f"    {s}"),
                                )
                                log(f"    [媒体] {item['media_name']} 预取：{pre_detail}")
                                reason = _sequence_block_reason(cid, cfg, opening_source, store, name)
                                if not ok_pre or reason:
                                    detail_m = reason or f"开场媒体预取失败：{pre_detail}"
                                    _brain.log_receipt(cid, seq, kind, "failed", detail_m)
                                    if sent_items:
                                        _finish_opening_on_media_failure(detail_m)
                                        break
                                    rlog.mark_unknown(mid, cid, detail_m, "开场")
                                    stats["unknown"] += 1
                                    return stats
                                if not opening_claimed:
                                    if not rlog.begin_reply_attempt(mid, cid, "开场"):
                                        stats["blocked"] += 1
                                        return stats
                                    opening_claimed = True
                                _last_reply_at = time.time()
                                media_status, detail_m = _send_agent_media(
                                    store, cid, item["media_name"], kind, lambda s: log(f"    {s}"), route="opening",
                                )
                                if media_status == "blocked":
                                    _last_error = detail_m[:200]
                                    _brain.log_receipt(cid, seq, kind, "failed", detail_m)
                                    if sent_items:
                                        _finish_opening_on_media_failure(detail_m)
                                        break
                                    elif opening_uncertain:
                                        rlog.mark_unknown(mid, cid, detail_m, "开场")
                                        stats["unknown"] += 1
                                    else:
                                        rlog.mark_failed(mid, cid, detail_m, "开场")
                                        stats["blocked"] += 1
                                    return stats
                                if media_status == "sent":
                                    rlog.mark_sent(fake_id, cid, f"开场-{kind}", f"{kind}:{item['media_name']}")
                                    opening_trace = _brain.log_receipt(cid, seq, kind, "sent")
                                    _brain.log_delivery(opening_trace, "sent", session_key=cid,
                                                        detail=f"{kind}:{item['media_name']}")
                                    sent_items += 1
                                    log(f"    [开场 {seq}] {kind}:{item['media_name']} 已发送", scope="send")
                                    time.sleep(max(0.0, float(item.get("delay_ms", 2000)) / 1000.0))
                                else:
                                    opening_uncertain = True
                                    rlog.mark_failed(fake_id, cid, f"{kind} 发送失败：{detail_m}", "开场-媒体")
                                    opening_trace = _brain.log_receipt(cid, seq, kind, "failed", detail_m)
                                    _brain.log_delivery(opening_trace, "failed", session_key=cid, detail=detail_m)
                                    log(f"    [开场 {seq}] {kind}:{item['media_name']} 发送失败：{detail_m}", level="warning")
                                    if sent_items:
                                        _finish_opening_on_media_failure(detail_m)
                                        break
                                    rlog.mark_unknown(mid, cid, detail_m, "开场")
                                    stats["unknown"] += 1
                                    return stats
                            elif kind == "location":
                                # 开场最后一条发原生位置卡（2026-11-25）：客户一进来
                                # 就拿到能点开导航的地址，不用等问「发个定位」。
                                if not opening_target_verified:
                                    detail_c = "位置卡开场前必须先有本轮已验证落点的文字，未执行发卡"
                                    rlog.mark_held(mid, cid, detail_c, "开场")
                                    _brain.log_receipt(cid, seq, kind, "failed", detail_c)
                                    stats["blocked"] += 1
                                    return stats
                                card = item.get("location") or {}
                                if not (card.get("lng") and card.get("lat")):
                                    rlog.mark_skipped(fake_id, cid, "位置卡缺少坐标")
                                    continue
                                if not opening_claimed:
                                    if not rlog.begin_reply_attempt(mid, cid, "开场"):
                                        stats["blocked"] += 1
                                        return stats
                                    opening_claimed = True
                                _last_reply_at = time.time()
                                ok_card, detail_c = _send_location_to_recipient(
                                    store, cid, card.get("lng"), card.get("lat"),
                                    str(card.get("address") or ""), str(card.get("name") or ""),
                                    log=lambda s: log(f"    {s}"),
                                )
                                if ok_card:
                                    rlog.mark_sent(fake_id, cid, "开场-位置卡", f"位置卡:{card.get('name')}")
                                    opening_trace = _brain.log_receipt(cid, seq, kind, "sent")
                                    _brain.log_delivery(opening_trace, "sent", session_key=cid, detail=detail_c)
                                    sent_items += 1
                                    log(f"    [开场 {seq}/{len(ores['items'])}] 位置卡已发送", scope="send")
                                    time.sleep(max(0.0, float(item.get("delay_ms", 2000)) / 1000.0))
                                else:
                                    opening_uncertain = True
                                    _brain.log_receipt(cid, seq, kind, "failed", detail_c)
                                    log(f"    [开场 {seq}] 位置卡发送失败：{detail_c}", level="warning")
                                    if sent_items:
                                        break
                                    rlog.mark_unknown(mid, cid, detail_c, "开场")
                                    stats["unknown"] += 1
                                    return stats
                            else:
                                # 空内容/未知类型：跳过并上报
                                rlog.mark_skipped(fake_id, cid, f"开场项类型 {kind} 无内容")
                                opening_trace = _brain.log_receipt(cid, seq, kind, "skipped", "无内容")
                                _brain.log_delivery(opening_trace, "skipped", session_key=cid, detail="无内容")
                        greeted.add(cid)
                        _save_greeted(greeted)
                        log(f"[开场] {name} 播完 {sent_items}/{len(ores['items'])} 条文本，之后进入 Agent 对话")
                        if not (hint or "").strip():
                            # 加好友系统消息（type=1011 等）没有正文，播完开场就收尾
                            rlog.mark_skipped(mid, cid, "首次接触只播开场，无正文不调用 chat")
                            stats["skipped"] += 1
                            continue
                        # 开场播完就停：不再补一条针对首句的回复，等客户下一条消息
                        # （2026-11-25 确认）。开场里已经包含岗位清单和位置卡，再补一条
                        # 会连着刷屏；客户下一句再走正常问答。
                        if not dry:
                            rlog.mark_skipped(mid, cid, "开场已播完，等客户下一条")
                        stats["skipped"] += 1
                        log(f"[开场] {name} 开场已播完，等客户下一条", scope="send", message_id=mid)
                        continue
                    else:
                        log(f"    [开场] 没取到清单（{ores.get('detail')}），直接进对话")
                # 默认值：非 Agent 模式（pick_reply）不会填这几个变量，但后面的
                # 媒体/位置卡补发是无条件读的，先兜住再覆盖。
                agent_medias: list = []
                agent_card = None
                dify_plan: list = []
                faq_media_plan = False
                if not hint and not dry:
                    res = {"ok": False, "detail": f"消息没有文本（type={it['in_type']}）"}
                elif hint:
                    # 会话记忆在服务端：只报 session_key（会话 id）+ 这句话。
                    # 服务端自己持有全量上下文（含开场序列），客户端不传历史。
                    chat_kwargs = {"turn_id": str(mid)}
                    chat_source = _reply_source_identity()
                    res = _brain.chat(hint, cid, sent_summary=_flow_summary(cid) if flow is not None else None, **chat_kwargs)
                    agent_trace_id = str(res.get("trace_id") or "")
                    agent_medias = res.get("medias") or []
                    agent_card = res.get("location_card") or None
                    dify_plan = res.get("plan") or []
                    faq_media_plan = res.get("faq_media") is True
                if res.get("code") == "reply_mode_pending":
                    stats["blocked"] += 1
                    break  # The server generated no reply. Keep the inbound pending.
                if res.get("skip"):
                    if not dry:
                        rlog.mark_skipped(mid, cid, res.get("detail") or "流程已结束")
                    stats["skipped"] += 1
                    log(f"    [flow] {res.get('detail') or '流程已结束，不再回复'}",
                        scope="flow", message_id=mid, trace_id=trace)
                    continue
                text = res.get("reply")
                if not res.get("ok") or not isinstance(text, str) or not text.strip():
                    # brain 返回的可能只有 parts（新接口形状），取第一条当 text
                    fallback_parts = [str(p).strip() for p in (res.get("parts") or []) if str(p).strip()]
                    if res.get("ok") and fallback_parts:
                        text = fallback_parts[0]
                    else:
                        raise ValueError(res.get("detail") or "Agent 返回空回复")
                text, scene = text.strip(), res.get("scene") or "Agent"
                # Agent 可能返回多条文本（先答问题再推进），逐条分开发
                raw_parts = res.get("parts") or []
                parts = [str(p).strip() for p in raw_parts if str(p).strip()]
                if len(parts) < 2:
                    parts = [text]
                log(f"    [brain] {res.get('detail', '')}",
                    scope="flow", message_id=mid, trace_id=trace)
            except Exception as exc:  # noqa: BLE001
                if opening_claimed:
                    _last_error = f"开场发送流程异常（{type(exc).__name__}），请核对实际落点"
                    rlog.mark_unknown(mid, cid, _last_error, "开场", partial=bool(sent_items))
                    _consecutive_send_failures += 1
                    stats["unknown"] += 1
                    log(_last_error, level="warning", scope="send", message_id=mid, trace_id=trace)
                    return stats
                reason = f"Agent 暂停，待人工处理：{type(exc).__name__}: {exc}"
                if not dry:
                    rlog.mark_held(mid, cid, reason)
                    _last_error = reason[:200]
                stats["blocked"] += 1
                log(f"    [brain] {reason}", level="warning",
                    scope="flow", message_id=mid, trace_id=trace)
                continue
        else:
            text, scene = pick_reply(cid, cfg)
            parts = [text]

        # 冷却按“距上次企微键鼠操作”计算，与成败无关（见 _consecutive_send_failures
        # 处的注释）；连续失败再把间隔拉长，最多 4 倍 cooldown。
        backoff = 1 + min(_consecutive_send_failures, 3)
        wait = cfg["cooldown"] * backoff - (time.time() - _last_reply_at)
        if wait > 0:
            time.sleep(wait)

        log(
            f"[{scene}] {name} ← {_redact_text(preview)!r} → {_redact_text(text, 200)!r}",
            scope="send", message_id=mid, trace_id=trace,
        )
        if dry:
            # DRY-RUN 也走一遍标记解析，上线前核对素材是否就位
            for raw in parts:
                try:
                    _, medias = core_send.split_media_marks(raw)
                except Exception:  # noqa: BLE001  stub/异常环境回退
                    medias = []
                for kind, mname in medias:
                    found = core_send.find_media(mname)
                    log(f"    [媒体] DRY-RUN 解析 {kind}:{mname} → "
                        f"{found.name if found else '未找到'}")
            log("    DRY-RUN，未发送")
            stats["sent"] += 1
            continue

        # 真正按键之前先把素材补到本地：send.paste_media 只认本地文件，
        # 缺文件它只会打一行"未找到"。这里失败也不阻断，文字照发。
        if dify_plan and not faq_media_plan:
            dify_media = [(step["type"], step["name"]) for step in dify_plan if step["type"] != "text"]
            ready_media = media_fetch.prefetch(dify_media, base_url=(cfg.get("bridge_server") or "").strip(),
                                               token=(cfg.get("bridge_token") or "").strip(), log=log)
            if any(not ready_media.get(name) for _, name in dify_media):
                detail = "Dify 发送计划的素材未就绪，待核对后恢复"
                rlog.mark_held(mid, cid, detail)
                _last_error = detail
                stats["blocked"] += 1
                continue
        elif not dify_plan:
            _prefetch_media(parts, cfg)

        # 按键之前先确认剪贴板可写，避免 Ctrl+F 打开搜索框后才卡住
        if not compat.wait_clipboard_writable(timeout=15):
            rlog.mark_failed(mid, cid, "剪贴板被占用超过 15 秒", scene, text)
            if _brain is not None:
                _brain.log_delivery(agent_trace_id, "failed", session_key=cid, detail="剪贴板被占用超过 15 秒")
            _last_error = "剪贴板被占用超过 15 秒"
            stats["failed"] += 1
            log("    跳过：剪贴板被占用（向日葵同步？）", level="warning",
                scope="send", message_id=mid, trace_id=trace)
            continue

        if recovered_name and not opening_claimed and not _recovered_name_still_safe(store, account, cid, it, name):
            rlog.mark_held(mid, cid, "入站或出站记录发生变化，等待核对")
            stats["blocked"] += 1
            continue
        send_started = time.time()
        if not rlog.begin_reply_attempt(mid, cid, scene, text):
            stats["blocked"] += 1
            continue
        confirmed_parts = 0
        text_recorded = False
        try:
            # 打开回读：verify_db=False 时只要按了回车就记 sent，发没发出去不知道
            # （2026-11-07 实测：reply_log 记 sent，企微库里根本没有这条消息）。
            # expect_id 锁死落点，防止回车落到别的会话上。
            # 多段回复（parts）逐条发送，段间隔 2 秒防折叠/限流；任何一段失败即止。
            # 每段先剥离【图片:x】/【视频:x】标记：剩余文本照常走键鼠发送，
            # 文本发出后媒体逐个粘贴；媒体任何异常不影响文本已发状态。
            # 冷却在按键前更新：无论成败，这次键鼠操作都算数——失败不再
            # "零成本"立即打下一个会话（2026-11-16 掉登录事故的操作模式）。
            _last_reply_at = time.time()
            status, detail = "failed", "未发送"
            if faq_media_plan:
                status, detail, confirmed_parts = _send_faq_plan(
                    store, cfg, name, cid, dify_plan, lambda msg: log(f"    {msg}", scope="send", message_id=mid, trace_id=trace),
                    authorize_asset=lambda filename: _brain.authorize_faq_media(agent_trace_id, cid, filename),
                    source=chat_source,
                )
            elif dify_plan:
                status, detail, confirmed_parts = _send_dify_plan(
                    store, name, cid, dify_plan, lambda msg: log(f"    {msg}", scope="send", message_id=mid, trace_id=trace),
                )
            for idx, raw_part in enumerate([] if dify_plan else parts):
                try:
                    body, medias = core_send.split_media_marks(raw_part)
                except Exception:  # noqa: BLE001
                    body, medias = raw_part, []
                if body:
                    status, detail, _ = _send_text(
                        store, name, cid, body, route="auto",
                        log_fn=lambda s: log(f"    {s}", scope="send", message_id=mid, trace_id=trace),
                        message_id=mid, trace_id=trace, part=idx + 1, parts=len(parts),
                    )
                    if status != "sent":
                        break
                    confirmed_parts += 1
                elif not confirmed_parts:
                    status, detail = "unknown", "纯媒体段缺少本轮已核验的目标会话，请人工核对"
                    break
                for kind, mname in medias:
                    try:
                        media_status, detail_m = _send_media(
                            store, cid, mname, lambda s: log(f"    {s}", scope="media", message_id=mid, trace_id=trace),
                            route="auto",
                        )
                        log(f"    [媒体] {kind}:{mname} "
                            f"{'成功' if media_status == 'sent' else '失败'}：{detail_m}",
                            level="info" if media_status == "sent" else "warning",
                            scope="media", message_id=mid, trace_id=trace)
                        if media_status == "blocked":
                            status, detail = media_status, detail_m
                            break
                    except Exception as exc:  # noqa: BLE001
                        log(f"    [媒体] {kind}:{mname} 异常（忽略）：{type(exc).__name__}: {exc}",
                            level="warning", scope="media", message_id=mid, trace_id=trace)
                if status == "blocked":
                    break
                if idx < len(parts) - 1:
                    time.sleep(2.0)
            duration_ms = int((time.time() - send_started) * 1000)
            if status == "unknown" or (status in ("failed", "blocked") and confirmed_parts):
                # 回车已按但回读解密库确认不了落点：结果不明。不能记 sent
                #（可能静默丢失），也不能记 failed（下轮自动补发可能重复发送）。
                # 记 unknown 不参与自动补发，核对后只能逐条恢复。
                if confirmed_parts:
                    detail = f"已确认 {confirmed_parts} 条消息，其余未完成：{detail}"
                rlog.mark_unknown(mid, cid, detail, scene, text, partial=bool(confirmed_parts))
                if _brain is not None:
                    _brain.log_delivery(agent_trace_id, "unknown", session_key=cid, detail=detail)
                _last_error = detail[:200]

                if status != "blocked" and not _is_target_miss(detail):
                    _consecutive_send_failures += 1
                stats["unknown"] += 1
                log("wecom_send_hold", level="warning", scope="send", route="auto",
                    message_id=mid, trace_id=trace, duration_ms=duration_ms, confirmed_parts=confirmed_parts)
                break
            elif status == "sent":
                rlog.mark_sent(mid, cid, scene, text, duration_ms=duration_ms, verified=True)
                if _brain is not None:
                    _brain.log_delivery(agent_trace_id, "sent", session_key=cid, detail=detail)
                text_recorded = True

                _consecutive_send_failures = 0
                _last_error = ""
                stats["sent"] += 1
                log(f"    已发送：{detail}", scope="send",
                    message_id=mid, trace_id=trace, duration_ms=duration_ms)

                # Agent 指名要发的媒体：先检索本地 media 目录（本地有就不再
                # 下载），缺了再从 4222 媒体库拉（bridge 通道，设备令牌鉴权），
                # 然后走上游原生 paste_media 真实发送。失败只记日志不影响
                # 文本已发状态，也不自动重发（防重复）。
                for kind, mname in agent_medias:
                    if not mname.strip():
                        continue
                    _last_reply_at = time.time()
                    ok_pre, pre_detail = media_fetch.ensure_media(
                        mname,
                        "视频" if kind == "video" else "图片",
                        base_url=(cfg.get("bridge_server") or "").strip(),
                        token=(cfg.get("bridge_token") or "").strip(),
                        log=lambda s: log(f"    {s}"),
                    )
                    log(f"    [媒体] {mname} 预取：{pre_detail}", scope="media",
                        message_id=mid, trace_id=trace)
                    media_status, detail_m = _send_media(
                        store, cid, mname, lambda s: log(f"    {s}"), route="auto",
                    )
                    ok_m = media_status == "sent"
                    level = "info" if ok_m else "warning"
                    log(f"    [媒体] {kind}:{mname} {'已发送' if ok_m else '发送失败：' + detail_m}",
                        level=level, scope="media", message_id=mid, trace_id=trace)
                    if media_status == "blocked":
                        break

                # 位置卡：客户问定位时服务端给出面试点坐标，文本送达后再补发原生卡。
                # 文本已确认才发；失败只记日志，不重试（防重复、防风控）。
                if agent_card:
                    _last_reply_at = time.time()
                    try:
                        ok_card, detail_card = _send_location_to_recipient(
                            store, cid, agent_card.get("lng"), agent_card.get("lat"),
                            str(agent_card.get("address") or ""), str(agent_card.get("name") or ""),
                            log=lambda s: log(f"    {s}"),
                        )
                    except Exception as exc:  # noqa: BLE001
                        ok_card, detail_card = False, f"{type(exc).__name__}: {exc}"
                    log(f"    [位置卡] {agent_card.get('name') or ''} "
                        f"{'已发送' if ok_card else '发送失败：' + detail_card}",
                        level="info" if ok_card else "warning",
                        scope="media", message_id=mid, trace_id=trace)
            else:
                if status == "blocked" and detail == _RECIPIENT_BLOCKED:
                    rlog.mark_held(mid, cid, detail, scene)
                else:
                    rlog.mark_failed(mid, cid, detail, scene, text)
                if _brain is not None:
                    _brain.log_delivery(agent_trace_id, "failed", session_key=cid, detail=detail)
                _last_error = detail[:200]

                if status == "blocked":
                    stats["blocked"] += 1
                elif _is_target_miss(detail):
                    # 落点不确定不锁全局，只记该条失败
                    stats["failed"] += 1
                else:
                    _consecutive_send_failures += 1
                    stats["failed"] += 1
                log(f"    发送失败：{detail}", level="warning", scope="send",
                    message_id=mid, trace_id=trace, duration_ms=duration_ms)
        except Exception as exc:  # noqa: BLE001
            _last_error = f"发送流程异常（{type(exc).__name__}），请核对实际落点"
            if not text_recorded:
                rlog.mark_unknown(mid, cid, _last_error, scene, text, partial=bool(confirmed_parts))
                if _brain is not None:
                    _brain.log_delivery(agent_trace_id, "unknown", session_key=cid, detail=_last_error)
                stats["unknown"] += 1

            _consecutive_send_failures += 1
            log("    发送流程异常", level="error", scope="send", exception_type=type(exc).__name__,
                message_id=mid, trace_id=trace)
            break

    return stats


def _session_index(store: Store) -> dict[str, str]:
    """会话名 → 真实会话 id（群是 R: 前缀，单聊是 S: 前缀）。读不到返回空字典。

    一次查询同时供两件事用：盲发前校验名字存在、群名换成真实 id 做落点回读。
    """
    try:
        sessions = store.sessions(limit=500)
    except Exception:  # noqa: BLE001
        return {}
    index: dict[str, str] = {}
    for item in sessions:
        name = (item.get("name") or "").strip()
        if name and name not in index:
            index[name] = str(item.get("id") or "")
    return index


def _session_names(store: Store) -> set[str]:
    """企微本地会话表里的全部会话名，用于人工发送前校验目标真实存在。"""
    return set(_session_index(store))


def _normalize_outbound_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def _fragmented_outbound_text(data: object) -> str | None:
    """Decode only the observed text-only WeCom envelope, including every fragment."""
    if not isinstance(data, (bytes, bytearray)):
        return None

    def field(buf, offset, tag):
        if offset >= len(buf) or buf[offset] != tag:
            raise ValueError("unexpected field")
        offset += 1
        length = 0
        for shift in range(0, 35, 7):
            byte = buf[offset]
            offset += 1
            length |= (byte & 0x7f) << shift
            if byte < 0x80:
                end = offset + length
                if end > len(buf):
                    raise ValueError("truncated field")
                return buf[offset:end], end
        raise ValueError("invalid field length")

    fragments = []
    offset = 0
    try:
        while offset < len(data):
            segment, offset = field(data, offset, 0x0a)
            if not segment.startswith(b"\x08\x00"):
                return None
            inner, consumed = field(segment, 2, 0x12)
            text, end = field(inner, 0, 0x0a)
            if consumed != len(segment) or end != len(inner):
                return None
            fragments.append(text.decode("utf-8"))
    except (IndexError, ValueError):
        return None
    return "".join(fragments) if len(fragments) > 1 else None


def _outbound_snapshot(store: Store, contact_id: str, *,
                       fragmented_only: bool = False) -> dict[str, str] | None:
    """Read the decrypted database, preserving the difference between empty and unreadable."""
    try:
        me = store.self_id()
        if not isinstance(me, str) or me in ("", "unknown"):
            return None
        connection = store._conn("message.db")
        if connection is None:
            return None
        with closing(connection):
            rows = connection.execute(
                """SELECT message_id, content FROM message_table
                   WHERE conversation_id=? AND sender_id=? AND content_type IN (2, 573)
                   ORDER BY send_time DESC, message_id DESC LIMIT 100""",
                (contact_id, me),
            ).fetchall()
        if fragmented_only:
            return {str(message_id): _normalize_outbound_text(_fragmented_outbound_text(content) or "")
                    for message_id, content in rows if message_id}
        return {str(message_id): _normalize_outbound_text(_pb_text(content))
                for message_id, content in rows if message_id}
    except Exception:  # noqa: BLE001
        return None


def flush_manual_receipts(bridge, *, force: bool = False) -> bool:
    """Only retry HTTP receipts, including while WeCom is offline."""
    global _last_receipt_retry_at, _last_error
    try:
        server, device = bridge.base_url, bridge.device_code
        pending = rlog.pending_manual_receipts(server, device)
        if not pending:
            return True
        if not force and time.time() - _last_receipt_retry_at < RECEIPT_RETRY_INTERVAL:
            return False
        _last_receipt_retry_at = time.time()
        for item in pending:
            try:
                args = (item["command_id"], item["lease_token"], item["status"], item["message_id"])
                error = item.get("error", "")
                response = bridge.receipt(*args, error) if error else bridge.receipt(*args)
                if response.get("ok") is not True:
                    raise ValueError("Receipt response did not acknowledge success")
                rlog.mark_manual_receipt(server, device, item["command_id"], item["lease_token"], "acked")
                log(f"[回执] #{item['command_id'][:8]} {item['status']} 已确认",
                    scope="manual", command_id=item["command_id"])
            except HTTPError as exc:
                if exc.code in (409, 422):
                    rlog.mark_manual_receipt(server, device, item["command_id"], item["lease_token"], "rejected", f"HTTP {exc.code}; manual review required")
                    _last_error = f"回执冲突待核对：#{item['command_id'][:8]} HTTP {exc.code}"
                    log(f"[回执] {_last_error}", level="warning",
                        scope="manual", command_id=item["command_id"])
                    continue
                raise
        return not bool(rlog.pending_manual_receipts(server, device, limit=1))
    except Exception as exc:  # noqa: BLE001
        _last_error = f"回执未确认：{agent_client.describe_error(exc)}"[:200]
        log(f"[回执] {_last_error}；保留记录，稍后只补传回执", level="warning", scope="manual")
        return False


def _recontact_latest_inbound(store: Store, account: str, cid: str) -> tuple[float, str] | None:
    peer = _recipient_other(account, cid)
    data_dir = getattr(store, "data_dir", None)
    if not peer or not isinstance(data_dir, Path) or not (data_dir / "message.db").is_file():
        return None
    try:
        refresh_store(store)
        database = store._conn("message.db")
        if database is None:
            return None
        with closing(database):
            row = database.execute(
                """SELECT CASE WHEN send_time>32503680000 THEN send_time/1000.0 ELSE send_time END AS stamp,
                          message_id FROM message_table WHERE conversation_id=? AND CAST(sender_id AS TEXT)=?
                   ORDER BY stamp DESC, message_id DESC LIMIT 1""",
                (cid, peer),
            ).fetchone()
        return (_to_ts(row[0]) * 1000, str(row[1])) if row else None
    except (OSError, RuntimeError, TypeError, ValueError, sqlite3.Error):
        return None


def _execute_recontact(store: Store, cfg: dict, bridge, command: dict, log_fn) -> tuple[str, str, str]:
    """Authorize one server-selected part, then use the existing guarded sender."""
    global _last_reply_at, _recipient_proof
    cid = str(command.get("contact_id") or "")
    account = str(command.get("recontact_account_id") or "")
    inbound_before = command.get("recontact_inbound_before_ms")
    inbound_source = str(command.get("recontact_inbound_source") or "")
    kind = command.get("recontact_kind")
    content = command.get("content")
    name = str(command.get("nickname") or "").strip()
    deadline = command["lease_until"]
    if not account or _recipient_account(store) != account:
        return "failed", "本机企微登录账号与复聊指令不匹配", ""
    if (not isinstance(content, str) or not content.strip() or not name or not _recipient_other(account, cid)
            or is_system_conv(cid, name) or type(inbound_before) is not int or inbound_before < 0
            or kind not in ("text", "location", "image", "video")):
        return "failed", "复聊指令缺少有效的内容或会话资料", ""

    path = f"/api/v1/bridge/devices/{quote(bridge.device_code, safe='')}/recontact-check"
    payload = {"command_id": command["id"], "lease_token": command["lease_token"]}
    denial = ""
    last_stamp = last_inbound = None

    def active_account_matches() -> bool:
        try:
            current = find_data_dir()
            return bool(current and isinstance(store.data_dir, Path) and store.data_dir.resolve() == current.resolve()
                        and _recipient_account(store) == account)
        except (OSError, RuntimeError, KeyError):
            return False

    def authorize() -> bool:
        nonlocal denial, last_stamp, last_inbound
        if deadline <= time.time() * 1000:
            denial = "复聊指令已过期"
        elif not active_account_matches():
            denial = "本机企微登录账号已切换或无法核对"
        elif cid in remote_cfg.takeover_sessions() or cid in remote_cfg.abandoned_sessions():
            denial = "会话已接管或结束"
        else:
            try:
                response = bridge._request("POST", path, payload)
            except Exception:  # A missing or interrupted authorization is a veto.
                response = None
            if not isinstance(response, dict) or response.get("ok") is not True:
                denial = str(response.get("reason") or "复聊发送授权未确认") if isinstance(response, dict) else "复聊发送授权未确认"
                return False
            data_dir = getattr(store, "data_dir", None)
            stamp = wal_signature(data_dir) if isinstance(data_dir, Path) else None
            if stamp is None or stamp != last_stamp or last_inbound is None:
                last_inbound = _recontact_latest_inbound(store, account, cid)
                last_stamp = stamp
            if last_inbound is None:
                denial = "无法读取企微会话最新回复"
            elif last_inbound[0] > inbound_before:
                denial = "候选人已回复，复聊停止"
            elif inbound_source and "bridge-inbound:" + sha256(
                json.dumps([bridge.device_code, f"{cid}:{last_inbound[1]}"], ensure_ascii=False, separators=(",", ":")).encode()
            ).hexdigest() != inbound_source:
                denial = "候选人最近一条来信已变化，复聊停止"
            elif deadline <= time.time() * 1000:
                denial = "复聊指令已过期"
            elif not active_account_matches():
                denial = "本机企微登录账号已切换或无法核对"
            else:
                denial = ""
        return not denial

    wait = cfg["cooldown"] - (time.time() - _last_reply_at)
    if wait > 0:
        time.sleep(wait)
    if not authorize():
        return "failed", denial, ""
    if not compat.wait_clipboard_writable(timeout=15):
        return "failed", "剪贴板持续被占用", ""

    if kind in ("text", "location"):
        if not authorize():
            return "failed", denial, ""
        _last_reply_at = time.time()
        status, detail, message_id = _send_text(
            store, name, cid, content, route="recontact", log_fn=log_fn,
            require_recipient=True, authorize=authorize, command_id=command["id"],
        )
    else:
        alias = re.fullmatch(r"dify-asset-[1-9]\d*-([a-f0-9]{64})\.(jpe?g|png|mp4)", content)
        if not alias or (kind == "video") != (alias[2] == "mp4"):
            return "failed", "复聊素材引用无效", ""
        ready, detail = media_fetch.ensure_media(
            content, "图片" if kind == "image" else "视频", base_url=bridge.base_url, token=bridge.token, log=log_fn,
        )
        if not ready:
            return "failed", f"复聊素材未就绪：{detail}", ""
        file = media_fetch.local_file(content)
        if file is None or sha256(file.read_bytes()).hexdigest() != alias[1]:
            return "failed", "复聊素材校验失败", ""
        if _recipient_binding_enabled and not remote_cfg.recipient_binding_account_active(account):
            return "failed", _RECIPIENT_BLOCKED, ""
        binding = deepcopy(remote_cfg.recipient_bindings(account).get(cid)) if _recipient_binding_enabled else None
        term, _ = _resolve_recipient(store, cid, binding)
        if not term or (binding and binding.get("status") != "verified"):
            return "failed", "复聊素材发送前无法核对当前窗口的收件人", ""
        heading = _recipient_heading()
        if not heading or (_recipient_proof != (cid, heading)
                and _recipient_key(_recognize_recipient_heading(heading, term)) != _recipient_key(term)):
            if not authorize():
                return "failed", denial, ""
            _last_reply_at = time.time()
            opened, _, _ = _send_text(
                store, name, cid, "", route="recontact", log_fn=log_fn,
                authorize=authorize, open_only=True, command_id=command["id"],
            )
            proof = _recipient_proof
            if opened != "ready" or not proof or proof[0] != cid:
                return "failed", denial or "复聊素材发送前无法核对收件人会话", ""
            heading = proof[1]
        else:
            _recipient_proof = (cid, heading)

        def authorize_media() -> bool:
            return bool(authorize() and _recipient_heading() == heading and (
                not _recipient_binding_enabled or (
                    remote_cfg.recipient_binding_account_active(account)
                    and remote_cfg.recipient_bindings(account).get(cid) == binding
                )
            ))

        _last_reply_at = time.time()
        status, detail, message_id = _send_agent_media_readback(
            store, cid, content, kind, log_fn, route="recontact", authorize=authorize_media,
        )
    if status == "sent" and message_id.startswith(cid + ":") and message_id[len(cid) + 1:]:
        return "succeeded", "", message_id
    if status in ("sent", "unknown"):
        return "unknown", detail, ""
    return "failed", denial or detail, ""


def pump_commands(
    store: Store,
    cfg: dict,
    *,
    bridge=None,
    wecom_state: str = "online",
    dry: bool = False,
) -> dict:
    """领一条人工指令并用真实键鼠发出（4222 控制台的人工回复/接管）。

    与自动回复的关系（红线）：
    - 和 drain() 跑在同一个线程、同一轮里，天然互斥，不会同时抢键鼠；
    - 复用 `_last_reply_at` 冷却，人工与自动之间也留够间隔；
    - 消息指令只在企微 online 时领——离线领了只能失败，还会把指令锁 60 秒；
    - 登录态下只领刷新二维码指令（kind=refresh_login_qr），不碰消息队列；
    - 未发送的失败回执 failed，执行结果不明确回执 unknown，不自动重发；
    - 自动回复的判定逻辑（知识库、场景、合并）完全不改。

    安全护栏（11-05 事故后补）：键鼠发送靠「搜索会话名 → 回车 → 粘贴」，
    搜索不到目标时焦点会落回当前会话，消息会发给上一个聊天对象。
    所以发送前必须确认目标名在企微会话列表里且不是系统会话；
    发送后再回读解密库，落点不是该 contact_id 就回执 unknown，待人工核对。
    """
    global _last_reply_at, _last_error, _last_claim_at, _last_pump_log_at, _last_ghost_cleanup_at, _last_ghost_cleanup_at
    stats = {"claimed": 0, "sent": 0, "failed": 0}

    if dry or cfg.get("dry_run") or bridge is None or not getattr(bridge, "enabled", False):
        return stats
    if not flush_manual_receipts(bridge):
        return stats
    # 登录态（login_required 等）消息发不出去，但网页可能刚点了「刷新二维码」。
    # 这时只领 refresh_login_qr，绝不碰消息队列——领了也发不出去，还会白占
    # 60 秒租约，把真实待发消息一直往后推。
    now = time.time()
    if now - _last_claim_at < CLAIM_INTERVAL:
        return stats
    _last_claim_at = now
    # 分三种情况领指令（2026-11-26）：
    # 1. 未登录企微 → 只能刷二维码。设置备注要操作窗口，没登录根本做不了，
    #    领了也只会回执失败、白占 60 秒租约。
    # 2. 已登录但发送未就绪（窗口黑掉 / 最小化 / 桌面不可用）→ 只领 set_remark。
    #    改备注是点通讯录，remark.py 会自己抢前台并还原窗口，不依赖发送就绪；
    #    用「发送就绪」当门槛会让备注永久卡在队列里，网页上点了没反应。
    # 3. 正常 → 领消息，和原来一致。
    login_blocked = wecom_state != "online"
    send_blocked = False if login_blocked else not desktop_send_ready("health")[0]
    refresh_only = login_blocked or send_blocked
    only_kind = "refresh_login_qr" if login_blocked else ("set_remark" if send_blocked else "")

    try:
        if not only_kind and isinstance(bridge, agent_client.BridgeClient):
            code = quote(bridge.device_code, safe="")
            response = bridge._request("POST", f"/api/v1/bridge/devices/{code}/claim?recontact=1", {})
            command = response.get("command")
        else:
            command = bridge.claim(only=only_kind)
    except Exception as exc:  # noqa: BLE001
        log(f"[指令] 领取失败（忽略）：{agent_client.describe_error(exc)}")
        return stats
    # 5 分钟一条自检：确认指令泵在跑、领的是哪一类、领到没有。
    # 排查「网页点了刷新没反应」时先看这一行，能立刻区分
    # 「客户端没来领」和「领到了但执行失败」。
    # 每 10 分钟清一次残留黑窗口：不清理的话点击会打在黑窗口上（2026-11-25）
    if now - _last_ghost_cleanup_at >= 600:
        _last_ghost_cleanup_at = now
        hidden = _hide_ghost_windows()
        if hidden:
            log(f"[窗口] 已隐藏 {hidden} 个纯黑的残留企微窗口（切换账号遗留）",
                level="warning", scope="manual")
    # 每 10 分钟清一次残留黑窗口：不清理的话点击会打在黑窗口上（2026-11-25）
    if now - _last_ghost_cleanup_at >= 600:
        _last_ghost_cleanup_at = now
        hidden = _hide_ghost_windows()
        if hidden:
            log(f"[窗口] 已隐藏 {hidden} 个纯黑的残留企微窗口（切换账号遗留）",
                level="warning", scope="manual")
    if now - _last_pump_log_at >= 300:
        _last_pump_log_at = now
        log(f"[指令] 泵运行中：wecom={wecom_state} 领取范围={only_kind or '全部'} "
            f"本轮={'领到指令' if command else '队列为空'} "
            f"桥接={'已配置' if getattr(bridge, 'enabled', False) else '未配置'}")
    if not command:
        return stats

    stats["claimed"] = 1
    cmd_id = str(command.get("id") or "")
    lease = str(command.get("lease_token") or "")
    content = (command.get("content") or "").strip()
    name = (command.get("nickname") or "").strip()
    if not cmd_id or not lease:
        return stats

    def mlog(msg: str, *, level: str | None = None, **fields: object) -> None:
        log(msg, level=level, scope="manual", command_id=cmd_id, **fields)

    # ── 刷新登录二维码指令（2026-11-23）────────────────────────────────
    # 网页点「刷新二维码」→ 服务端写 kind=refresh_login_qr → 这里点登录窗的
    # 「刷新」并立即截一帧上传。动作与 login_refresh 的自动刷新完全一致，
    # 只是由指令提前触发；不新增任何键鼠动作类型。
    if str(command.get("kind") or "message") == "refresh_login_qr":
        ok, detail = login_refresh.click_now(log=mlog)
        if ok:
            pushed = login_qr.LoginQrPusher().push_now(bridge, log=mlog)
            if not pushed:
                ok, detail = False, "已点击刷新，但没有截到新的登录窗（可能正在登录中）"
        try:
            # 成功也带上说明：二维码还有效时不会点击（企微没有「刷新」可点），
            # 这句会显示在网页上，避免用户以为「点了刷新却还是同一张码」。
            bridge.receipt(cmd_id, lease, "succeeded" if ok else "failed", "", detail)
        except Exception as exc:  # noqa: BLE001
            mlog(f"[指令] 刷新二维码回执失败：{agent_client.describe_error(exc)}", level="warning")
        mlog(f"[指令] 刷新二维码：{detail}", level="info" if ok else "warning")
        stats["sent" if ok else "failed"] += 1
        return stats

    # ── 设置客户备注指令（2026-11-25）──────────────────────────────────
    # 同名撞车时运营在网页上点「设置备注」→ 服务端写 kind=set_remark →
    # 这里在**同一条指令泵**里执行（和发消息串行，不会抢焦点）。
    # 动作只有「点击 / 快捷键 / 粘贴」三类，执行完回读本地库确认真的写进去了。
    if str(command.get("kind") or "message") == "set_remark":
        try:
            payload = json.loads(content or "{}")
        except Exception:  # noqa: BLE001
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        conv_id = str(payload.get("conversation_id") or "")
        user_id = str(payload.get("user_id") or "")
        if not user_id and conv_id.startswith("S:"):
            members = conv_id[2:]
            user_id = members.split("_")[-1] if "_" in members else ""
        ok, detail = remark_ui.set_remark(
            str(payload.get("name") or name or ""),
            str(payload.get("remark") or ""),
            log=mlog,
            user_id=user_id,
        )
        # 写完立刻把核验结果报上去，别等客户下一条消息才更新——
        # 原来只有 inbound 时才核验，运营点完按钮界面会一直停在「等待企微核验」。
        if ok and conv_id:
            try:
                account_id = store.self_id() or ""
            except Exception:  # noqa: BLE001
                account_id = ""
            if account_id:
                _queue_recipient_report(account_id, conv_id, "verified", str(payload.get("remark") or ""))
        try:
            bridge.receipt(cmd_id, lease, "succeeded" if ok else "failed", "", detail)
        except Exception as exc:  # noqa: BLE001
            mlog(f"[指令] 设置备注回执失败：{agent_client.describe_error(exc)}", level="warning")
        mlog(f"[指令] 设置备注：{detail}", level="info" if ok else "warning")
        stats["sent" if ok else "failed"] += 1
        return stats

    if refresh_only:
        # 旧服务端不认 only 参数时会把消息指令发过来：未登录不能发，
        # 也不能回执（回执会把它标成失败）。不回执，等 60 秒租约自然回收。
        mlog("[指令] 当前企微窗口不可用于发送，等待消息指令租约回收", level="warning")
        return stats

    try:
        if not rlog.begin_manual_command(bridge.base_url, bridge.device_code, cmd_id, lease):
            mlog(f"[指令] #{cmd_id[:8]} 已有执行记录，本轮不再发送")
            return stats
    except Exception as exc:  # noqa: BLE001
        _last_error = f"人工指令记录写盘失败：{type(exc).__name__}"[:200]
        mlog(f"[指令] {_last_error}；停止该条发送", level="warning")
        stats["failed"] += 1
        return stats
    recontact = command.get("kind") == "recontact"
    if recontact:
        mlog(f"[指令] 复聊发送 #{cmd_id[:8]}")
    else:
        mlog(f"[指令] 人工发送 #{cmd_id[:8]} → {name or '(无昵称)'}：{_redact_text(content, 30)!r}")

    def receipt(status: str, message_id: str = "", *, error: str = "") -> None:
        try:
            rlog.finish_manual_command(bridge.base_url, bridge.device_code, cmd_id, lease, status, message_id, error=error)
        except Exception as exc:  # noqa: BLE001
            mlog(f"    回执 {status} 写盘失败，保留 unknown：{type(exc).__name__}", level="warning")
            return
        flush_manual_receipts(bridge, force=True)

    def stop_if_lease_invalid() -> bool:
        global _last_error
        deadline = command.get("lease_until")
        try:
            valid = type(deadline) in (int, float) and math.isfinite(deadline) and deadline > time.time() * 1000
        except OverflowError:
            valid = False
        if valid:
            return False
        _last_error = "人工指令租约已过期或无效，停止发送并保留 unknown，请人工核对"
        mlog(f"    {_last_error}", level="warning")
        receipt("unknown")
        stats["failed"] += 1
        return True

    # Socket timeouts do not bound a streaming response's total duration.
    if stop_if_lease_invalid():
        return stats

    if recontact:
        try:
            status, detail, mid = _execute_recontact(store, cfg, bridge, command, mlog)
        except Exception as exc:
            status, detail, mid = "unknown", f"复聊执行异常（{type(exc).__name__}），请核对实际发送", ""
        if detail:
            mlog(f"复聊发送结果：{detail}", level="warning")
        receipt(status, mid, error=detail)
        stats["sent" if status == "succeeded" else "failed"] += 1
        return stats

    if not content or not name:
        mlog("    跳过：指令缺少昵称或内容", level="warning")
        receipt("failed")
        stats["failed"] += 1
        return stats

    # 盲发护栏：目标必须是企微里真实存在的非系统会话，否则键盘搜索落空时
    # 消息会被上一个打开的真实客户收走（11-05 已发生一次）。
    contact_id = str(command.get("contact_id") or "")
    sessions_by_name = _session_index(store)
    names = set(sessions_by_name)
    # 群和个人同一条发送链路，但入队的 contact_id 有两种：真实会话 id（S:/R:），
    # 或者群名（Agent 推群就是这样）。发送前统一换成真实 id——回读落点、回执
    # message_id 都用它；换成 R: 之后系统会话判定也不会再按群名误杀。
    if contact_id and not contact_id.startswith(("S:", "R:")):
        resolved = sessions_by_name.get(name, "")
        if resolved:
            if resolved != contact_id:
                mlog(f"    目标会话「{name}」→ {resolved}")
            contact_id = resolved
    # 换账号护栏（2026-11-24）：企微切过账号后，本地会话表和服务端会话里仍留着
    # 别的账号的会话（实测 Daylan 属于 1688854931904397，当前登录 1688855894882096）。
    # 这类会话在企微里搜不到，回车会落回当前会话，消息直接发给上一个客户——
    # 14:17 实测那条自检消息就落到了「小u」。单聊 id 形如 S:<A>_<B>，自己必在其中
    # 之一；两个 id 都不是自己就说明是别的账号的会话，直接拒绝，不碰窗口。
    me_id = str(store.self_id() or "")
    if me_id and contact_id.startswith("S:"):
        parts = contact_id[2:].split("_")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit() and me_id not in parts[:2]:
            mlog(f"    拒绝发送：目标会话属于账号 {parts[0]}/{parts[1]}，当前登录 {me_id}"
                 f"（换账号前的历史会话，企微搜不到会发错人）", level="warning")
            receipt("failed")
            stats["failed"] += 1
            return stats
    if is_system_conv(contact_id, name):
        mlog(f"    拒绝发送：{name} 是系统/官方会话，人工发送不允许", level="warning")
        receipt("failed")
        stats["failed"] += 1
        return stats
    def verify_group() -> bool:
        try:
            stamp = _group_source_stamp(store)
            if stamp is not None and stamp != getattr(store, "_group_source_stamp", None):
                refresh_store(store)
            valid = bool(_group_conversations(store, (contact_id, name)))
        except Exception:
            valid = False
        if not valid:
            mlog("    拒绝发送：本机企微无法唯一核对目标群", level="warning")
            receipt("failed")
            stats["failed"] += 1
        return valid

    if contact_id.startswith("R:"):
        if not verify_group():
            return stats
    elif names and name not in names:
        mlog(f"    拒绝发送：{name} 不在企微会话列表，避免搜索落空后发错人", level="warning")
        receipt("failed")
        stats["failed"] += 1
        return stats
    elif not names:
        # 读不到会话列表就无法确认落点，宁可失败也不能盲发。
        mlog("    拒绝发送：读不到企微会话列表，无法确认目标会话", level="warning")
        receipt("failed")
        stats["failed"] += 1
        return stats

    # 与自动回复共用冷却：同一时间只允许一个发送者，且两条消息之间留间隔。
    # 媒体标记剥离（G2）：人工指令同样支持【图片:x】/【视频:x】，
    # 剥离后的文本才是真正要发的内容（回读比对也用它）。
    try:
        content, cmd_medias = core_send.split_media_marks(content)
    except Exception:  # noqa: BLE001  测试 stub/异常环境回退：按纯文本发
        content, cmd_medias = content, []
    if not content and cmd_medias:
        # 纯媒体指令：没有文本可供回读确认落点，贴完媒体后回执 unknown 待人工核对
        mlog("    纯媒体指令（无文本），贴完媒体后需人工核对落点", level="warning")
        media_attempted = False
        for kind, mname in cmd_medias:
            try:
                media_status, detail_m = _send_media(store, contact_id, mname, lambda s: mlog(f"    {s}"), route="manual")
                if media_status == "blocked":
                    break
                media_attempted = True
                ok_m = media_status == "sent"
                mlog(f"    [媒体] {kind}:{mname} {'成功' if ok_m else '失败'}：{detail_m}",
                     level="info" if ok_m else "warning")
            except Exception as exc:  # noqa: BLE001
                media_attempted = True
                mlog(f"    [媒体] {kind}:{mname} 异常（忽略）：{type(exc).__name__}: {exc}",
                     level="warning")
        receipt("unknown" if media_attempted else "failed")
        stats["failed"] += 1
        return stats
    wait = cfg["cooldown"] - (time.time() - _last_reply_at)
    if wait > 0:
        time.sleep(wait)

    if stop_if_lease_invalid():
        return stats
    clipboard_ready = compat.wait_clipboard_writable(timeout=15)
    if stop_if_lease_invalid():
        return stats
    if not clipboard_ready:
        _last_error = "剪贴板被占用超过 15 秒"
        mlog("    失败：剪贴板被占用（向日葵同步？）", level="warning")
        receipt("failed")
        stats["failed"] += 1
        return stats

    before = _outbound_snapshot(store, contact_id)
    if stop_if_lease_invalid():
        return stats
    if contact_id.startswith("R:") and not verify_group():
        return stats
    if contact_id.startswith("R:") and stop_if_lease_invalid():
        return stats
    # 与自动回复同一口径：按键前更新冷却，失败也算一次企微操作，
    # 不给"失败后立即重试/下一条"留零成本通道。
    _last_reply_at = time.time()
    manual_started = time.time()
    status, detail, message_id = _send_text(
        store, name, contact_id, content, route="manual", command_id=cmd_id,
        readback_before=before, log_fn=lambda s: mlog(f"    {s}"),
    )
    manual_duration = int((time.time() - manual_started) * 1000)
    if status == "sent":
        # Only a verified text landing authorizes its attachments.
        for kind, mname in cmd_medias:
            try:
                media_status, detail_m = _send_media(store, contact_id, mname, lambda s: mlog(f"    {s}"), route="manual")
                if media_status == "blocked":
                    _last_error = detail_m[:200]
                    mlog("    文本已通过回读，附件未执行发送，待核对", level="warning", message_id=message_id)
                    receipt("unknown", message_id)
                    stats["failed"] += 1
                    return stats
                ok_m = media_status == "sent"
                mlog(f"    [媒体] {kind}:{mname} {'已执行发送' if ok_m else '失败'}：{detail_m}",
                     level="info" if ok_m else "warning")
            except Exception as exc:  # noqa: BLE001
                mlog(f"    [媒体] {kind}:{mname} 异常（忽略）：{type(exc).__name__}: {exc}", level="warning")
        _last_reply_at = time.time()
        _last_error = ""
        stats["sent"] += 1
        mlog("    已发送：目标会话中唯一的新消息 ID 已确认",
             message_id=message_id, duration_ms=manual_duration)
        receipt("succeeded", message_id)
    else:
        _last_error = detail[:200]
        stats["failed"] += 1
        mlog(f"    {detail}", level="warning", duration_ms=manual_duration)
        receipt("failed" if status == "blocked" else status)
    return stats


def pump_refresh_only(cfg: dict, bridge, wecom_state: str) -> None:
    """登录前等待循环里的精简指令泵：只领「刷新二维码」。

    为什么单独一个函数：主循环的 pump_safely 依赖 store（消息指令要用它读会话
    名单），而 store 要等企微登录后才能建。但二维码过期恰好只发生在登录前，
    所以这条路上必须有一个不依赖 store 的入口。

    pump_commands 里 `login_only=True` 时会先处理刷新指令，其余指令直接跳过
    并等租约回收，因此传 store=None 是安全的：走不到任何用 store 的分支。
    """
    try:
        pump_commands(None, cfg, bridge=bridge, wecom_state=wecom_state,
                      dry=bool(cfg.get("dry_run")))
    except Exception as exc:  # noqa: BLE001
        log(f"[指令] 等待登录时领取失败（忽略）：{type(exc).__name__}: {exc}")


def pump_safely(store: Store, cfg: dict, reporter: "Reporter | None", wecom_state: str) -> None:
    """pump_commands 的安全外壳：任何异常都不许冒泡到主循环。"""
    global _last_pump_entry_at
    try:
        bridge = reporter.bridge if reporter is not None else None
        now = time.time()
        # 60 秒一条入口探针：排查「网页点了刷新没反应」时，第一眼看这里就能
        # 区分是泵没被调用、桥接没配、还是状态判断把消息队列挡了。
        if now - _last_pump_entry_at >= 60:
            _last_pump_entry_at = now
            log(f"[指令] 泵入口 reporter={'有' if reporter is not None else '无'} "
                f"bridge={'有' if bridge is not None else '无'} "
                f"enabled={getattr(bridge, 'enabled', None)} wecom={wecom_state} "
                f"dry={cfg.get('dry_run')}")
        pump_commands(
            store,
            cfg,
            bridge=bridge,
            wecom_state=wecom_state,
            dry=bool(cfg.get("dry_run")),
        )
    except Exception as exc:  # noqa: BLE001
        log(f"[指令] 本轮异常（忽略）：{type(exc).__name__}: {exc}")


def print_history(limit: int = 20) -> None:
    manual = rlog.recent_manual_receipts(limit)
    if manual:
        print("人工回执（执行结果 / 上报状态）：")
        for item in manual:
            print(f"  {item['command_id']} {item['status']} / {item['receipt_state']} {item['error']}")
    recoveries = rlog.recent_reply_recoveries(limit)
    if recoveries:
        print("逐条恢复记录")
        for item in recoveries:
            print(f"  {item['conv_id']} / {item['message_id']}  {item['previous_status']} → {item['outcome']}")
    rows = rlog.recent(limit)
    if not rows:
        print("还没有记录")
        return
    print(f"{'状态':<9}{'收到时间':<18}{'会话':<18}{'内容':<24}回复")
    for r in rows:
        t = time.strftime("%m-%d %H:%M:%S", time.localtime(r["msg_time"] or 0))
        # 不用 ⚠ 这类符号：Windows 控制台默认 GBK，遇到不可编码字符会直接
        # UnicodeEncodeError 中断整条命令（历史列表尤其容易踩到）。
        err = f"  [!] {r['error'][:40]}" if r["error"] and r["status"] != "sent" else ""
        print(f"{r['status']:<9}{t:<18}{(r['conv_name'] or '')[:16]:<18}"
              f"{(r['in_text'] or '')[:20]!r:<24}{r['reply_text'] or '-'}{err}"
              f"  [{r['conv_id']} / {r['message_id']}]")
    print("\n统计:", rlog.stats())


class LoginBridgeClient(agent_client.BridgeClient):
    """Restore the one-time retrieval contract used by the installed login helper."""

    def fetch_verify_code(self) -> dict:
        code = quote(self.device_code, safe="")
        return self._request("GET", f"/api/v1/agent/devices/{code}/verify-code")


def _make_bridge(cfg: dict, device_code: str) -> agent_client.BridgeClient | None:
    """按 config.json 建桥接客户端；没配 bridge_server/bridge_token 就返回 None。"""
    bserver = (cfg.get("bridge_server") or "").strip()
    btoken = (cfg.get("bridge_token") or "").strip()
    if not bserver or not btoken:
        log("[桥接] 未配置 bridge_server / bridge_token，跳过桥接上报")
        return None
    bridge = LoginBridgeClient(bserver, btoken, device_code)
    if not bridge.enabled:
        log("[桥接] device_code 缺失，跳过桥接上报")
        return None
    log(f"[桥接] 目标 {bserver} / device_code={bridge.device_code}")
    return bridge


def _make_reporter(cfg: dict, store: Store) -> Reporter | None:
    """按 config.json 建心跳/上报器；没配 server/device_token 就返回 None。

    注意：Reporter 只发 HTTP，任何失败都不会影响下面的发送逻辑。
    """
    server = (cfg.get("server") or "").strip()
    token = (cfg.get("device_token") or "").strip()
    code = resolve_device_code(cfg)
    api = None
    if server and token:
        api = agent_client.AgentClient(server, token, device_code=code)
    bridge = _make_bridge(cfg, code)
    # 云端部署只走桥接（bridge_server 指向隧道），没有 server/device_token——
    # 此时也要建 Reporter，否则桥接心跳和消息上报永远不会跑。
    if api is None and bridge is None:
        log("[心跳] 未配置 server/device_token 与桥接，心跳和上报全部跳过")
        return None
    if api is None:
        log("[心跳] 未配置 server / device_token：跳过服务端心跳与上报，仅桥接心跳")
    rep = Reporter(api, store, device_code=code, bridge=bridge, cfg=cfg)
    if rep.device_code:
        log(f"[心跳] 目标 {server} / device_code={rep.device_code}")
    else:
        log(
            "[心跳] 没有 device_code：config.json 加 \"device_code\"、"
            "或传 --device-code、或设环境变量 AGENT_DEVICE_CODE（上报不受影响）"
        )
    return rep


def ensure_registration(cfg: dict, cfg_path: Path | None = None) -> dict:
    """缺 token 时自动注册（方案 A），并把结果写回 config.json。

    只在「配了 register_key 且 token 缺失」时才联网，已有 token 的机器启动
    路径与以前完全一致——不让自注册影响到正在跑的客户端。
    任何失败都只打日志不抛异常：注册是便利，不是可用性的前提。
    """
    key = (cfg.get("register_key") or "").strip()
    if not key:
        return cfg
    server = (cfg.get("server") or "").strip()
    bridge_server = (cfg.get("bridge_server") or "").strip()
    has_token = bool((cfg.get("device_token") or "").strip())
    has_bridge = bool((cfg.get("bridge_token") or "").strip())
    if has_token and (has_bridge or not bridge_server):
        return cfg
    code = (cfg.get("device_code") or "").strip() or agent_register.derive_device_code()
    name = (cfg.get("device_name") or "").strip()
    try:
        obtained = agent_register.register(server, key, code, name, bridge_server)
    except (ValueError, OSError) as exc:
        log(f"[注册] 失败：{exc}")
        return cfg
    if not obtained:
        log("[注册] 服务端未返回 token（自注册可能未开启）")
        return cfg
    obtained.setdefault("device_code", code)
    cfg.update(obtained)
    try:
        agent_register.write_back(cfg_path or (ROOT / "config.json"), obtained)
        log(f"[注册] 完成 device_code={code}，已写回 config.json")
    except OSError as exc:
        log(f"[注册] 拿到 token 但写回失败：{exc}")
    return cfg


def load_config(args: argparse.Namespace, config_path: Path | None = None) -> dict:
    """Apply defaults, file settings, then explicitly supplied CLI options."""
    cfg = dict(DEFAULTS, dry_run=False)
    cfg_path = config_path if config_path is not None else ROOT / "config.json"
    if cfg_path.exists():
        try:
            file_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError("config.json could not be read; refusing to send") from exc
        if not isinstance(file_cfg, dict):
            raise ValueError("config.json must contain an object")
        for key in (*DEFAULTS, "dry_run"):
            if key in file_cfg:
                cfg[key] = file_cfg[key]
        for flag in ("verify_direct_chat_heading", "enable_recipient_binding"):
            if flag in file_cfg:
                if type(file_cfg[flag]) is not bool:
                    raise ValueError(f"{flag} must be true or false")
                cfg[flag] = file_cfg[flag]
        if "interval" not in file_cfg and "interval_seconds" in file_cfg:
            cfg["interval"] = file_cfg["interval_seconds"]
        for key in ("server", "device_token", "device_code", "bridge_server", "bridge_token"):
            value = file_cfg.get(key, "")
            if not isinstance(value, str):
                raise ValueError(f"{key} must be a string")
            cfg[key] = value.strip()

    for key, value in vars(args).items():
        if key in DEFAULTS or key == "device_code":
            cfg[key] = value.strip() if key == "device_code" else value
    if getattr(args, "dry", False):
        cfg["dry_run"] = True
    if not isinstance(cfg["dry_run"], bool):
        raise ValueError("dry_run must be true or false")
    if not isinstance(cfg["data_dir"], str):
        raise ValueError("data_dir must be a string")
    cfg["data_dir"] = cfg["data_dir"].strip()
    for key in ("target", "reply_first", "reply_next"):
        if not isinstance(cfg[key], str) or not cfg[key].strip():
            raise ValueError(f"{key} must be a nonempty string")
    for key in ("interval", "cooldown", "backfill_hours"):
        value = cfg[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{key} must be a number")
        if not math.isfinite(value) or value < 0 or (key == "interval" and value == 0):
            raise ValueError(f"{key} has an invalid duration")
    if cfg["brain"] is not None and not isinstance(cfg["brain"], dict):
        raise ValueError("brain must contain an object")
    bcfg = cfg.get("brain") or {}
    if bcfg and bcfg.get("mode") not in ("agent", "fixed"):
        raise ValueError("brain.mode must be agent or fixed")
    return cfg


def configured_data_dir(cfg: dict, *, require_files: bool = True) -> Path | None:
    value = cfg["data_dir"]
    if not value:
        return None
    directory = Path(value)
    if not directory.is_absolute():
        raise ValueError("data_dir must be an absolute path")
    if require_files:
        try:
            if not directory.is_dir() or not all((directory / name).is_file() for name in ("message.db", "session.db")):
                raise ValueError("data_dir must contain message.db and session.db")
        except OSError as exc:
            raise ValueError("data_dir could not be inspected") from exc
    return directory


# 单实例锁：两个进程同时跑会同时抢前台、同时发消息，客户收到重复回复。
# 2026-11-07 实测出现过。用命名互斥体，进程退出时由系统释放。
#
# 2026-11-14 修正：原来只在 --watch 时加锁，但不带 --watch 的默认模式同样会
# 调 drain() + pump_safely() 真正发消息，所以「开着一个常驻 + 误点一次快捷方式」
# 就会出现两个进程同时回。现在改成「只要会发消息就必须过这把锁」，
# 只排除 --list / --reset 这类完全不碰键鼠的一次性命令。
MUTEX_NAME = "Global\\CityRecruitAutopilot"
_mutex_handle = None
_mutex_owner_pid = 0


def acquire_single_instance() -> bool:
    """拿到进程锁返回 True；已有实例在跑返回 False。

    注意失败关闭：拿不到句柄时返回 False（拒绝启动），而不是放行。
    放行等于在系统异常时允许双开，而双开的代价是客户收到重复回复。

    同一进程内重复调用直接返回 True。命名互斥体归「进程」所有，而模块可能被
    重新加载（测试用 load_autopilot 反复 import、将来做重启逻辑也一样）：
    重载会把模块级全局变量清空，但内核里的互斥体还握在本进程手上。所以归属
    记录挂在 sys 上（进程内单例，不随模块重载丢失），而不是只放模块全局。
    """
    global _mutex_handle, _mutex_owner_pid
    pid = os.getpid()
    claim_key = f"_cityrecruit_mutex_owner::{MUTEX_NAME}"
    if getattr(sys, claim_key, 0) == pid:
        return True
    if _mutex_handle and _mutex_owner_pid == pid:
        return True
    # 命名互斥体是 Windows 机制。非 Windows（CI / Linux 服务端）没有可争用的客户端，
    # 直接放行；「失败关闭」只在 Windows 上生效，生产行为不变。
    if sys.platform != "win32":
        return True
    try:
        kernel32 = ctypes.windll.kernel32
        ERROR_ALREADY_EXISTS = 183
        handle = kernel32.CreateMutexW(None, True, MUTEX_NAME)
        if not handle:
            return False
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        _mutex_handle = handle
        _mutex_owner_pid = pid
        setattr(sys, claim_key, pid)
        return True
    except Exception:  # noqa: BLE001
        # Windows 上互斥体建不出来（极端环境）：宁可拦住，也不要冒双开的风险
        return False


def release_single_instance() -> None:
    """释放进程锁（进程退出时系统也会释放，这里用于同进程内的显式收尾）。"""
    global _mutex_handle, _mutex_owner_pid
    if _mutex_handle:
        try:
            ctypes.windll.kernel32.CloseHandle(_mutex_handle)
        except Exception:  # noqa: BLE001
            pass
    _mutex_handle = None
    _mutex_owner_pid = 0
    claim_key = f"_cityrecruit_mutex_owner::{MUTEX_NAME}"
    if hasattr(sys, claim_key):
        delattr(sys, claim_key)


def main() -> int:
    try:  # 日志/控制台 GBK 容错：emoji 一律 replace，绝不因日志崩业务
        sys.stdout.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser(description="企业微信自动回复（队列 + 回复历史）")
    ap.add_argument("--target", default=argparse.SUPPRESS, help="all 或某个会话名")
    ap.add_argument("--data-dir", default=argparse.SUPPRESS, help="企微 Data 目录绝对路径，覆盖 config.json")
    ap.add_argument("--reply-first", default=argparse.SUPPRESS)
    ap.add_argument("--reply-next", default=argparse.SUPPRESS)
    ap.add_argument("--interval", type=float, default=argparse.SUPPRESS)
    ap.add_argument("--cooldown", type=float, default=argparse.SUPPRESS)
    ap.add_argument("--backfill-hours", type=float, default=argparse.SUPPRESS)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--dry", action="store_true", help="只登记不发送")
    ap.add_argument("--list", nargs="?", const=20, type=int, metavar="LIMIT", help="打印回复历史（默认 20 条）")
    ap.add_argument("--reset", action="store_true", help="把待发/失败的条目全部作废")
    ap.add_argument("--retry-held", action="store_true", help="重新排队生成回复前就暂停的 Agent 记录")
    ap.add_argument("--retry-message", nargs=2, metavar=("CONV_ID", "MESSAGE_ID"), help="登记单条消息恢复")
    ap.add_argument("--verified-unsent", action="store_true", help="已核对企微记录，确认可恢复该条")
    ap.add_argument("--legacy-sent", action="store_true", help="账本旧版已发记录经人工确认有误")
    ap.add_argument("--reason", help="单条恢复的核对说明")
    ap.add_argument("--flush-receipts", action="store_true", help="仅补传人工回执后退出，不操作企微")
    ap.add_argument("--device-code", default=argparse.SUPPRESS, help="设备编号，覆盖 config.json（心跳路径参数）")
    args = ap.parse_args()
    if args.list is not None and args.list < 1:
        ap.error("--list 条数必须大于零")
    if args.retry_message:
        if not args.verified_unsent or not (args.reason or "").strip():
            ap.error("--retry-message 需要 --verified-unsent 和 --reason")
        if any((args.list, args.reset, args.retry_held, args.flush_receipts, args.once, args.watch, args.dry)):
            ap.error("--retry-message 必须单独执行")
        conv_id, message_id = (value.strip() for value in args.retry_message)
        if not conv_id or not message_id:
            ap.error("会话编号和消息编号不能为空")
        rlog.init()
        result = rlog.queue_reply_recovery(conv_id, message_id, reason=args.reason,
                                           operator=getpass.getuser(), legacy_sent=args.legacy_sent)
        messages = {
            "queued": "消息已重新排队，等待客户端处理",
            "already_queued": "这条消息已在恢复队列",
            "in_progress": "这条消息还在发送中或等待客户端确认上次中断",
            "partial": "已有部分内容发出，请人工补齐缺失部分",
            "not_found": "本机账本中找不到这条消息",
            "not_eligible": "这条消息的状态不符合所选恢复方式，请核对企微出站和账本",
            "superseded": "该会话已有更新的客户消息",
            "welcome_pending": "该会话的首句发送仍待核对",
        }
        log(messages[result], scope="send", event="reply_recovery_request", outcome=result,
            conv_id=conv_id, message_id=message_id)
        return 0 if result in ("queued", "already_queued") else 1
    if args.verified_unsent or args.legacy_sent or args.reason is not None:
        ap.error("--verified-unsent、--legacy-sent 和 --reason 仅用于 --retry-message")

    # 单实例：只要这次运行会碰企微（发消息 / 抢前台），就必须过同一把锁。
    # 这些命令不发送、不按键鼠，允许并行：
    #   --list / --reset            纯本地读/改回复历史
    #   --retry-held                只把暂停记录重新入队，不发送
    #   --flush-receipts            只补传人工回执，不操作企微
    local_only = args.list or args.reset or args.retry_held or args.flush_receipts
    if not local_only and not acquire_single_instance():
        log("已有客户端实例在运行，本进程退出（避免两个进程同时发消息）")
        return 0

    try:
        cfg = load_config(args)
    except ValueError as exc:
        log(f"Configuration error: {exc}")
        return 2

    # 自注册只读配置、只发 HTTP，不影响下面的发送逻辑；失败了就按原样继续。
    cfg = ensure_registration(cfg, ROOT / "config.json")

    rlog.init()
    if not local_only and not cfg["dry_run"]:
        rlog.recover_interrupted_replies()
    # 媒体目录每次启动确保存在（G2：C:\agent\media，不存在即创建）
    try:
        core_send.ensure_media_dir()
        log(f"媒体目录 {core_send.media_dir()} 就绪")
    except Exception as exc:  # noqa: BLE001
        log(f"[媒体] 目录初始化失败（忽略）：{type(exc).__name__}: {exc}")
    if args.flush_receipts:
        if cfg["dry_run"]:
            log("DRY-RUN，未补传回执")
            return 0
        bridge = _make_bridge(cfg, resolve_device_code(cfg))
        if bridge is None:
            return 2
        complete = flush_manual_receipts(bridge, force=True)
        counts = rlog.manual_receipt_counts(bridge.base_url, bridge.device_code)
        log(f"人工回执：{counts}")
        return 0 if complete and not counts.get("rejected") else 1

    global _brain, _guard_recipient, _recipient_binding_enabled
    _guard_recipient = cfg.get("verify_direct_chat_heading", False)
    _recipient_binding_enabled = bool(cfg.get("enable_recipient_binding") and
                                      cfg.get("bridge_server") and cfg.get("bridge_token"))
    _brain = build_brain(cfg, log)
    cfg["_reply_mode_enabled"] = bool(_brain is not None and hasattr(_brain, "sync_reply_mode"))

    if args.retry_held:
        log(f"生成前暂停的 Agent 记录重新入队 {rlog.retry_held()} 条")
        return 0

    if args.list:
        print_history(args.list)
        return 0

    write_client_state("starting", detail="正在检查企业微信登录状态")
    try:
        # Validate the shape of an explicit path now, but defer file existence
        # until after the login probe.  A logged-out WXWork may not have opened
        # its database files yet; that must still reach the QR wait state.
        data_dir = configured_data_dir(cfg, require_files=False)
    except ValueError as exc:
        write_client_state("failed", detail="配置中的企业微信数据目录不可用", error=str(exc))
        log(f"Configuration error: {exc}")
        return 2

    # Establish QR/code handling before Store.refresh().  Database key
    # extraction is allowed to fail while WXWork is still on its login page;
    # that must not prevent the QR from reaching the web console.
    remote_client = _make_bridge(cfg, resolve_device_code(cfg))
    runtime_bridge = _make_bridge(cfg, resolve_device_code(cfg))
    runtime_heartbeat = RuntimeHeartbeat(runtime_bridge) if runtime_bridge is not None else None
    if runtime_heartbeat is not None:
        runtime_bridge.timeout = min(runtime_bridge.timeout, 5)
        runtime_heartbeat.start()
    qr_pusher = login_qr.LoginQrPusher()
    code_fetcher = login_code.LoginCodeFetcher()

    def probe_wecom() -> str:
        state = detect_wecom_state()
        log(f"[自检] 企微状态 {state}（{WECOM_STATE_TEXT.get(state, '未知')}）")
        login_watch.alert_login_required(state, log=log)
        login_refresh.maybe_refresh_expired_qr(log=log)
        qr_state = "login_required" if _consecutive_send_failures >= 2 else state
        qr_pusher.tick(qr_state, remote_client, log=log)
        code_fetcher.tick(state, remote_client, log=log)
        if runtime_heartbeat is not None:
            runtime_heartbeat.observe(state, reason="wechat_login" if state == "login_required" else "starting")
        return state

    wecom_state = probe_wecom()
    if wecom_state != "online":
        startup_status = "waiting_login" if wecom_state == "login_required" else "waiting_wecom"
        detail = "等待扫码登录企业微信" if startup_status == "waiting_login" else "等待打开企业微信"
        write_client_state(startup_status, detail=detail, wecom_state=wecom_state)
        if not args.watch:
            log(detail)
            return 0
        log(f"{detail}；数据库初始化将在登录成功后开始")
        while wecom_state != "online":
            try:
                _check_reply_mode(wecom_state)
                # 登录前也要领指令（2026-11-23）：主循环的指令泵要等登录成功、
                # 数据库初始化后才进得去，而二维码过期恰恰只发生在登录前——
                # 网页点「刷新二维码」的指令就永远躺在队列里没人领。
                # 这里复用同一个 pump_commands（store 还没建，传 None），
                # login_only 分支保证只领 refresh_login_qr，绝不碰消息队列。
                pump_refresh_only(cfg, remote_client, wecom_state)
                time.sleep(cfg["interval"])
                wecom_state = probe_wecom()
                startup_status = "waiting_login" if wecom_state == "login_required" else "waiting_wecom"
                detail = "等待扫码登录企业微信" if startup_status == "waiting_login" else "等待打开企业微信"
                write_client_state(startup_status, detail=detail, wecom_state=wecom_state)
            except KeyboardInterrupt:
                write_client_state("stopped", detail="用户停止启动")
                return 0

    try:
        data_dir = configured_data_dir(cfg)
    except ValueError as exc:
        write_client_state("failed", detail="企业微信数据库文件不可用", wecom_state=wecom_state, error=str(exc))
        log(f"Configuration error: {exc}")
        return 2
    write_client_state("initializing", detail="企业微信已登录，正在初始化本地数据库", wecom_state=wecom_state)
    store = Store(data_dir=data_dir) if data_dir is not None else Store()
    if not store.data_dir:
        detail = "没找到企业微信数据目录"
        write_client_state("failed", detail=detail, wecom_state=wecom_state, error=detail)
        log(detail)
        return 1
    log(f"数据目录 {store.data_dir}")
    scope = "全部会话（排除系统会话）" if cfg["target"] == "all" else f"仅 {cfg['target']!r}"
    log(f"监听范围 {scope} / 首次 {cfg['reply_first']!r} · 后续 {cfg['reply_next']!r} / "
        f"冷却 {cfg['cooldown']}s" + (" / DRY-RUN" if cfg["dry_run"] else ""))

    try:
        last_sig = wal_signature(store.data_dir)
        refresh_store(store)
    except Exception as exc:  # noqa: BLE001
        detail = f"数据库初始化失败：{type(exc).__name__}: {exc}"
        write_client_state("failed", detail=detail, wecom_state=wecom_state, error=str(exc))
        log(detail)
        traceback.print_exc(limit=2)
        return 1

    if args.reset:
        n = 0
        for it in rlog.pending(include_failed=True, limit=5000):
            rlog.mark_skipped(it["message_id"], it["conv_id"], "手动 reset")
            n += 1
        log(f"已作废 {n} 条待发/失败记录")
        print_history(12)
        return 0

    bootstrap(store, cfg)
    st = rlog.stats()
    log(f"回复记录：{st}")
    leftover = st.get("pending", 0) + st.get("failed", 0)
    if leftover:
        log(f"有 {leftover} 条待补发（含上次失败/未发的），本轮会处理")

    reporter = _make_reporter(cfg, store)
    if reporter is not None:
        reporter.runtime_heartbeat = runtime_heartbeat

    def reception_ready(state: str) -> bool:
        allowed = _check_reply_mode(state, reporter)
        if runtime_heartbeat is not None:
            mode = getattr(_brain, "reply_mode_status", {})
            issue = mode.get("local_issue", "") if isinstance(mode, dict) else ""
            if state == "login_required":
                reason = "wechat_login"
            elif state != "online":
                reason = "wechat_unavailable"
            elif issue == "auth":
                reason = "authorization"
            elif not _reply_desktop_active():
                reason = "desktop_unavailable"
            elif allowed and not cfg.get("dry_run"):
                if not desktop_send_ready("health")[0]:
                    reason = "desktop_unavailable"
                else:
                    reason = "auto_send_failed" if _consecutive_send_failures else "ready"
            else:
                reason = "reply_paused"
            runtime_heartbeat.observe(state, str(store.self_id() or ""), reason, reporter)
        return allowed

    # 远端配置（Node 4222 下发）：启动拉一次，成功则合并运行参数并缓存
    # config.remote.json；拉不到时 RemoteConfig 内部用缓存兜底，只记一行日志。
    # cfg 是全局共享字典，interval/cooldown 在主循环下一轮即时生效。
    remote_client = reporter.bridge if reporter is not None else _make_bridge(cfg, resolve_device_code(cfg))
    if remote_client is not None:
        remote = remote_cfg.RemoteConfig(remote_client, log_fn=log)
        remote.sync(cfg)
        if reporter is not None:
            reporter.remote_config = remote

    # 流程状态先对账，再开始扫描；未知发送结果永不自动重放。
    try:
        _flow_reconcile(cfg)
    except Exception as exc:  # noqa: BLE001
        log(f"[流程状态] 启动对账失败：{exc}", level="warning")

    if not args.watch:
        write_client_state("ready", detail="数据库初始化完成，可处理消息", wecom_state=wecom_state)
        if reporter is not None:
            reporter.tick(wecom_state, pending_count(), force=True)
        ready = reception_ready(wecom_state)
        scan_added_contacts(store, cfg)
        scan(store, cfg)
        if ready:
            result = drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
            if reception_ready(wecom_state):
                _flow_tick(store, cfg, wecom_state)
        else:
            result = {"waiting_reply_mode": True}
        # 指令泵不受接待闸门限制（2026-11-23）：登录态下它只领
        # kind=refresh_login_qr，这正是「网页点刷新」在没登录时唯一的出口。
        # 放在闸门里会导致二维码过期后永远领不到指令（21:04 实测指令挂了 5 分钟没人领）。
        pump_safely(store, cfg, reporter, wecom_state)
        _flow_report(cfg)
        if reporter is not None:
            reporter.wait(25)  # 等心跳/上报发完再退出，最多 25 秒
        log(f"本轮完成：{result}")
        print_history(10)
        return 0

    write_client_state("ready", detail="数据库初始化完成，可处理消息", wecom_state=wecom_state)
    ready = reception_ready(wecom_state)
    scan_added_contacts(store, cfg)
    scan(store, cfg)
    if ready:
        drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
        if reception_ready(wecom_state):
            _flow_tick(store, cfg, wecom_state)
    pump_safely(store, cfg, reporter, wecom_state)
    _flow_report(cfg)
    log("开始监听（Ctrl+C 退出）")
    while True:
        try:
            # 换账号检测：自动发现目录的机器，企微退登录再扫码后旧目录不再写入，
            # 这里主动退出（退出码 3）交给计划任务重启重新解析。显式配了
            # data_dir 的机器不适用——运营明确指定了盯哪个账号。
            if data_dir is None:
                switched = account_switched(store.data_dir)
                if switched is not None:
                    log(
                        f"[账号] 企微账号目录已变化：{store.data_dir} → {switched}；"
                        "本进程退出，由计划任务重启并重新解析"
                    )
                    write_client_state("stopped", detail="检测到企微账号变化，请核对后重新启动")
                    return ACCOUNT_SWITCH_EXIT_CODE
            # 每轮开头先自检：非 online 时 drain 里一条都不发，只把心跳继续发出去
            state = detect_wecom_state()
            if state != wecom_state:
                log(
                    f"[自检] 企微状态 {wecom_state} → {state}"
                    f"（{WECOM_STATE_TEXT.get(state, '未知')}）"
                )
                if state == "online":
                    _flow_reconcile(cfg)
                wecom_state = state
                if state == "online":
                    write_client_state("ready", detail="数据库初始化完成，可处理消息", wecom_state=state)
                else:
                    waiting_status = "waiting_login" if state == "login_required" else "waiting_wecom"
                    waiting_detail = "等待扫码登录企业微信" if waiting_status == "waiting_login" else "等待打开企业微信"
                    write_client_state(waiting_status, detail=waiting_detail, wecom_state=state)
            # 掉登录时把企微窗口拉到前台并提示扫码（内部有 120s 冷却，非登录态不动作）
            login_watch.alert_login_required(wecom_state, log=log)
            # 登录码过期自动点「刷新」（定位窗口→相对坐标点击→截图验证），
            # 仅未登录登录窗口、线程化不阻塞；用户 2026-11-18 明确确认。
            login_refresh.maybe_refresh_expired_qr(log=log)
            # 掉登录时把扫码窗截图传到网页（内部约 30s 一次；恢复后自动清除旧图）
            # 推码状态降级：主窗原地变登录页时 detect 仍报 online（类名不变），
            # 但发送连续失败（焦点校验不过）= 实际未登录——降级触发推码。
            qr_state = "login_required" if _consecutive_send_failures >= 2 else wecom_state
            qr_pusher.tick(qr_state, remote_client, log=log)
            code_fetcher.tick(wecom_state, remote_client, log=log)
            if runtime_heartbeat is not None and wecom_state != "online":
                runtime_heartbeat.observe(wecom_state, str(store.self_id() or ""),
                                          "wechat_login" if wecom_state == "login_required" else "wechat_unavailable",
                                          reporter)
            if reporter is not None:
                reporter.tick(wecom_state, pending_count())

            time.sleep(cfg["interval"])
            sig = wal_signature(store.data_dir)
            if sig != last_sig:
                refresh_store(store)
                last_sig = sig
            ready = reception_ready(wecom_state)
            n = scan_added_contacts(store, cfg)
            n += scan(store, cfg)
            if n:
                log(f"新登记 {n} 条")
            if ready:
                drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
                if reception_ready(wecom_state):
                    _flow_tick(store, cfg, wecom_state)
            # 同上：指令泵每轮都跑，登录态下只领刷新二维码指令。
            pump_safely(store, cfg, reporter, wecom_state)
            _flow_report(cfg)
        except KeyboardInterrupt:
            log("已停止")
            write_client_state("stopped", detail="用户停止自动回复", wecom_state=wecom_state)
            return 0
        except Exception as exc:  # noqa: BLE001
            log(f"本轮失败：{type(exc).__name__}: {exc}")
            traceback.print_exc(limit=2)
            time.sleep(cfg["interval"])


if __name__ == "__main__":
    sys.exit(main())

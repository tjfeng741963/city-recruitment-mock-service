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
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from ctypes import wintypes as wt
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# 计划任务用 pythonw.exe 拉起本进程，进程本身没有控制台。此时 subprocess 启动
# tasklist / python.exe 这类控制台程序，Windows 会为每个子进程新建一个控制台窗口
# ——屏幕上就是「隔一会儿跳一下的黑窗口」（每轮自检闪一次）。CREATE_NO_WINDOW
# 让子进程继承「无控制台」，不再弹窗；非 Windows 平台取 0，参数无效但无害。
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

LOG_DIR = ROOT / "logs"
LOG_PATH = LOG_DIR / "run.log"

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
import media_fetch  # noqa: E402
import reply_store as rlog  # noqa: E402
import client as agent_client  # noqa: E402
import register as agent_register  # noqa: E402
import remote_config as remote_cfg  # noqa: E402

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
from wecom_io_core.store import Store  # noqa: E402

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

_last_reply_at = 0.0
# 连续发送失败计数（自动回复 drain 用）。失败也消耗冷却，且连续失败把间隔
# 拉长到最多 4 倍：2026-11-16 实测失败"零成本"立即重试下一个会话，3 秒内
# 对企微连做 3 次键鼠发送，正是触发风控掉登录的操作模式。
_consecutive_send_failures = 0

# ── 人工指令（4222 控制台主动发消息）────────────────────────────────────────
# 主循环里与自动回复串行执行（同一个线程），共享 _last_reply_at 冷却，
# 保证任意时刻只有一个键鼠发送者。轮询按时间戳判断，不额外起线程。
CLAIM_INTERVAL = 10.0
_last_claim_at = 0.0
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
REPORT_MAX_MESSAGES = 50                     # 单次上报最多条数
REPORT_FIRST_WINDOW = 24 * 3600              # 首次没有游标时只补最近 24 小时

# 加好友固定介绍是独立阶段：首段用完整流程定位会话，后续段留在同一已打开
# 的会话里发送，避免每段重新搜索。客户中途发来的问题保留在 pending，整组
# 介绍确认完成后才进入知识库阶段。
WELCOME_PART_DELAY = 1.1
WELCOME_SCAN_INTERVAL = 3.0


def _enforce_flow_welcome_interval(cfg: dict) -> bool:
    """Keep new-contact flow polling responsive after every config refresh.

    The device bridge defaults to a 20-second polling interval for ordinary
    auto-replies. A flow-mode client must use the shorter interval because a
    newly accepted contact is represented by a local notice record. Remote
    config is refreshed on every heartbeat, so applying this only at startup
    is insufficient: the next refresh would restore the general 20-second
    value. This guard changes scheduling only; it does not add desktop input
    events or alter the frozen sender actions.
    """
    brain = cfg.get("brain") or {}
    if str(brain.get("mode") or "") != "flow":
        return False
    try:
        interval = float(cfg.get("interval"))
    except (TypeError, ValueError):
        return False
    if interval <= WELCOME_SCAN_INTERVAL:
        return False
    cfg["interval"] = WELCOME_SCAN_INTERVAL
    log(f"[首句] flow 触发轮询已收紧为 {WELCOME_SCAN_INTERVAL:g}s")
    return True

# 最近一次发送错误，随心跳上报（契约里截断 200 字）
_last_error = ""
# 上一次"因掉线暂停发送"的日志时间，避免每轮刷屏
_last_block_log = 0.0

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


def log(msg: str) -> None:
    text = f"[{time.strftime('%H:%M:%S')}] {msg}"
    # 直接落文件：客户端现在由 pythonw 无窗口启动（不再有 run.cmd 的 >> 重定向），
    # 只靠 stdout 的话日志会整个消失，出问题时没有任何现场可查。
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
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
    for name in ("message.db", "message.db-wal", "session.db", "session.db-wal"):
        p = data_dir / name
        try:
            st = p.stat()
            sig.append((name, st.st_mtime_ns, st.st_size))
        except OSError:
            sig.append((name, 0, 0))
    return tuple(sig)


def is_system_conv(conv_id: str, name: str = "") -> bool:
    if any(conv_id.startswith(p) for p in SYSTEM_PREFIXES):
        return True
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

        self._state = self._load()
        # device_code 来源优先级：显式传入 > state 里上次成功的值 > client 上已配置的值。
        # 显式传入的那一层由 main() 从 --device-code / 环境变量 / config.json 收上来。
        self.device_code = (
            device_code
            or self._state.get("device_code")
            or getattr(api, "device_code", "")
            or ""
        ).strip()
        self.api.device_code = self.device_code
        self._cursor: dict[str, int] = {
            str(k): int(v) for k, v in (self._state.get("cursor") or {}).items()
        }
        self._bridge_pending: dict[str, dict] = dict(self._state.get("bridge_pending") or {})
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
        batch = self._collect()
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
        try:
            self._send_bridge(heartbeat.get("wecom_state") or "unknown")
        except Exception as exc:  # noqa: BLE001
            log(f"[桥接] 异常（忽略）：{agent_client.describe_error(exc)}")
        # 远端配置：每个心跳周期比对一次 version，变了重拉并热更运行参数
        try:
            if self.remote_config is not None:
                self.remote_config.sync(self.cfg)
                # Remote refreshes re-apply the general device interval. Keep
                # flow-mode first-contact detection at its responsive cap.
                _enforce_flow_welcome_interval(self.cfg)
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
            if not self._queue_bridge_messages(batch):
                return
        except Exception as exc:  # noqa: BLE001
            log(f"[桥接] pending persistence failed: {agent_client.describe_error(exc)}")
            return
        try:
            self._send_ingest(batch)
        except Exception as exc:  # noqa: BLE001
            log(f"[上报] 异常（忽略）：{agent_client.describe_error(exc)}")
        try:
            self._send_bridge_messages()
        except Exception as exc:  # noqa: BLE001
            log(f"[桥接] messages 异常（忽略）：{agent_client.describe_error(exc)}")

    def _send_heartbeat(self, heartbeat: dict) -> None:
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
            bridge.heartbeat(state, account_id=account_id)
            log(f"[桥接] {self.device_code} → {state} ok=True")
        except Exception as exc:  # noqa: BLE001
            log(f"[桥接] 失败（忽略，不影响主心跳）：{agent_client.describe_error(exc)}")

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
            key = json.dumps([*destination, event_id], ensure_ascii=False)
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
                        "direction": direction,
                        "event": {"event_id": event_id, "contact_id": cid, "content": text,
                                  "nickname": name, "sent_at": m.get("sent_at") or ""},
                    }
        return self._save() if self._bridge_pending else True

    def _send_bridge_messages(self) -> None:
        """Retry pending records; the bridge deduplicates stable event IDs."""
        bridge = self.bridge
        if bridge is None or not bridge.enabled:
            return
        destination = self._bridge_destination()
        with self._lock:
            pending = [
                (key, item.get("direction", "inbound"), item["event"]) for key, item in self._bridge_pending.items()
                if item["destination"] == destination
            ][:REPORT_MAX_MESSAGES]
        sent = 0
        for key, direction, event in pending:
            try:
                bridge._request("POST", f"/api/v1/bridge/devices/{quote(bridge.device_code, safe='')}/{direction}", event)
                with self._lock:
                    self._bridge_pending.pop(key, None)
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
                # 单条失败不堵队：继续发后面的 pending
                continue
        if sent:
            log(f"[桥接] messages 上报 {sent} 条")

    def _send_ingest(self, batch: dict) -> None:
        messages = batch.get("messages") or []
        if not messages:
            log("[上报] 无新增消息")
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


def scan(store: Store, cfg: dict) -> int:
    """把新的对方消息登记进 reply_log。返回新增条数。"""
    added = 0
    for m in store.recent(limit=60):
        if m.get("is_self"):
            continue
        cid = m.get("conv_id") or ""
        if not cid or not match_target(m, cfg["target"]):
            continue
        if rlog.record_incoming(m):
            added += 1
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
            rlog.mark_skipped(str(m["id"]), "历史消息（初始化跳过）")
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


def build_brain(cfg: dict, log_fn=print):
    """按 cfg["brain"] 构造回复来源；mode 不是 kb/flow 或没配 base_url 时返回 None。

    抽成函数是为了支持网页远程切换：心跳周期检测到 brain_mode 变化后，
    重新调用本函数替换全局 _brain，不必重启客户端。
    """
    bcfg = cfg.get("brain") or {}
    if bcfg.get("mode") in ("kb", "flow") and bcfg.get("base_url"):
        import brain as brain_mod

        instance = brain_mod.Brain(
            bcfg["base_url"],
            bcfg.get("username", ""),
            bcfg.get("password", ""),
            timeout=float(bcfg.get("timeout") or 20),
            history_limit=int(bcfg.get("history_limit") or 6),
            mode=str(bcfg.get("mode")),
            # 设备身份随请求带给服务端：少了它，服务端只能按 FLOW_PROFILE_DEVICE
            # 取设备口径，多设备部署会静默串用别台设备的城市/板块/话术。
            device_code=str(cfg.get("device_code") or ""),
        )
        label = "知识库" if bcfg.get("mode") == "kb" else "流程编排"
        log_fn(
            f"回复来源：{label} {bcfg['base_url']}"
            f"（device_code={cfg.get('device_code') or '未配置'}，失败暂停，待人工处理）"
        )
        return instance
    log_fn(f"回复来源：固定文本（brain.mode={bcfg.get('mode')!r}）")
    return None


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
    2. `reply_log` 里已有 status='sent' 记录 → 不是首次。这一条是为了兼容
       "升级前就在聊"的老会话：它们从没进过 greeted 集合，但明显已经打过招呼，
       不能当新好友再发一遍首句；命中时顺手补登记，后面不再反复查库。
    """
    delivery = rlog.welcome(cid)
    if delivery and delivery['state'] in ('sent', 'cancelled'):
        return False
    if cid in seen:
        return False
    try:
        if rlog.sent_count(cid) > 0:
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


def build_history(store: Store, conv_id: str, limit: int = 6) -> list[str]:
    """取该会话最近几条「对方说的」纯文本，作为知识库的上下文。"""
    try:
        rows = store.messages(conv_id, limit=limit * 3)
    except Exception:  # noqa: BLE001
        return []
    me = store.self_id()
    out: list[str] = []
    for m in rows:
        if str(m.get("sender_id")) == me:
            continue
        text = (m.get("text") or "").strip()
        if text:
            out.append(text[:200])
    return out[-limit:]


def build_dialogue(store: Store, conv_id: str, limit: int = 12) -> list[dict]:
    """取最近几轮**双方**对话，给谈单状态抽取用。

    和 build_history 的区别：那个只要客户说的话（喂给知识库做检索），
    这个要成对的问与答——判断"有没有约上"，必须看我们答了什么。
    """
    try:
        rows = store.messages(conv_id, limit=limit * 2)
    except Exception:  # noqa: BLE001
        return []
    me = store.self_id()
    out: list[dict] = []
    for m in rows:
        text = (m.get("text") or "").strip()
        if not text:
            continue
        role = "agent" if str(m.get("sender_id")) == me else "customer"
        ts = m.get("time") or 0
        item: dict = {"role": role, "text": text[:500]}
        if ts:
            item["at"] = time.strftime("%m-%d %H:%M", time.localtime(ts))
        out.append(item)
    return out[-limit:]


def _observe_lead(store: Store, conv_id: str, name: str, message_id: str, log) -> None:
    """发完消息后让后端判定谈单状态。

    三条硬约束：
    1. 群聊不判（`R:` 开头），只做单聊；
    2. 任何异常都吞掉，绝不影响发送结果；
    3. 不做任何键鼠动作，只发一个 HTTP 请求。
    """
    if _brain is None or conv_id.startswith("R:"):
        return
    try:
        dialogue = build_dialogue(store, conv_id)
        if not dialogue:
            return
        res = _brain.observe_lead(
            conv_id,
            store.self_id(),
            dialogue,
            nickname=name or "",
            last_message_id=str(message_id or ""),
        )
        if not res.get("ok"):
            log(f"    [线索] 未判定：{res.get('detail')}")
        elif res.get("changed"):
            log(
                f"    [线索] {res.get('from_stage')} → {res.get('stage')}"
                f"（{res.get('reason')}）"
            )
    except Exception as exc:  # noqa: BLE001
        log(f"    [线索] 异常（忽略）：{type(exc).__name__}: {exc}")


def _windows_desktop_status() -> tuple[bool, str]:
    """Read session/input-desktop state only; never switch or unlock a desktop."""
    try:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        wts = ctypes.WinDLL('wtsapi32', use_last_error=True)
        user = ctypes.WinDLL('user32', use_last_error=True)
        kernel.GetCurrentProcessId.restype = wt.DWORD
        kernel.ProcessIdToSessionId.argtypes = [wt.DWORD, ctypes.POINTER(wt.DWORD)]
        kernel.ProcessIdToSessionId.restype = wt.BOOL
        session = wt.DWORD()
        if not kernel.ProcessIdToSessionId(kernel.GetCurrentProcessId(), ctypes.byref(session)):
            return False, '无法确认客户端桌面会话'
        wts.WTSQuerySessionInformationW.argtypes = [wt.HANDLE, wt.DWORD, ctypes.c_int,
                                                  ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.DWORD)]
        wts.WTSQuerySessionInformationW.restype = wt.BOOL
        wts.WTSFreeMemory.argtypes = [ctypes.c_void_p]
        buffer, size = ctypes.c_void_p(), wt.DWORD()
        if not wts.WTSQuerySessionInformationW(None, session.value, 8, ctypes.byref(buffer), ctypes.byref(size)):
            return False, '无法读取 RDP/桌面连接状态'
        try:
            if not buffer.value or size.value < ctypes.sizeof(ctypes.c_int):
                return False, '桌面连接状态无效'
            if ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int)).contents.value != 0:
                return False, '客户端桌面会话未连接（RDP 已断开），待恢复后继续'
        finally:
            wts.WTSFreeMemory(buffer)
        user.OpenInputDesktop.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        user.OpenInputDesktop.restype = wt.HANDLE
        user.CloseDesktop.argtypes = [wt.HANDLE]
        user.GetUserObjectInformationW.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                   wt.DWORD, ctypes.POINTER(wt.DWORD)]
        user.GetUserObjectInformationW.restype = wt.BOOL
        desktop = user.OpenInputDesktop(0, False, 1)  # DESKTOP_READOBJECTS, no switch rights.
        if not desktop:
            return False, '输入桌面不可读，可能已锁屏；待恢复后继续'
        try:
            name, needed = ctypes.create_unicode_buffer(256), wt.DWORD()
            if not user.GetUserObjectInformationW(desktop, 2, name, ctypes.sizeof(name), ctypes.byref(needed)):
                return False, '无法确认输入桌面'
            if name.value.casefold() != 'default':
                return False, '当前是锁屏或安全桌面，待恢复后继续'
        finally:
            user.CloseDesktop(desktop)
        return True, ''
    except Exception as exc:  # noqa: BLE001
        return False, f'桌面自检失败：{type(exc).__name__}'


def desktop_send_ready() -> tuple[bool, str]:
    return _windows_desktop_status() if sys.platform == 'win32' else (True, '')


def _welcome_trigger_is_notice(item: dict) -> bool:
    text = (item.get('in_text') or '').strip()
    return not text or text == '我已经添加了你，现在我们可以开始聊天了。'


def _welcome_definitely_unsent(result: dict, entered_send: bool) -> bool:
    """Only known failures before Enter can resume without operator reconciliation."""
    detail = str(result.get('detail') or '')
    return (not result.get('ok') and not result.get('conversation_id') and not entered_send and
            detail.startswith(('会话名或内容为空', '没找到企业微信窗口', '企业微信已退出，停止发送',
                               '抢不到前台，已中止', '企微窗口持续隐藏', '输入框校验：')))


def drain(store: Store, cfg: dict, *, dry: bool = False, wecom_state: str = "online") -> dict:
    """按消息时间正序处理 pending + failed。

    同一会话有多条未回消息时只回最新一条（其余标 skipped）——
    对方连发三条属于同一次接触，回三条会把风控和客户体验一起搞坏。

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
        rlog.recover_welcomes()
        desktop_ready, reason = desktop_send_ready()
        if not desktop_ready:
            stats['blocked'] = len({item['message_id'] for item in
                                    rlog.pending(include_failed=True) + rlog.active_welcomes()})
            _last_error = reason[:200]
            if time.time() - _last_block_log > 60:
                _last_block_log = time.time()
                log(f'[桌面] {reason}；本轮不请求首句、不发送，待发内容保留')
            return stats

    items = rlog.pending(include_failed=True)
    welcomes = {it['conv_id']: it for it in rlog.active_welcomes()}
    # 每个会话选一条作为回复目标：优先「有文本」的最新一条。
    # 企业微信在加好友、撤回、系统提示时会插入 type=1011 之类的空文本记录，
    # 它们时间更晚；若只按时间取最新，真正要回的文本就被挤掉，知识库拿到
    # 空字符串直接拒答（实测：Garbo_C 加好友，三条记录里只有第一条有文字）。
    newest: dict[str, dict] = {}
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
    for cid, item in welcomes.items():
        newest[cid] = item
    for it in items:
        if it['conv_id'] in welcomes:
            continue  # A pending welcome owns its source; later questions stay queued.
        if newest[it["conv_id"]]["message_id"] != it["message_id"]:
            if not dry:
                rlog.mark_skipped(it["message_id"], "同会话合并到最新一条")
            stats["merged"] += 1
    if stats["merged"]:
        log(f"同会话合并：{stats['merged']} 条旧消息并入最新一条，不单独回")

    for it in sorted(newest.values(), key=lambda x: int(x["msg_time"] or 0)):
        mid = it["message_id"]
        cid = it["conv_id"]
        name = it["conv_name"] or ""
        preview = (it["in_text"] or "").strip()[:20].replace("\n", " ") or f"[type={it['in_type']}]"
        welcome_delivery = rlog.welcome(cid)
        if welcome_delivery and welcome_delivery['state'] not in ('sent', 'cancelled'):
            if welcome_delivery['state'] != 'ready':
                stats['blocked'] += 1
                _last_error = welcome_delivery['error'][:200]
                continue
        else:
            welcome_delivery = None

        if is_system_conv(cid, name):
            if not dry:
                rlog.mark_skipped(mid, "系统/官方会话")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：系统/官方会话")
            continue

        # 人工接管：网页点「接管」后，服务器把它写进 agent_conversations.takeover，
        # 随 /config 下发到这里。命中就整轮不碰这个会话——否则人工和 AI 会同时发言。
        if cid in remote_cfg.takeover_sessions():
            if not dry:
                rlog.mark_skipped(mid, "人工接管中")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：人工接管中")
            continue

        # 已流失：客户说过「我不去了」（8090 标记 stage=gave_up →
        # recruit_status=disqualified）。按业务要求「只标记、不发消息」——
        # 整轮不碰这个会话，一句都不发，等运营在网页上手动恢复。
        if cid in remote_cfg.abandoned_sessions():
            if not dry:
                rlog.mark_skipped(mid, "客户已流失")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：客户已流失")
            continue

        if not name or name == cid:
            if not dry:
                rlog.mark_skipped(mid, "会话没有可搜索的名字")
            stats["skipped"] += 1
            log(f"跳过 {cid}：会话没有可搜索的名字")
            continue

        # A recovered welcome must not be sent from a different logged-in account,
        # or after switching this device out of flow mode/target scope.
        if welcome_delivery or (not dry and _brain is not None and str(getattr(_brain, 'mode', '')) == 'flow'
                                and _is_first_contact(cid, greeted)):
            try:
                own_id = store.self_id()
            except Exception:  # noqa: BLE001
                own_id = ''
            if (not isinstance(own_id, str) or not own_id or not cid.startswith('S:')
                    or own_id not in cid[2:].split('_') or not match_target(
                        {'conv_id': cid, 'conv_name': name}, cfg.get('target', 'all'))
                    or _brain is None or str(getattr(_brain, 'mode', '')) != 'flow'):
                stats['blocked'] += 1
                _last_error = '首句账号、监听范围或流程模式不匹配，原文保留待核对'
                continue

        if _brain is not None or (cfg.get("brain") or {}).get("mode") in ("kb", "flow"):
            hint = (it["in_text"] or "").strip()
            res = {"ok": False, "detail": "知识库未初始化"}
            try:
                # ── 加好友首句 ────────────────────────────────────────
                # 只在「该会话第一次出现消息」时走 /flow/greet。为什么不靠
                # hint 判断首次：加好友会插入 type=1011 的空文本记录，首句恰恰
                # 常常没有可回复的文本；所以"是否首次"必须用会话维度判断。
                # DRY-RUN 不发请求：greet 会在服务端推进 stage，干跑不该改状态。
                greeted_now = False
                if welcome_delivery:
                    res = {'ok': True, 'reply': welcome_delivery['reply_text'],
                           'parts': welcome_delivery['parts'], 'scene': '首句', 'detail': '恢复已保存的首句及分段进度'}
                    greeted_now = True
                elif (
                    not dry
                    and _brain is not None
                    and str(getattr(_brain, "mode", "")) == "flow"
                    and _is_first_contact(cid, greeted)
                ):
                    rlog.begin_welcome(cid, mid, _welcome_trigger_is_notice(it))
                    welcome_delivery = rlog.welcome(cid)
                    gres = _brain.greet(cid)
                    if not gres.get('ok'):
                        raise ValueError(gres.get('detail') or '首句生成失败，服务端结果待核对')
                    welcome_text = str(gres.get('reply') or '').strip()
                    welcome_parts = [str(p).strip() for p in (gres.get('parts') or []) if str(p).strip()]
                    if len(welcome_parts) < 2:
                        welcome_parts = [welcome_text]
                    rlog.save_welcome(cid, welcome_text, welcome_parts)
                    welcome_delivery = rlog.welcome(cid)
                    res = gres
                    greeted_now = True
                if greeted_now:
                    pass
                elif not hint:
                    res = {"ok": False, "detail": f"消息没有文本（type={it['in_type']}）"}
                elif _brain is not None:
                    # dialogue 一并带上：服务端投影缺人工/补发轮次，
                    # 客户端本地库才是完整聊天记录（2026-11-16）。
                    res = _brain.reply(
                        hint,
                        build_history(store, cid),
                        session_key=cid,
                        dialogue=build_dialogue(store, cid),
                    )
                # 流程走完（已约到面试）后不再自动回复，这条消息记为跳过
                if res.get("skip"):
                    if not dry:
                        rlog.mark_skipped(mid, res.get("detail") or "流程已结束")
                    stats["skipped"] += 1
                    log(f"    [flow] {res.get('detail') or '流程已结束，不再回复'}")
                    continue
                text = res.get("reply")
                if not res.get("ok") or not isinstance(text, str) or not text.strip():
                    raise ValueError(res.get("detail") or "知识库返回空回复")
                text, scene = text.strip(), res.get("scene") or "知识库"
                # 流程可返回多段（先岗位信息再邀约），逐条分开发
                raw_parts = res.get("parts") or []
                parts = [str(p).strip() for p in raw_parts if str(p).strip()]
                if len(parts) < 2:
                    parts = [text]
                log(f"    [brain] {res.get('detail', '')}")
            except Exception as exc:  # noqa: BLE001
                reason = f"知识库暂停，待人工处理：{type(exc).__name__}: {exc}"
                if not dry:
                    if welcome_delivery:
                        rlog.fail_welcome(cid, reason, unknown=True)
                    else:
                        rlog.mark_held(mid, reason)
                    _last_error = reason[:200]
                stats["blocked"] += 1
                log(f"    [brain] {reason}")
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

        log(f"[{scene}] {name} ← {preview!r} → {text!r}")
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
        _prefetch_media(parts, cfg)

        # 按键之前先确认剪贴板可写，避免 Ctrl+F 打开搜索框后才卡住
        if not compat.wait_clipboard_writable(timeout=15):
            if welcome_delivery:
                rlog.fail_welcome(cid, '剪贴板被占用超过 15 秒', unknown=False)
            rlog.mark_failed(mid, "剪贴板被占用超过 15 秒", scene, text)
            _last_error = "剪贴板被占用超过 15 秒"
            stats["failed"] += 1
            log("    跳过：剪贴板被占用（向日葵同步？）")
            continue

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
            result = {"ok": False, "detail": "未发送"}
            start_part = welcome_delivery['next_part'] if welcome_delivery else 0
            welcome_fast_ready = False
            for idx in range(start_part, len(parts)):
                raw_part = parts[idx]
                try:
                    body, medias = core_send.split_media_marks(raw_part)
                except Exception:  # noqa: BLE001
                    body, medias = raw_part, []
                entered_send = False
                before = None
                if welcome_delivery:
                    if not body:
                        rlog.fail_welcome(cid, '纯媒体首句无法确认目标会话；本轮不发送，需人工核对', unknown=True)
                        result = {'ok': False, 'detail': '首句媒体目标待核对'}
                        break
                    before = _outbound_snapshot(store, cid)
                    if before is None:
                        rlog.fail_welcome(cid, '首句发送前读不到本账号的发件记录，原文保留待核对', unknown=True)
                        result = {'ok': False, 'detail': '首句发件记录不可读'}
                        break
                    rlog.begin_welcome_part(cid, idx)

                def send_log(message):
                    nonlocal entered_send
                    if '步骤4 已回车发送' in message:
                        entered_send = True
                    log(f'    {message}')

                if body:
                    fast_result = (
                        _send_welcome_part_fast(store, body, send_log)
                        if welcome_delivery and welcome_fast_ready else None
                    )
                    result = fast_result if fast_result is not None else core_send.send(
                        store, name, body,
                        expect_id=cid if str(cid).startswith(("S:", "R:")) else "",
                        verify_db=True,
                        log=send_log,
                    )
                    if not result["ok"]:
                        if welcome_delivery:
                            rlog.fail_welcome(cid, str(result.get('detail') or '首句发送结果未知'),
                                              unknown=not _welcome_definitely_unsent(result, entered_send))
                        break
                    if welcome_delivery:
                        after = _outbound_snapshot(store, cid)
                        normalized = body.replace('\r\n', '\n').replace('\r', '\n').strip()
                        candidates = [key for key, value in (after or {}).items()
                                      if key not in before and value == normalized]
                        if (after is None or len(candidates) != 1 or result.get('conversation_id') not in (None, '', cid)):
                            rlog.fail_welcome(cid, '首句已尝试发送，但目标会话新消息 ID 未唯一确认；勿直接重发', unknown=True)
                            result = {'ok': False, 'detail': '首句发送结果待人工核对'}
                            break
                        _last_reply_at = time.time()
                        welcome_fast_ready = True
                else:
                    result = {"ok": True, "detail": "纯媒体段，无文本"}
                for kind, mname in medias:
                    try:
                        ok_m, detail_m = core_send.paste_media(
                            mname, log=lambda s: log(f"    {s}")
                        )
                        log(f"    [媒体] {kind}:{mname} "
                            f"{'成功' if ok_m else '失败'}：{detail_m}")
                        if welcome_delivery and not ok_m:
                            raise RuntimeError('首句媒体发送未完成；保留已发文字，核对后处理')
                    except Exception as exc:  # noqa: BLE001
                        log(f"    [媒体] {kind}:{mname} 异常（忽略）：{type(exc).__name__}: {exc}")
                        if welcome_delivery:
                            raise
                if welcome_delivery:
                    rlog.confirm_welcome_part(cid, idx)
                if idx < len(parts) - 1:
                    time.sleep(WELCOME_PART_DELAY)
            detail_text = str(result.get("detail") or "")
            if not welcome_delivery and result["ok"] and "回读失败" in detail_text:
                # 回车已按但回读解密库确认不了落点：结果不明。不能记 sent
                #（可能静默丢失），也不能记 failed（下轮自动补发可能重复发送）。
                # 记 unknown 不参与自动补发，--retry-held 由人工核对后重新入队。
                rlog.mark_unknown(mid, detail_text, scene, text)
                _last_error = detail_text[:200]
                _consecutive_send_failures += 1
                stats["unknown"] += 1
                log("    回读未确认：按 unknown 记账，不自动重发，待人工核对（--retry-held 可重新入队）")
            elif result["ok"]:
                if welcome_delivery:
                    greeted.add(cid)
                    _save_greeted(greeted)
                else:
                    rlog.mark_sent(mid, scene, text)
                _last_reply_at = time.time()
                _consecutive_send_failures = 0
                _last_error = ""
                stats["sent"] += 1
                log(f"    已发送：{result['detail']}")

                # 发完再判定谈单状态：绝不阻塞发送，也绝不影响发送结果
                if _brain is not None:
                    _observe_lead(store, cid, name, mid, log)
            else:
                if not welcome_delivery:
                    rlog.mark_failed(mid, result["detail"], scene, text)
                _last_error = str(result["detail"])[:200]
                _consecutive_send_failures += 1
                stats["failed"] += 1
                log(f"    发送失败：{result['detail']}")
        except Exception as exc:  # noqa: BLE001
            if welcome_delivery:
                rlog.fail_welcome(cid, f'{type(exc).__name__}: {exc}', unknown=True)
            else:
                rlog.mark_failed(mid, f"{type(exc).__name__}: {exc}", scene, text)
            _last_error = f"{type(exc).__name__}: {exc}"[:200]
            _consecutive_send_failures += 1
            stats["failed"] += 1
            log(f"    发送异常：{type(exc).__name__}: {exc}")
            traceback.print_exc(limit=2)

    return stats


def _session_names(store: Store) -> set[str]:
    """企微本地会话表里的全部会话名，用于人工发送前校验目标真实存在。"""
    try:
        sessions = store.sessions(limit=500)
    except Exception:  # noqa: BLE001
        return set()
    return {(item.get("name") or "").strip() for item in sessions if (item.get("name") or "").strip()}


def _outbound_snapshot(store: Store, contact_id: str) -> dict[str, str] | None:
    """Read the already decrypted database; never refresh or perform input."""
    try:
        me = store.self_id()
        if not isinstance(me, str) or not me:
            return None
        return {
            str(m["id"]): (m.get("text") or "").replace("\r\n", "\n").replace("\r", "\n").strip()
            for m in store.messages(contact_id, limit=100)
            if str(m.get("sender_id")) == me and m.get("id")
        }
    except Exception:  # noqa: BLE001
        return None


def _send_welcome_part_fast(store: Store, text: str, log_fn) -> dict | None:
    """Send a later fixed-introduction part in the already open conversation.

    The first part uses the frozen full sender, which searches and verifies the
    destination.  Once that succeeds, the input focus is already in that same
    conversation; repeating Ctrl+F for every part was the source of the 25s
    fallback delay observed in production.  This helper reuses only the
    existing sender actions (paste, input verification, Enter) and never
    changes the frozen IO modules or adds a new mouse/keyboard action.

    ``None`` means the test double or an older client has no compatible fast
    path; the caller must use the established full sender in that case.
    """
    win_api = getattr(core_send, "win", None)
    if getattr(win_api, "__name__", "") != "wecom_io_core.win":
        return None
    try:
        if not win_api.wxwork_alive():
            return {"ok": False, "conversation_id": "", "detail": "企业微信已退出，固定介绍暂停"}
        target = win_api.find_window()
        if not target:
            return {"ok": False, "conversation_id": "", "detail": "没找到企业微信窗口，固定介绍暂停"}
        hwnd = target["hwnd"]
        if not win_api.ensure_foreground(hwnd, tries=4):
            return {"ok": False, "conversation_id": "", "detail": "固定介绍续发抢不到前台"}
        visible_error = core_send._wait_visible(hwnd, "固定介绍续发前")
        if visible_error:
            return {"ok": False, "conversation_id": "", "detail": visible_error}

        # Enter after the previous part leaves the same chat input active. Clear
        # and verify exactly as the frozen sender does, without searching again.
        win_api.hotkey("ctrl", "a")
        win_api.tap("delete")
        win_api.set_clipboard(text)
        win_api.hotkey("ctrl", "v")
        time.sleep(0.3)
        passed, hint = core_send.verify_input_box(text, retries=5)
        if not passed:
            return {"ok": False, "conversation_id": "", "detail": f"固定介绍续发输入框校验：{hint}"}
        visible_error = core_send._wait_visible(hwnd, "固定介绍续发发送前")
        if visible_error:
            return {"ok": False, "conversation_id": "", "detail": visible_error}
        win_api.tap("enter")
        time.sleep(0.4)
        log_fn(f"步骤4 已回车发送（同一会话快速续发，{hint}）")
        try:
            store.refresh()
        except Exception:
            pass
        return {"ok": True, "conversation_id": "", "detail": "已发送（同一会话快速续发）"}
    except Exception as exc:  # noqa: BLE001
        try:
            win_api.release_modifiers()
        except Exception:
            pass
        return {"ok": False, "conversation_id": "", "detail": f"固定介绍续发异常：{type(exc).__name__}: {exc}"}


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
                response = bridge.receipt(item["command_id"], item["lease_token"], item["status"], item["message_id"])
                if response.get("ok") is not True:
                    raise ValueError("Receipt response did not acknowledge success")
                rlog.mark_manual_receipt(server, device, item["command_id"], item["lease_token"], "acked")
                log(f"[回执] #{item['command_id'][:8]} {item['status']} 已确认")
            except HTTPError as exc:
                if exc.code in (409, 422):
                    rlog.mark_manual_receipt(server, device, item["command_id"], item["lease_token"], "rejected", f"HTTP {exc.code}; manual review required")
                    _last_error = f"回执冲突待核对：#{item['command_id'][:8]} HTTP {exc.code}"
                    log(f"[回执] {_last_error}")
                    continue
                raise
        return not bool(rlog.pending_manual_receipts(server, device, limit=1))
    except Exception as exc:  # noqa: BLE001
        _last_error = f"回执未确认：{agent_client.describe_error(exc)}"[:200]
        log(f"[回执] {_last_error}；保留记录，稍后只补传回执")
        return False


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
    - 只在企微 online 时领指令——离线领了只能失败，还会把指令锁 60 秒；
    - 未发送的失败回执 failed，执行结果不明确回执 unknown，不自动重发；
    - 自动回复的判定逻辑（知识库、场景、合并）完全不改。

    安全护栏（11-05 事故后补）：键鼠发送靠「搜索会话名 → 回车 → 粘贴」，
    搜索不到目标时焦点会落回当前会话，消息会发给上一个聊天对象。
    所以发送前必须确认目标名在企微会话列表里且不是系统会话；
    发送后再回读解密库，落点不是该 contact_id 就回执 unknown，待人工核对。
    """
    global _last_reply_at, _last_error, _last_claim_at
    stats = {"claimed": 0, "sent": 0, "failed": 0}

    if dry or cfg.get("dry_run") or bridge is None or not getattr(bridge, "enabled", False):
        return stats
    if not flush_manual_receipts(bridge):
        return stats
    if wecom_state != "online":
        return stats
    now = time.time()
    if now - _last_claim_at < CLAIM_INTERVAL:
        return stats
    _last_claim_at = now

    try:
        command = bridge.claim()
    except Exception as exc:  # noqa: BLE001
        log(f"[指令] 领取失败（忽略）：{agent_client.describe_error(exc)}")
        return stats
    if not command:
        return stats

    stats["claimed"] = 1
    cmd_id = str(command.get("id") or "")
    lease = str(command.get("lease_token") or "")
    content = (command.get("content") or "").strip()
    name = (command.get("nickname") or "").strip()
    if not cmd_id or not lease:
        return stats
    try:
        if not rlog.begin_manual_command(bridge.base_url, bridge.device_code, cmd_id, lease):
            log(f"[指令] #{cmd_id[:8]} 已有执行记录，本轮不再发送")
            return stats
    except Exception as exc:  # noqa: BLE001
        _last_error = f"人工指令记录写盘失败：{type(exc).__name__}"[:200]
        log(f"[指令] {_last_error}；停止该条发送")
        stats["failed"] += 1
        return stats
    log(f"[指令] 人工发送 #{cmd_id[:8]} → {name or '(无昵称)'}：{content[:30]!r}")

    def receipt(status: str, message_id: str = "") -> None:
        try:
            rlog.finish_manual_command(bridge.base_url, bridge.device_code, cmd_id, lease, status, message_id)
        except Exception as exc:  # noqa: BLE001
            log(f"    回执 {status} 写盘失败，保留 unknown：{type(exc).__name__}")
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
        log(f"    {_last_error}")
        receipt("unknown")
        stats["failed"] += 1
        return True

    # Socket timeouts do not bound a streaming response's total duration.
    if stop_if_lease_invalid():
        return stats

    if not content or not name:
        log("    跳过：指令缺少昵称或内容")
        receipt("failed")
        stats["failed"] += 1
        return stats

    # 盲发护栏：目标必须是企微里真实存在的非系统会话，否则键盘搜索落空时
    # 消息会被上一个打开的真实客户收走（11-05 已发生一次）。
    contact_id = str(command.get("contact_id") or "")
    names = _session_names(store)
    if is_system_conv(contact_id, name):
        log(f"    拒绝发送：{name} 是系统/官方会话，人工发送不允许")
        receipt("failed")
        stats["failed"] += 1
        return stats
    if names and name not in names:
        log(f"    拒绝发送：{name} 不在企微会话列表，避免搜索落空后发错人")
        receipt("failed")
        stats["failed"] += 1
        return stats
    if not names:
        # 读不到会话列表就无法确认落点，宁可失败也不能盲发。
        log("    拒绝发送：读不到企微会话列表，无法确认目标会话")
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
        log("    纯媒体指令（无文本），贴完媒体后需人工核对落点")
        for kind, mname in cmd_medias:
            try:
                ok_m, detail_m = core_send.paste_media(
                    mname, log=lambda s: log(f"    {s}")
                )
                log(f"    [媒体] {kind}:{mname} {'成功' if ok_m else '失败'}：{detail_m}")
            except Exception as exc:  # noqa: BLE001
                log(f"    [媒体] {kind}:{mname} 异常（忽略）：{type(exc).__name__}: {exc}")
        receipt("unknown")
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
        log("    失败：剪贴板被占用（向日葵同步？）")
        receipt("failed")
        stats["failed"] += 1
        return stats

    before = _outbound_snapshot(store, contact_id)
    if stop_if_lease_invalid():
        return stats
    # 与自动回复同一口径：按键前更新冷却，失败也算一次企微操作，
    # 不给"失败后立即重试/下一条"留零成本通道。
    _last_reply_at = time.time()
    try:
        result = core_send.send(
            store, name, content,
            # 人工指令打开回读，并把落点锁死在该客户的 contact_id 上；
            # 自动回复仍用 verify_db=False（core 里 rowid 兼容问题）。
            expect_id=contact_id if contact_id.startswith(("S:", "R:")) else "",
            verify_db=True,
            log=lambda s: log(f"    {s}"),
        )
    except Exception as exc:  # noqa: BLE001
        _last_error = f"{type(exc).__name__}: {exc}"[:200]
        log(f"    发送异常：{type(exc).__name__}: {exc}")
        traceback.print_exc(limit=2)
        receipt("unknown")
        stats["failed"] += 1
        return stats

    if result.get("ok"):
        # 文本已发出：媒体逐个粘贴，任何媒体异常不影响文本已发状态与回执
        for kind, mname in cmd_medias:
            try:
                ok_m, detail_m = core_send.paste_media(
                    mname, log=lambda s: log(f"    {s}")
                )
                log(f"    [媒体] {kind}:{mname} {'成功' if ok_m else '失败'}：{detail_m}")
            except Exception as exc:  # noqa: BLE001
                log(f"    [媒体] {kind}:{mname} 异常（忽略）：{type(exc).__name__}: {exc}")
        _last_reply_at = time.time()
        after = _outbound_snapshot(store, contact_id)
        normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
        candidates = [mid for mid, text in (after or {}).items()
                      if before is not None and mid not in before and text == normalized]
        observed_cid = result.get("conversation_id") or ""
        # Core may return ok after its legacy rowid readback fails; require stable ID evidence.
        if (observed_cid and observed_cid != contact_id) or before is None or after is None or len(candidates) != 1:
            _last_error = "人工发送未找到目标会话中唯一的新消息 ID，请核对实际落点，勿直接重发"
            stats["failed"] += 1
            log(f"    {_last_error}")
            receipt("unknown")
            return stats
        _last_error = ""
        stats["sent"] += 1
        log("    已发送：目标会话中唯一的新消息 ID 已确认")
        receipt("succeeded", f"{contact_id}:{candidates[0]}")
    else:
        _last_error = str(result.get("detail"))[:200]
        stats["failed"] += 1
        log(f"    发送失败：{result.get('detail')}")
        receipt("unknown" if result.get("conversation_id") else "failed")
    return stats


def pump_safely(store: Store, cfg: dict, reporter: "Reporter | None", wecom_state: str) -> None:
    """pump_commands 的安全外壳：任何异常都不许冒泡到主循环。"""
    try:
        pump_commands(
            store,
            cfg,
            bridge=(reporter.bridge if reporter is not None else None),
            wecom_state=wecom_state,
            dry=bool(cfg.get("dry_run")),
        )
    except Exception as exc:  # noqa: BLE001
        log(f"[指令] 本轮异常（忽略）：{type(exc).__name__}: {exc}")


def print_history(limit: int = 20) -> None:
    for item in rlog.welcome_history(limit):
        count = len(json.loads(item['parts_json']))
        print(f"首句 {item['conv_id']} {item['state']} {item['next_part']}/{count} "
              f"{item['conv_name'] or ''} {item['error']}")
    manual = rlog.recent_manual_receipts(limit)
    if manual:
        print("人工回执（执行结果 / 上报状态）：")
        for item in manual:
            print(f"  {item['command_id']} {item['status']} / {item['receipt_state']} {item['error']}")
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
              f"{(r['in_text'] or '')[:20]!r:<24}{r['reply_text'] or '-'}{err}")
    print("\n统计:", rlog.stats())


def _make_bridge(cfg: dict, device_code: str) -> agent_client.BridgeClient | None:
    """按 config.json 建桥接客户端；没配 bridge_server/bridge_token 就返回 None。"""
    bserver = (cfg.get("bridge_server") or "").strip()
    btoken = (cfg.get("bridge_token") or "").strip()
    if not bserver or not btoken:
        log("[桥接] 未配置 bridge_server / bridge_token，跳过桥接上报")
        return None
    bridge = agent_client.BridgeClient(bserver, btoken, device_code)
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
    if not server or not token:
        log("[心跳] 未配置 server / device_token，跳过心跳与上报")
        return None
    code = resolve_device_code(cfg)
    api = agent_client.AgentClient(server, token, device_code=code)
    bridge = _make_bridge(cfg, code)
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
    if bcfg and bcfg.get("mode") not in ("kb", "flow", "fixed"):
        raise ValueError("brain.mode must be kb, flow or fixed")
    if bcfg.get("mode") in ("kb", "flow") and (
        not isinstance(bcfg.get("base_url"), str) or not bcfg["base_url"].strip()
    ):
        raise ValueError("brain.base_url is required for kb/flow mode")
    return cfg


def configured_data_dir(cfg: dict) -> Path | None:
    value = cfg["data_dir"]
    if not value:
        return None
    directory = Path(value)
    if not directory.is_absolute():
        raise ValueError("data_dir must be an absolute path")
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
    ap.add_argument("--list", action="store_true", help="打印回复历史")
    ap.add_argument("--reset", action="store_true", help="把待发/失败的条目全部作废")
    ap.add_argument("--retry-held", action="store_true", help="把普通 held/unknown 记录重新入队；未完成首句需先核对")
    ap.add_argument('--resolve-welcome', help='停客户端、核对实际消息后，处理此会话暂停的首句；本次不发送')
    ap.add_argument('--confirmed-parts', type=int, help='与 --resolve-welcome 配合，人工核实已收到的连续段数')
    ap.add_argument("--flush-receipts", action="store_true", help="仅补传人工回执后退出，不操作企微")
    ap.add_argument("--device-code", default=argparse.SUPPRESS, help="设备编号，覆盖 config.json（心跳路径参数）")
    args = ap.parse_args()
    if bool(args.resolve_welcome) != (args.confirmed_parts is not None):
        ap.error('--resolve-welcome 与 --confirmed-parts 必须同时填写')
    if args.resolve_welcome and (args.list or args.reset or args.retry_held or args.flush_receipts):
        ap.error('首句核对不能与其他维护命令混用')

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
    if args.resolve_welcome:
        if cfg['dry_run']:
            log('DRY-RUN，未修改首句记录')
            return 0
        try:
            rlog.resolve_welcome(args.resolve_welcome, args.confirmed_parts)
        except ValueError as exc:
            log(f'首句核对失败：{exc}')
            return 2
        log('首句核对已保存；本次未初始化企微、未发送，启动客户端后只处理剩余段落')
        return 0
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

    global _brain
    _brain = build_brain(cfg, log)

    if args.retry_held:
        log(f"held/unknown 记录重新入队：{rlog.retry_held()} 条；本次未发送")
        return 0

    if args.list:
        print_history()
        return 0

    try:
        data_dir = configured_data_dir(cfg)
    except ValueError as exc:
        log(f"Configuration error: {exc}")
        return 2
    store = Store(data_dir=data_dir) if data_dir is not None else Store()
    if not store.data_dir:
        print("没找到企业微信数据目录")
        return 1
    log(f"数据目录 {store.data_dir}")
    scope = "全部会话（排除系统会话）" if cfg["target"] == "all" else f"仅 {cfg['target']!r}"
    log(f"监听范围 {scope} / 首次 {cfg['reply_first']!r} · 后续 {cfg['reply_next']!r} / "
        f"冷却 {cfg['cooldown']}s" + (" / DRY-RUN" if cfg["dry_run"] else ""))

    store.refresh()

    if args.reset:
        rlog.cancel_welcomes()
        n = 0
        for it in rlog.pending(include_failed=True, limit=5000):
            rlog.mark_skipped(it["message_id"], "手动 reset")
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

    # 远端配置（Node 4222 下发）：启动拉一次，成功则合并运行参数并缓存
    # config.remote.json；拉不到时 RemoteConfig 内部用缓存兜底，只记一行日志。
    # cfg 是全局共享字典，interval/cooldown 在主循环下一轮即时生效。
    remote_client = reporter.bridge if reporter is not None else _make_bridge(cfg, resolve_device_code(cfg))
    if remote_client is not None:
        remote = remote_cfg.RemoteConfig(remote_client, log_fn=log)
        remote.sync(cfg)
        if reporter is not None:
            reporter.remote_config = remote

    # Apply the cap both with and without a bridge. Without this call a local
    # flow config could still inherit the general 20-second interval.
    _enforce_flow_welcome_interval(cfg)

    # 登录二维码上传器：企微掉登录时把扫码窗截图送到服务端，网页上就能扫。
    # 机器在云端，没人看得到那块屏幕——这是唯一能让用户自己扫码的路径。
    qr_pusher = login_qr.LoginQrPusher()

    if not args.watch:
        wecom_state = detect_wecom_state()
        log(f"[自检] 企微状态 {wecom_state}（{WECOM_STATE_TEXT.get(wecom_state, '未知')}）")
        login_watch.alert_login_required(wecom_state, log=log)
        qr_pusher.tick(wecom_state, remote_client, log=log)
        if reporter is not None:
            reporter.tick(wecom_state, pending_count(), force=True)
        scan(store, cfg)
        result = drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
        pump_safely(store, cfg, reporter, wecom_state)
        if reporter is not None:
            reporter.wait(25)  # 等心跳/上报发完再退出，最多 25 秒
        log(f"本轮完成：{result}")
        print_history(10)
        return 0

    wecom_state = detect_wecom_state()
    log(f"[自检] 企微状态 {wecom_state}（{WECOM_STATE_TEXT.get(wecom_state, '未知')}）")
    login_watch.alert_login_required(wecom_state, log=log)
    qr_pusher.tick(wecom_state, remote_client, log=log)
    if reporter is not None:
        reporter.tick(wecom_state, pending_count(), force=True)
    scan(store, cfg)
    drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
    pump_safely(store, cfg, reporter, wecom_state)
    last_sig = wal_signature(store.data_dir)
    log("开始监听（Ctrl+C 退出）")
    while True:
        try:
            # 每轮开头先自检：非 online 时 drain 里一条都不发，只把心跳继续发出去
            state = detect_wecom_state()
            if state != wecom_state:
                log(
                    f"[自检] 企微状态 {wecom_state} → {state}"
                    f"（{WECOM_STATE_TEXT.get(state, '未知')}）"
                )
                wecom_state = state
            # 掉登录时把企微窗口拉到前台并提示扫码（内部有 120s 冷却，非登录态不动作）
            login_watch.alert_login_required(wecom_state, log=log)
            # 掉登录时把扫码窗截图传到网页（内部约 30s 一次；恢复后自动清除旧图）
            qr_pusher.tick(wecom_state, remote_client, log=log)
            if reporter is not None:
                reporter.tick(wecom_state, pending_count())

            time.sleep(cfg["interval"])
            sig = wal_signature(store.data_dir)
            if sig != last_sig:
                store.refresh()
                last_sig = sig
            n = scan(store, cfg)
            if n:
                log(f"新登记 {n} 条")
            drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
            pump_safely(store, cfg, reporter, wecom_state)
        except KeyboardInterrupt:
            log("已停止")
            return 0
        except Exception as exc:  # noqa: BLE001
            log(f"本轮失败：{type(exc).__name__}: {exc}")
            traceback.print_exc(limit=2)
            time.sleep(cfg["interval"])


if __name__ == "__main__":
    sys.exit(main())

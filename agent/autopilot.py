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
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from ctypes import wintypes as wt
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from wecom_io_core import win  # noqa: E402

win.set_dpi_aware()

import compat  # noqa: E402
import reply_store as rlog  # noqa: E402
import client as agent_client  # noqa: E402

# 只打两个补丁：剪贴板写入、进会话后点一下输入框。
# 抢前台用 core/win.py 原版（ShowWindow + AttachThreadInput），
# 自己加 Alt / 点标题栏的版本反而会把焦点带偏，实测必失败。
compat.apply()
compat.apply_click_input()
compat.apply_pb_text()   # 长消息（>127 字节）的长度前缀不是合法 UTF-8，原解析会丢成空

from wecom_io_core import send as core_send  # noqa: E402
from wecom_io_core.store import Store  # noqa: E402

# Ctrl+F 唤出搜索后，等搜索结果渲染完再回车。
# 原包是 0.8s，本机实测经常抢跑（回车时结果还没出来），改为 2s。
core_send.SEARCH_DELAY = 2.0

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
    "reply_first": "1",
    "reply_next": "233",
    "interval": 3.0,
    "cooldown": 8.0,
    "backfill_hours": 1.0,   # 首次初始化时，只把最近 N 小时的消息当作待补发
    "brain": None,           # {"mode":"kb","base_url":...} 时走知识库，否则固定文本
}

_last_reply_at = 0.0

# ── 上报与心跳 ───────────────────────────────────────────────────────────────
# 只做 HTTP，不产生任何键鼠事件。失败一律忽略，下一轮自然补。
REPORT_STATE = ROOT / ".report_state.json"   # 游标 + 上次成功的 device_code
REPORT_INTERVAL = 30.0                       # 心跳/上报间隔（按时间戳判断，不 sleep）
REPORT_MAX_MESSAGES = 50                     # 单次上报最多条数
REPORT_FIRST_WINDOW = 24 * 3600              # 首次没有游标时只补最近 24 小时

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
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


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
    ) -> None:
        self.api = api
        self.store = store
        self.state_path = state_path
        self.interval = interval
        # Node 桥接客户端（4222）；None 表示未配置，完全跳过桥接上报
        self.bridge = bridge
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

    def _save(self) -> None:
        with self._lock:
            data = {
                "device_code": self.device_code,
                "cursor": dict(self._cursor),
                "baseline_ts": self._baseline,
                "last_report_at": datetime.now(timezone.utc).isoformat(),
            }
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.state_path)
        except OSError as exc:
            log(f"[上报] 游标写盘失败（忽略）：{exc}")

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
                    "direction": "outbound" if m.get("is_self") else "inbound",
                    "content": (m.get("text") or "")[:4000],
                    "content_type": "text" if m.get("is_text") else f"type{m.get('type') or 0}",
                    "sent_at": _iso(ts),
                }
            )
        batch["conversations"] = list(convs.values())
        return batch

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
        try:
            self._send_ingest(batch)
        except Exception as exc:  # noqa: BLE001
            log(f"[上报] 异常（忽略）：{agent_client.describe_error(exc)}")

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


def drain(store: Store, cfg: dict, *, dry: bool = False, wecom_state: str = "online") -> dict:
    """按消息时间正序处理 pending + failed。

    同一会话有多条未回消息时只回最新一条（其余标 skipped）——
    对方连发三条属于同一次接触，回三条会把风控和客户体验一起搞坏。

    `wecom_state != "online"` 时**一条都不发**，直接返回：
    窗口被隐藏/退回登录页还继续点，就是 11-02 被强退的原因。
    """
    global _last_reply_at, _last_error, _last_block_log
    stats = {"sent": 0, "failed": 0, "skipped": 0, "merged": 0, "blocked": 0}

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

    items = rlog.pending(include_failed=True)
    newest: dict[str, dict] = {}
    for it in items:
        cid = it["conv_id"]
        cur = newest.get(cid)
        if cur is None or int(it["msg_time"] or 0) >= int(cur["msg_time"] or 0):
            newest[cid] = it
    for it in items:
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

        if is_system_conv(cid, name):
            if not dry:
                rlog.mark_skipped(mid, "系统/官方会话")
            stats["skipped"] += 1
            log(f"跳过 {name or cid}：系统/官方会话")
            continue

        if not name or name == cid:
            if not dry:
                rlog.mark_skipped(mid, "会话没有可搜索的名字")
            stats["skipped"] += 1
            log(f"跳过 {cid}：会话没有可搜索的名字")
            continue

        text, scene = pick_reply(cid, cfg)
        if _brain is not None:
            hint = (it["in_text"] or "").strip()
            if hint:
                res = _brain.reply(hint, build_history(store, cid))
                if res["ok"]:
                    text, scene = res["reply"], "知识库"
                    log(f"    [brain] {res['detail']}")
                else:
                    log(f"    [brain] 未命中（{res['detail']}），回落固定文本 {text!r}")
            else:
                log(f"    [brain] 该消息没有文本（type={it['in_type']}），回落固定文本 {text!r}")

        wait = cfg["cooldown"] - (time.time() - _last_reply_at)
        if wait > 0:
            time.sleep(wait)

        log(f"[{scene}] {name} ← {preview!r} → {text!r}")
        if dry:
            log("    DRY-RUN，未发送")
            stats["sent"] += 1
            continue

        # 按键之前先确认剪贴板可写，避免 Ctrl+F 打开搜索框后才卡住
        if not compat.wait_clipboard_writable(timeout=15):
            rlog.mark_failed(mid, "剪贴板被占用超过 15 秒", scene, text)
            _last_error = "剪贴板被占用超过 15 秒"
            stats["failed"] += 1
            log("    跳过：剪贴板被占用（向日葵同步？）")
            continue

        try:
            result = core_send.send(
                store, name, text,
                verify_db=False,  # 回读在 core 里有 rowid 兼容问题，落库由下一轮扫描确认
                log=lambda s: log(f"    {s}"),
            )
            if result["ok"]:
                rlog.mark_sent(mid, scene, text)
                _last_reply_at = time.time()
                _last_error = ""
                stats["sent"] += 1
                log(f"    已发送：{result['detail']}")

                # 发完再判定谈单状态：绝不阻塞发送，也绝不影响发送结果
                if _brain is not None:
                    _observe_lead(store, cid, name, mid, log)
            else:
                rlog.mark_failed(mid, result["detail"], scene, text)
                _last_error = str(result["detail"])[:200]
                stats["failed"] += 1
                log(f"    发送失败：{result['detail']}")
        except Exception as exc:  # noqa: BLE001
            rlog.mark_failed(mid, f"{type(exc).__name__}: {exc}", scene, text)
            _last_error = f"{type(exc).__name__}: {exc}"[:200]
            stats["failed"] += 1
            log(f"    发送异常：{type(exc).__name__}: {exc}")
            traceback.print_exc(limit=2)

    return stats


def print_history(limit: int = 20) -> None:
    rows = rlog.recent(limit)
    if not rows:
        print("还没有记录")
        return
    print(f"{'状态':<9}{'收到时间':<18}{'会话':<18}{'内容':<24}回复")
    for r in rows:
        t = time.strftime("%m-%d %H:%M:%S", time.localtime(r["msg_time"] or 0))
        err = f"  ⚠ {r['error'][:40]}" if r["error"] and r["status"] != "sent" else ""
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
    rep = Reporter(api, store, device_code=code, bridge=bridge)
    if rep.device_code:
        log(f"[心跳] 目标 {server} / device_code={rep.device_code}")
    else:
        log(
            "[心跳] 没有 device_code：config.json 加 \"device_code\"、"
            "或传 --device-code、或设环境变量 AGENT_DEVICE_CODE（上报不受影响）"
        )
    return rep


def main() -> int:
    ap = argparse.ArgumentParser(description="企业微信自动回复（队列 + 回复历史）")
    ap.add_argument("--target", default=DEFAULTS["target"], help="all 或某个会话名")
    ap.add_argument("--reply-first", default=DEFAULTS["reply_first"])
    ap.add_argument("--reply-next", default=DEFAULTS["reply_next"])
    ap.add_argument("--interval", type=float, default=DEFAULTS["interval"])
    ap.add_argument("--cooldown", type=float, default=DEFAULTS["cooldown"])
    ap.add_argument("--backfill-hours", type=float, default=DEFAULTS["backfill_hours"])
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--dry", action="store_true", help="只登记不发送")
    ap.add_argument("--list", action="store_true", help="打印回复历史")
    ap.add_argument("--reset", action="store_true", help="把待发/失败的条目全部作废")
    ap.add_argument("--device-code", default="", help="设备编号，覆盖 config.json（心跳路径参数）")
    args = ap.parse_args()

    cfg = dict(DEFAULTS)
    cfg.update(target=args.target, reply_first=args.reply_first, reply_next=args.reply_next,
               interval=args.interval, cooldown=args.cooldown,
               backfill_hours=args.backfill_hours, dry_run=args.dry)

    # 从 config.json 读 brain 段（DEFAULTS 里没有，只能从这里进）
    # server / device_token / device_code 也从这里读，缺了就退化成"只回复、不上报"
    cfg_path = ROOT / "config.json"
    if cfg_path.is_file():
        try:
            file_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(file_cfg.get("brain"), dict):
                cfg["brain"] = file_cfg["brain"]
            cfg["server"] = (file_cfg.get("server") or "").strip()
            cfg["device_token"] = (file_cfg.get("device_token") or "").strip()
            cfg["device_code"] = (file_cfg.get("device_code") or "").strip()
            # 桥接心跳（4222）配置；缺失时桥接上报整体跳过，不影响主心跳
            cfg["bridge_server"] = (file_cfg.get("bridge_server") or "").strip()
            cfg["bridge_token"] = (file_cfg.get("bridge_token") or "").strip()
        except (OSError, ValueError) as exc:
            log(f"config.json 读取失败，按固定文本处理：{exc}")
    if args.device_code:
        cfg["device_code"] = args.device_code.strip()

    global _brain
    bcfg = cfg.get("brain") or {}
    if bcfg.get("mode") == "kb" and bcfg.get("base_url"):
        import brain as brain_mod

        _brain = brain_mod.Brain(
            bcfg["base_url"],
            bcfg.get("username", ""),
            bcfg.get("password", ""),
            timeout=float(bcfg.get("timeout") or 20),
            history_limit=int(bcfg.get("history_limit") or 6),
            mode="kb",
        )
        log(f"回复来源：知识库 {bcfg['base_url']}（失败回落固定文本）")
    else:
        log(f"回复来源：固定文本（brain.mode={bcfg.get('mode')!r}）")

    rlog.init()

    if args.list:
        print_history()
        return 0

    store = Store()
    if not store.data_dir:
        print("没找到企业微信数据目录")
        return 1
    log(f"数据目录 {store.data_dir}")
    scope = "全部会话（排除系统会话）" if cfg["target"] == "all" else f"仅 {cfg['target']!r}"
    log(f"监听范围 {scope} / 首次 {cfg['reply_first']!r} · 后续 {cfg['reply_next']!r} / "
        f"冷却 {cfg['cooldown']}s" + (" / DRY-RUN" if cfg["dry_run"] else ""))

    store.refresh()

    if args.reset:
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

    if not args.watch:
        wecom_state = detect_wecom_state()
        log(f"[自检] 企微状态 {wecom_state}（{WECOM_STATE_TEXT.get(wecom_state, '未知')}）")
        if reporter is not None:
            reporter.tick(wecom_state, pending_count(), force=True)
        scan(store, cfg)
        result = drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
        if reporter is not None:
            reporter.wait(25)  # 等心跳/上报发完再退出，最多 25 秒
        log(f"本轮完成：{result}")
        print_history(10)
        return 0

    wecom_state = detect_wecom_state()
    log(f"[自检] 企微状态 {wecom_state}（{WECOM_STATE_TEXT.get(wecom_state, '未知')}）")
    if reporter is not None:
        reporter.tick(wecom_state, pending_count(), force=True)
    scan(store, cfg)
    drain(store, cfg, dry=cfg["dry_run"], wecom_state=wecom_state)
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
        except KeyboardInterrupt:
            log("已停止")
            return 0
        except Exception as exc:  # noqa: BLE001
            log(f"本轮失败：{type(exc).__name__}: {exc}")
            traceback.print_exc(limit=2)
            time.sleep(cfg["interval"])


if __name__ == "__main__":
    sys.exit(main())

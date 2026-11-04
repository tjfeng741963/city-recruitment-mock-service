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
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from wecom_io_core import win  # noqa: E402

win.set_dpi_aware()

import compat  # noqa: E402
import reply_store as rlog  # noqa: E402

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


def drain(store: Store, cfg: dict, *, dry: bool = False) -> dict:
    """按消息时间正序处理 pending + failed。

    同一会话有多条未回消息时只回最新一条（其余标 skipped）——
    对方连发三条属于同一次接触，回三条会把风控和客户体验一起搞坏。
    """
    global _last_reply_at
    stats = {"sent": 0, "failed": 0, "skipped": 0, "merged": 0}

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
                stats["sent"] += 1
                log(f"    已发送：{result['detail']}")
            else:
                rlog.mark_failed(mid, result["detail"], scene, text)
                stats["failed"] += 1
                log(f"    发送失败：{result['detail']}")
        except Exception as exc:  # noqa: BLE001
            rlog.mark_failed(mid, f"{type(exc).__name__}: {exc}", scene, text)
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
    args = ap.parse_args()

    cfg = dict(DEFAULTS)
    cfg.update(target=args.target, reply_first=args.reply_first, reply_next=args.reply_next,
               interval=args.interval, cooldown=args.cooldown,
               backfill_hours=args.backfill_hours, dry_run=args.dry)

    # 从 config.json 读 brain 段（DEFAULTS 里没有，只能从这里进）
    cfg_path = ROOT / "config.json"
    if cfg_path.is_file():
        try:
            file_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(file_cfg.get("brain"), dict):
                cfg["brain"] = file_cfg["brain"]
        except (OSError, ValueError) as exc:
            log(f"config.json 读取失败，按固定文本处理：{exc}")

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

    if not args.watch:
        scan(store, cfg)
        result = drain(store, cfg, dry=cfg["dry_run"])
        log(f"本轮完成：{result}")
        print_history(10)
        return 0

    scan(store, cfg)
    drain(store, cfg, dry=cfg["dry_run"])
    last_sig = wal_signature(store.data_dir)
    log("开始监听（Ctrl+C 退出）")
    while True:
        try:
            time.sleep(cfg["interval"])
            sig = wal_signature(store.data_dir)
            if sig != last_sig:
                store.refresh()
                last_sig = sig
            n = scan(store, cfg)
            if n:
                log(f"新登记 {n} 条")
            drain(store, cfg, dry=cfg["dry_run"])
        except KeyboardInterrupt:
            log("已停止")
            return 0
        except Exception as exc:  # noqa: BLE001
            log(f"本轮失败：{type(exc).__name__}: {exc}")
            traceback.print_exc(limit=2)
            time.sleep(cfg["interval"])


if __name__ == "__main__":
    sys.exit(main())

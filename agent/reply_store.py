"""回复历史记录（本地 SQLite）。

为什么不用 JSON：`handled` 只有一个布尔语义，发送失败也会被算作"处理过"，
导致消息静默丢失（Daylan 那条就是这么丢的）。这里把状态拆成 4 态：

    pending  已入队，还没发
    sent     发送成功
    failed   发送失败（保留 error，重启后可以补发）
    skipped  不该发（系统会话 / 搜索不到会话名）

所有查询都以 message_id 做幂等键，重复扫描不会重复回复。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "reply_log.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS reply_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL UNIQUE,
    conv_id     TEXT NOT NULL,
    conv_name   TEXT,
    in_text     TEXT,
    in_type     INTEGER,
    msg_time    INTEGER,
    scene       TEXT,
    reply_text  TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    error       TEXT,
    created_at  REAL,
    replied_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_reply_status ON reply_log(status);
CREATE INDEX IF NOT EXISTS idx_reply_conv   ON reply_log(conv_id);
"""


def _conn() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init() -> None:
    con = _conn()
    try:
        con.executescript(SCHEMA)
        con.commit()
    finally:
        con.close()


def record_incoming(m: dict) -> bool:
    """登记一条对方发来的消息。已存在则返回 False（幂等）。"""
    con = _conn()
    try:
        cur = con.execute(
            """INSERT OR IGNORE INTO reply_log
               (message_id, conv_id, conv_name, in_text, in_type, msg_time, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (
                str(m.get("id")),
                m.get("conv_id") or "",
                m.get("conv_name") or "",
                (m.get("text") or "")[:500],
                int(m.get("type") or 0),
                int(m.get("time") or 0),
                time.time(),
            ),
        )
        con.commit()
        return cur.rowcount > 0
    finally:
        con.close()


def pending(include_failed: bool = True, limit: int = 200) -> list[dict]:
    """待发送的条目，按消息时间正序（失败的可一起补发）。"""
    statuses = ("pending", "failed") if include_failed else ("pending",)
    marks = ",".join("?" * len(statuses))
    con = _conn()
    try:
        rows = con.execute(
            f"SELECT * FROM reply_log WHERE status IN ({marks}) "
            f"ORDER BY msg_time ASC, id ASC LIMIT ?",
            (*statuses, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def mark_sent(message_id: str, scene: str, reply_text: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='sent', scene=?, reply_text=?, error=NULL, "
            "replied_at=? WHERE message_id=?",
            (scene, reply_text, time.time(), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def mark_failed(message_id: str, error: str, scene: str = "", reply_text: str = "") -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='failed', error=?, scene=?, reply_text=?, "
            "replied_at=? WHERE message_id=?",
            (str(error)[:500], scene, reply_text, time.time(), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def mark_skipped(message_id: str, reason: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='skipped', error=?, replied_at=? WHERE message_id=?",
            (str(reason)[:500], time.time(), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def sent_count(conv_id: str) -> int:
    """该会话已成功回复过几次 —— 决定下一次回 '1' 还是 '233'。"""
    con = _conn()
    try:
        return int(
            con.execute(
                "SELECT COUNT(*) FROM reply_log WHERE conv_id=? AND status='sent'",
                (conv_id,),
            ).fetchone()[0]
        )
    finally:
        con.close()


def known_message_ids() -> set[str]:
    con = _conn()
    try:
        return {r[0] for r in con.execute("SELECT message_id FROM reply_log")}
    finally:
        con.close()


def stats() -> dict:
    con = _conn()
    try:
        rows = con.execute("SELECT status, COUNT(*) FROM reply_log GROUP BY status").fetchall()
        out = {r[0]: r[1] for r in rows}
        out["total"] = sum(out.values())
        return out
    finally:
        con.close()


def recent(limit: int = 10) -> list[dict]:
    con = _conn()
    try:
        rows = con.execute(
            "SELECT * FROM reply_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


if __name__ == "__main__":
    init()
    print("表已就绪:", DB_PATH)
    print("统计:", stats())
    for r in recent(8):
        t = time.strftime("%m-%d %H:%M:%S", time.localtime(r["msg_time"] or 0))
        print(f"  [{r['status']:8s}] {t}  {(r['conv_name'] or '')[:14]:16s} "
              f"{(r['in_text'] or '')[:18]!r} -> {r['reply_text'] or '-'}"
              + (f"  err={r['error'][:30]}" if r["error"] else ""))

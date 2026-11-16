"""回复历史记录（本地 SQLite）。

为什么不用 JSON：`handled` 只有一个布尔语义，发送失败也会被算作"处理过"，
导致消息静默丢失（Daylan 那条就是这么丢的）。这里把状态拆成 5 态：

    pending  已入队，还没发
    sent     发送成功
    failed   发送失败（保留 error，重启后可以补发）
    skipped  不该发（系统会话 / 搜索不到会话名）
    held     知识库失败/非文本，待人工检查后显式重新入队
    unknown  回车已按但回读解密库确认不了落点：结果不明。不自动重发
             （重发可能重复打扰客户），由 --retry-held 人工重新入队

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
CREATE TABLE IF NOT EXISTS manual_commands (
    server          TEXT NOT NULL,
    device_code     TEXT NOT NULL,
    command_id      TEXT NOT NULL,
    lease_token     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','succeeded','failed')),
    message_id      TEXT NOT NULL DEFAULT '',
    receipt_state   TEXT NOT NULL DEFAULT 'pending' CHECK(receipt_state IN ('pending','acked','rejected')),
    error           TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL,
    PRIMARY KEY(server,device_code,command_id,lease_token)
);
CREATE INDEX IF NOT EXISTS idx_manual_receipts ON manual_commands(server,device_code,receipt_state,created_at);
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


def mark_unknown(message_id: str, error: str, scene: str = "", reply_text: str = "") -> None:
    """回车已按但回读确认不了：结果不明。

    不能记 sent（可能静默丢失），也不能记 failed（下一轮自动补发会把
    可能已经发出的内容再发一遍）。unknown 不参与自动补发，等人工核对。
    """
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='unknown', error=?, scene=?, reply_text=?, "
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


def mark_held(message_id: str, reason: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='held', error=?, scene='知识库', reply_text='', replied_at=? WHERE message_id=?",
            (str(reason)[:500], time.time(), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def retry_held() -> int:
    con = _conn()
    try:
        # held（知识库失败）与 unknown（回读未确认）都不参与自动补发，
        # 都靠这条命令显式重新入队；人工决定重发前先核对企微里有没有发出去。
        cur = con.execute(
            "UPDATE reply_log SET status='pending', error=NULL, replied_at=NULL "
            "WHERE status IN ('held','unknown')"
        )
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def begin_manual_command(server: str, device_code: str, command_id: str, lease_token: str) -> bool:
    """Commit an unknown outcome before input; a known attempt never sends twice."""
    con = _conn()
    try:
        con.execute("BEGIN IMMEDIATE")
        previous = con.execute(
            "SELECT status,lease_token FROM manual_commands WHERE server=? AND device_code=? AND command_id=?",
            (server, device_code, command_id),
        ).fetchall()
        if any(row["lease_token"] == lease_token or row["status"] != "failed" for row in previous):
            return False
        now = time.time()
        con.execute(
            "INSERT INTO manual_commands(server,device_code,command_id,lease_token,created_at,updated_at) VALUES (?,?,?,?,?,?)",
            (server, device_code, command_id, lease_token, now, now),
        )
        con.commit()
        return True
    finally:
        con.close()


def finish_manual_command(server: str, device_code: str, command_id: str, lease_token: str,
                          status: str, message_id: str = "") -> None:
    if status not in ("unknown", "succeeded", "failed") or (status == "succeeded" and not message_id.strip()):
        raise ValueError("Invalid manual command outcome")
    con = _conn()
    try:
        cur = con.execute(
            "UPDATE manual_commands SET status=?,message_id=?,updated_at=? "
            "WHERE server=? AND device_code=? AND command_id=? AND lease_token=? AND status='unknown' AND receipt_state='pending'",
            (status, message_id, time.time(), server, device_code, command_id, lease_token),
        )
        if cur.rowcount != 1:
            raise ValueError("Manual command attempt is missing or already finalized")
        con.commit()
    finally:
        con.close()


def pending_manual_receipts(server: str, device_code: str, limit: int = 50) -> list[dict]:
    con = _conn()
    try:
        return [dict(row) for row in con.execute(
            "SELECT * FROM manual_commands WHERE server=? AND device_code=? AND receipt_state='pending' "
            "ORDER BY created_at,command_id LIMIT ?", (server, device_code, limit),
        )]
    finally:
        con.close()


def mark_manual_receipt(server: str, device_code: str, command_id: str, lease_token: str,
                        receipt_state: str, error: str = "") -> None:
    if receipt_state not in ("acked", "rejected"):
        raise ValueError("Invalid receipt state")
    con = _conn()
    try:
        con.execute(
            "UPDATE manual_commands SET receipt_state=?,error=?,updated_at=? "
            "WHERE server=? AND device_code=? AND command_id=? AND lease_token=?",
            (receipt_state, error[:200], time.time(), server, device_code, command_id, lease_token),
        )
        con.commit()
    finally:
        con.close()


def recent_manual_receipts(limit: int = 20) -> list[dict]:
    """Operator output deliberately omits execution lease tokens."""
    con = _conn()
    try:
        return [dict(row) for row in con.execute(
            "SELECT command_id,status,receipt_state,error FROM manual_commands "
            "ORDER BY CASE receipt_state WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,updated_at DESC LIMIT ?", (limit,),
        )]
    finally:
        con.close()


def manual_receipt_counts(server: str, device_code: str) -> dict[str, int]:
    con = _conn()
    try:
        return {row["receipt_state"]: row["n"] for row in con.execute(
            "SELECT receipt_state,COUNT(*) n FROM manual_commands WHERE server=? AND device_code=? GROUP BY receipt_state",
            (server, device_code),
        )}
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

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

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "reply_log.db"

# 幂等键是 (conv_id, message_id)，不是 message_id 单列。
# 企业微信的 message_id 是**按登录账号自增**的，换账号后同一个数字会表示
# 另一个会话的另一条消息。旧表把它设成全局 UNIQUE，实测导致 11 条消息被
# `INSERT OR IGNORE` 静默吞掉，客户一直等不到回复。
_REPLY_LOG_COLUMNS = (
    "id", "message_id", "conv_id", "conv_name", "in_text", "in_type",
    "msg_time", "scene", "reply_text", "status", "error", "created_at", "replied_at",
)

_REPLY_LOG_DDL = """
CREATE TABLE reply_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL,
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
    replied_at  REAL,
    UNIQUE(conv_id, message_id)
)
"""

_REPLY_LOG_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_reply_status ON reply_log(status);
CREATE INDEX IF NOT EXISTS idx_reply_conv   ON reply_log(conv_id);
"""

REPLY_LOG_SCHEMA = _REPLY_LOG_DDL + ";\n" + _REPLY_LOG_INDEXES

SCHEMA = (
    _REPLY_LOG_DDL.replace("CREATE TABLE reply_log", "CREATE TABLE IF NOT EXISTS reply_log")
    + ";\n"
    + _REPLY_LOG_INDEXES
    + """
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
CREATE TABLE IF NOT EXISTS welcome_deliveries (
    conv_id TEXT PRIMARY KEY,
    trigger_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('preparing','ready','sending','held','sent','cancelled')),
    reply_text TEXT NOT NULL DEFAULT '',
    parts_json TEXT NOT NULL DEFAULT '[]',
    next_part INTEGER NOT NULL DEFAULT 0,
    consume_trigger INTEGER NOT NULL DEFAULT 1,
    error TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL
);
"""
)


def _conn() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


@contextmanager
def _welcome_conn():
    con = _conn()
    try:
        with con:
            yield con
    finally:
        con.close()


def _legacy_unique_on_message_id(con: sqlite3.Connection) -> bool:
    """旧库把 message_id 设成全局 UNIQUE，需要重建表才能去掉。

    只看 message_id 单列的唯一索引：如果索引列正好是 ['message_id']，
    说明还是旧结构；(conv_id, message_id) 两列索引不算。
    """
    try:
        indexes = con.execute("PRAGMA index_list(reply_log)").fetchall()
    except sqlite3.DatabaseError:
        return False
    for row in indexes:
        if not row["unique"]:
            continue
        columns = [r["name"] for r in con.execute(f"PRAGMA index_info({row['name']!r})")]
        if columns == ["message_id"]:
            return True
    return False


def _migrate_reply_log_key(con: sqlite3.Connection) -> None:
    """把 message_id 全局唯一改成 (conv_id, message_id) 复合唯一。

    SQLite 改不了索引约束，只能重建表。旧行原样搬过来；万一旧库里已经有
    (conv_id, message_id) 重复的历史脏数据，INSERT OR IGNORE 保留 id 最小的
    那条，避免迁移因约束冲突整体失败。
    """
    if not _legacy_unique_on_message_id(con):
        return
    columns = ", ".join(_REPLY_LOG_COLUMNS)
    con.execute("ALTER TABLE reply_log RENAME TO reply_log_legacy")
    con.execute(_REPLY_LOG_DDL)
    con.execute(
        f"INSERT OR IGNORE INTO reply_log ({columns}) "
        f"SELECT {columns} FROM reply_log_legacy ORDER BY id"
    )
    con.execute("DROP TABLE reply_log_legacy")
    con.executescript(_REPLY_LOG_INDEXES)


def init() -> None:
    con = _conn()
    try:
        con.executescript(SCHEMA)
        con.commit()
        _migrate_reply_log_key(con)
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


def mark_sent(message_id: str, conv_id: str, scene: str, reply_text: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='sent', scene=?, reply_text=?, error=NULL, "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (scene, reply_text, time.time(), str(conv_id), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def mark_failed(message_id: str, conv_id: str, error: str, scene: str = "", reply_text: str = "") -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='failed', error=?, scene=?, reply_text=?, "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (str(error)[:500], scene, reply_text, time.time(), str(conv_id), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def mark_unknown(message_id: str, conv_id: str, error: str, scene: str = "", reply_text: str = "") -> None:
    """回车已按但回读确认不了：结果不明。

    不能记 sent（可能静默丢失），也不能记 failed（下一轮自动补发会把
    可能已经发出的内容再发一遍）。unknown 不参与自动补发，等人工核对。
    """
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='unknown', error=?, scene=?, reply_text=?, "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (str(error)[:500], scene, reply_text, time.time(), str(conv_id), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def mark_skipped(message_id: str, conv_id: str, reason: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='skipped', error=?, replied_at=? "
            "WHERE conv_id=? AND message_id=?",
            (str(reason)[:500], time.time(), str(conv_id), str(message_id)),
        )
        con.commit()
    finally:
        con.close()


def mark_held(message_id: str, conv_id: str, reason: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='held', error=?, scene='知识库', reply_text='', "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (str(reason)[:500], time.time(), str(conv_id), str(message_id)),
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
            "WHERE status IN ('held','unknown') "
            "AND conv_id NOT IN (SELECT conv_id FROM welcome_deliveries WHERE state NOT IN ('sent','cancelled'))"
        )
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def welcome(conv_id: str) -> dict | None:
    with _welcome_conn() as con:
        row = con.execute("SELECT * FROM welcome_deliveries WHERE conv_id=?", (conv_id,)).fetchone()
    if row is None:
        return None
    return {**dict(row), "parts": json.loads(row["parts_json"])}


def active_welcomes() -> list[dict]:
    """Return original source rows even when the ordinary queue merged/held them."""
    with _welcome_conn() as con:
        return [dict(row) for row in con.execute(
            "SELECT r.*,w.state AS welcome_state FROM welcome_deliveries w "
            "JOIN reply_log r ON r.message_id=w.trigger_id WHERE w.state NOT IN ('sent','cancelled') "
            "ORDER BY r.msg_time,r.id")]


def welcome_history(limit: int = 20) -> list[dict]:
    with _welcome_conn() as con:
        return [dict(row) for row in con.execute(
            "SELECT w.*,r.conv_name FROM welcome_deliveries w JOIN reply_log r ON r.message_id=w.trigger_id "
            "ORDER BY w.updated_at DESC LIMIT ?", (limit,))]


def begin_welcome(conv_id: str, trigger_id: str, consume_trigger: bool) -> None:
    # Commit before HTTP: a crash after server-side stage advancement is unknown,
    # never an invitation to generate a different welcome or ordinary answer.
    with _welcome_conn() as con:
        con.execute("INSERT INTO welcome_deliveries(conv_id,trigger_id,state,consume_trigger,updated_at) "
                    "VALUES (?,?,'preparing',?,?)", (conv_id, trigger_id, int(consume_trigger), time.time()))


def save_welcome(conv_id: str, text: str, parts: list[str]) -> None:
    if not text.strip() or not parts or any(not isinstance(p, str) or not p.strip() for p in parts):
        raise ValueError("Invalid welcome snapshot")
    with _welcome_conn() as con:
        cur = con.execute("UPDATE welcome_deliveries SET reply_text=?,parts_json=?,state='ready',updated_at=? "
                          "WHERE conv_id=? AND state='preparing'", (text, json.dumps(parts, ensure_ascii=False), time.time(), conv_id))
        if cur.rowcount != 1:
            raise ValueError("Welcome is not preparing")
        con.execute("UPDATE reply_log SET scene='首句',reply_text=?,status='pending',error=NULL "
                    "WHERE conv_id=? AND message_id=(SELECT trigger_id FROM welcome_deliveries WHERE conv_id=?)",
                    (text, conv_id, conv_id))


def begin_welcome_part(conv_id: str, index: int) -> None:
    with _welcome_conn() as con:
        cur = con.execute("UPDATE welcome_deliveries SET state='sending',error='',updated_at=? "
                          "WHERE conv_id=? AND state='ready' AND next_part=?", (time.time(), conv_id, index))
        if cur.rowcount != 1:
            raise ValueError("Welcome part is not ready")


def fail_welcome(conv_id: str, reason: str, *, unknown: bool) -> None:
    with _welcome_conn() as con:
        state = 'held' if unknown else 'ready'
        cur = con.execute("UPDATE welcome_deliveries SET state=?,error=?,updated_at=? "
                          "WHERE conv_id=? AND state NOT IN ('sent','cancelled')", (state, reason[:500], time.time(), conv_id))
        if cur.rowcount != 1:
            return
        con.execute("UPDATE reply_log SET status=?,scene='首句',error=?,replied_at=? "
                    "WHERE conv_id=? AND message_id=(SELECT trigger_id FROM welcome_deliveries WHERE conv_id=?)",
                    ('held' if unknown else 'failed', reason[:500], time.time(), conv_id, conv_id))


def confirm_welcome_part(conv_id: str, index: int) -> bool:
    with _welcome_conn() as con:
        con.execute('BEGIN IMMEDIATE')
        row = con.execute("SELECT * FROM welcome_deliveries WHERE conv_id=?", (conv_id,)).fetchone()
        if row is None or row['state'] != 'sending' or row['next_part'] != index:
            raise ValueError("Welcome part has no matching attempt")
        complete = index + 1 == len(json.loads(row['parts_json']))
        con.execute("UPDATE welcome_deliveries SET next_part=?,state=?,error='',updated_at=? WHERE conv_id=?",
                    (index+1, 'sent' if complete else 'ready', time.time(), conv_id))
        if complete:
            if row['consume_trigger']:
                con.execute("UPDATE reply_log SET status='sent',scene='首句',reply_text=?,error=NULL,replied_at=? "
                            "WHERE conv_id=? AND message_id=?",
                            (row['reply_text'], time.time(), conv_id, row['trigger_id']))
            else:
                # A business question used to start the welcome must still be answered.
                con.execute("UPDATE reply_log SET status='pending',scene=NULL,reply_text=NULL,error=NULL,replied_at=NULL "
                            "WHERE conv_id=? AND message_id=?",
                            (conv_id, row['trigger_id']))
        return complete


def recover_welcomes() -> None:
    """Only call from the single sender, never from a concurrent --list command."""
    with _welcome_conn() as con:
        rows = con.execute("SELECT conv_id FROM welcome_deliveries WHERE state IN ('preparing','sending')").fetchall()
    for row in rows:
        fail_welcome(row['conv_id'], '首句生成或发送被中断，结果未知；请核对后处理，勿直接重发', unknown=True)


def resolve_welcome(conv_id: str, confirmed_parts: int) -> None:
    """Explicit operator reconciliation; does not send or regenerate any content."""
    with _welcome_conn() as con:
        con.execute('BEGIN IMMEDIATE')
        row = con.execute("SELECT * FROM welcome_deliveries WHERE conv_id=?", (conv_id,)).fetchone()
        parts = json.loads(row['parts_json']) if row else []
        if (row is None or row['state'] != 'held' or not parts or
                not row['next_part'] <= confirmed_parts <= min(len(parts), row['next_part'] + 1)):
            raise ValueError('只能核对暂停首句的当前一段；没有原文时不能重新生成')
        complete = confirmed_parts == len(parts)
        con.execute("UPDATE welcome_deliveries SET next_part=?,state=?,error='',updated_at=? WHERE conv_id=?",
                    (confirmed_parts, 'sent' if complete else 'ready', time.time(), conv_id))
        if complete and row['consume_trigger']:
            con.execute("UPDATE reply_log SET status='sent',scene='首句',reply_text=?,error=NULL,replied_at=? "
                        "WHERE conv_id=? AND message_id=?",
                        (row['reply_text'], time.time(), conv_id, row['trigger_id']))
        else:
            con.execute("UPDATE reply_log SET status='pending',error=NULL WHERE conv_id=? AND message_id=?",
                        (conv_id, row['trigger_id']))


def cancel_welcomes() -> None:
    with _welcome_conn() as con:
        con.execute("UPDATE welcome_deliveries SET state='cancelled',error='手动 reset',updated_at=? "
                    "WHERE state NOT IN ('sent','cancelled')", (time.time(),))


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

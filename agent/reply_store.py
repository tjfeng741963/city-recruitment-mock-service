"""回复历史记录（本地 SQLite）。

为什么不用 JSON：`handled` 只有一个布尔语义，发送失败也会被算作"处理过"，
导致消息静默丢失（Daylan 那条就是这么丢的）。这里把状态拆成 6 态：

    pending  已入队，还没发
    sent     发送成功
    failed   发送失败（保留 error，重启后可以补发）
    skipped  不该发（系统会话 / 搜索不到会话名）
    held     知识库失败/非文本，待人工检查后显式重新入队
    unknown  回车已按但回读解密库确认不了落点：结果不明。不自动重发
             （重发可能重复打扰客户），由 --retry-message 在核对后逐条重新入队

所有查询都以 message_id 做幂等键，重复扫描不会重复回复。
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from math import isfinite
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
    attempts    INTEGER NOT NULL DEFAULT 0,
    trace_id    TEXT NOT NULL DEFAULT '',
    last_step   TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER,
    dify_turn   TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS reply_recoveries (
    id INTEGER PRIMARY KEY,
    conv_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    operator TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_status TEXT NOT NULL,
    previous_error TEXT,
    requested_at REAL NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'queued',
    outcome_error TEXT,
    finished_at REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_reply_recovery
    ON reply_recoveries(conv_id,message_id) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS contact_baselines (
    account_key TEXT PRIMARY KEY,
    initialized_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS observed_contacts (
    account_key TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    first_seen_at REAL NOT NULL,
    welcome_pending INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(account_key,contact_id)
);
"""
)

_RECOVERY_TRIGGER = """
CREATE TRIGGER IF NOT EXISTS record_reply_recovery_result
AFTER UPDATE OF status, last_step ON reply_log
WHEN NEW.last_step <> 'recovery-queued'
BEGIN
    UPDATE reply_recoveries
    SET outcome=CASE WHEN NEW.last_step='recovery-failed' THEN 'failed' ELSE NEW.status END,
        outcome_error=NEW.error,
        finished_at=CASE WHEN NEW.last_step='sending' THEN NULL
                         ELSE MAX(requested_at,(julianday('now')-2440587.5)*86400.0) END
    WHERE conv_id=NEW.conv_id AND message_id=NEW.message_id AND finished_at IS NULL;
END;
"""

_HAS_INBOUND_TEXT = "TRIM(COALESCE({row}.in_text,''),CHAR(9,10,11,12,13,32))<>''"
_RECOVERY_HAS_NEWER_MESSAGE = f"""EXISTS (
    SELECT 1 FROM reply_log AS newer
    WHERE newer.conv_id=selected.conv_id AND {_HAS_INBOUND_TEXT.format(row="newer")}
      AND (COALESCE(newer.msg_time,0),newer.id)>(COALESCE(selected.msg_time,0),selected.id)
)"""
_MISSING_NAME_SKIP = """selected.status='skipped' AND selected.last_step='skipped'
        AND selected.error='会话没有可搜索的名字'"""
_RECIPIENT_UNSENT = f"""selected.attempts=0 AND {_HAS_INBOUND_TEXT.format(row="selected")} AND (
    (selected.status IN ('held','failed') AND selected.last_step='recipient-blocked')
    OR ({_MISSING_NAME_SKIP})
)"""
_SKIP_SUPERSEDED_RECOVERY = f"""UPDATE reply_log AS selected
    SET status='skipped',last_step='skipped',error='恢复排队后收到更新的消息',replied_at=?
    WHERE last_step IN ('recovery-queued','recipient-recovery-queued','name-recovery-queued')
    AND {_RECOVERY_HAS_NEWER_MESSAGE}"""
_LEGACY_PARTIAL = re.compile(r"^(?:已确认 [1-9]\d* 段文本，|开场第 \d+ 项未完成，已有 [1-9]\d* 项执行成功：)")


def _conn() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


_REPLY_MIGRATIONS = {
    "attempts": "INTEGER NOT NULL DEFAULT 0",
    "trace_id": "TEXT NOT NULL DEFAULT ''",
    "last_step": "TEXT NOT NULL DEFAULT ''",
    "duration_ms": "INTEGER",
    "dify_turn": "TEXT NOT NULL DEFAULT ''",
}
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
        # 老库平滑升级：SQLite 没有 ADD COLUMN IF NOT EXISTS，先看表结构。
        columns = {row["name"] for row in con.execute("PRAGMA table_info(reply_log)")}
        for name, ddl in _REPLY_MIGRATIONS.items():
            if name not in columns:
                con.execute(f"ALTER TABLE reply_log ADD COLUMN {name} {ddl}")
        con.commit()
        _migrate_reply_log_key(con)
        con.execute(_RECOVERY_TRIGGER)
        con.commit()
    finally:
        con.close()


def _record_incoming(con: sqlite3.Connection, m: dict) -> bool:
    cur = con.execute(
        """INSERT OR IGNORE INTO reply_log
           (message_id, conv_id, conv_name, in_text, in_type, msg_time, status,
            created_at, attempts, trace_id, last_step)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, 'created')""",
        (str(m.get("id")), m.get("conv_id") or "", m.get("conv_name") or "",
         (m.get("text") or "")[:500], int(m.get("type") or 0), int(m.get("time") or 0),
         time.time(), f"tr_{uuid.uuid4().hex[:12]}"),
    )
    return cur.rowcount > 0


def observe_contacts(account_key: str, contact_ids: list[str]) -> tuple[bool, dict[str, float]]:
    """Persist an account's first snapshot without welcoming historical contacts.

    Keep removed contacts and not-yet-named additions across restarts. A partial
    snapshot must never reset the baseline or turn returning old contacts new.
    """
    now = time.time()
    with _welcome_conn() as con:
        con.execute("BEGIN IMMEDIATE")
        initialized = con.execute(
            "SELECT 1 FROM contact_baselines WHERE account_key=?", (account_key,),
        ).fetchone() is not None
        con.executemany(
            "INSERT OR IGNORE INTO observed_contacts VALUES (?,?,?,?)",
            [(account_key, contact_id, now, int(initialized)) for contact_id in contact_ids],
        )
        con.execute("INSERT OR IGNORE INTO contact_baselines VALUES (?,?)", (account_key, now))
        pending = {row["contact_id"]: float(row["first_seen_at"]) for row in con.execute(
            "SELECT contact_id,first_seen_at FROM observed_contacts WHERE account_key=? AND welcome_pending=1",
            (account_key,),
        )}
    return not initialized, pending


def resolve_contact_welcome(account_key: str, contact_id: str, trigger: dict | None = None) -> bool:
    """Consume a new-contact observation and enqueue its trigger atomically."""
    with _welcome_conn() as con:
        con.execute("BEGIN IMMEDIATE")
        changed = con.execute(
            "UPDATE observed_contacts SET welcome_pending=0 "
            "WHERE account_key=? AND contact_id=? AND welcome_pending=1", (account_key, contact_id),
        ).rowcount
        return bool(changed and trigger is not None and _record_incoming(con, trigger))


def record_incoming(m: dict) -> bool:
    """登记一条对方发来的消息。已存在则返回 False（幂等）。"""
    con = _conn()
    try:
        added = _record_incoming(con, m)
        con.commit()
        return added
    finally:
        con.close()


def record_unread(m: dict, *, allow_requeue: bool = True) -> bool:
    """Enqueue a current unread message, or requeue a known unsent skip.

    Sent and unknown outcomes are deliberately left alone: a UI unread badge
    does not prove that the sender did not already deliver a reply.
    """
    if record_incoming(m):
        return True
    if not allow_requeue:
        return False

    message_id = str(m.get("id"))
    conv_id = str(m.get("conv_id") or "")
    con = _conn()
    try:
        row = con.execute(
            "SELECT id,status,error,last_step FROM reply_log WHERE conv_id=? AND message_id=?",
            (conv_id, message_id),
        ).fetchone()
        if row is None:
            return False

        error = str(row["error"] or "")
        requeue = (
            row["status"] == "skipped"
            and (error.startswith("历史消息") or error.startswith("同会话合并到最新一条"))
        ) or (
            row["status"] == "void"
            and row["last_step"] == "failed"
            and ("焦点未落在输入框" in error or "抢不到前台" in error)
        )
        if not requeue:
            return False
        active_welcome = con.execute(
            "SELECT 1 FROM welcome_deliveries WHERE conv_id=? "
            "AND state NOT IN ('sent','cancelled') LIMIT 1",
            (conv_id,),
        ).fetchone()
        if active_welcome:
            return False

        cur = con.execute(
            "UPDATE reply_log SET status='pending',error=NULL,scene=NULL,reply_text=NULL,"
            "replied_at=NULL,last_step='unread-requeued' WHERE id=? AND status=?",
            (row["id"], row["status"]),
        )
        con.commit()
        return cur.rowcount == 1
    finally:
        con.close()


def mark_recipient_blocked(message_id: str, conv_id: str, reason: str) -> bool:
    """Hold an inbound text before its first send attempt."""
    reason = reason.strip()
    if not reason:
        raise ValueError("Recipient hold requires a reason")
    with _welcome_conn() as con:
        changed = con.execute(
            f"""UPDATE reply_log AS selected SET status='held',last_step='recipient-blocked',
                       error=?,replied_at=?
                WHERE conv_id=? AND message_id=? AND status='pending' AND attempts=0
                  AND {_HAS_INBOUND_TEXT.format(row="selected")}""",
            (reason[:500], time.time(), str(conv_id), str(message_id)),
        ).rowcount
    return changed == 1


def recipient_blocked(conv_id: str) -> dict | None:
    """Latest inbound text awaiting recipient confirmation, including legacy skips."""
    with _welcome_conn() as con:
        row = con.execute(
            f"""SELECT selected.* FROM reply_log AS selected
                WHERE conv_id=? AND {_RECIPIENT_UNSENT} AND NOT {_RECOVERY_HAS_NEWER_MESSAGE}""",
            (str(conv_id),),
        ).fetchone()
    return dict(row) if row else None


def recipient_blocked_conversations(since: float) -> list[str]:
    """Find recent recipient holds that remain the latest text in their conversation."""
    with _welcome_conn() as con:
        rows = con.execute(
            f"""SELECT selected.conv_id FROM reply_log AS selected
                WHERE msg_time>=? AND {_RECIPIENT_UNSENT} AND NOT {_RECOVERY_HAS_NEWER_MESSAGE}
                ORDER BY selected.msg_time DESC, selected.id DESC""",
            (since,),
        ).fetchall()
    return [row["conv_id"] for row in rows]


def restore_recipient_blocked(conv_id: str, message_id: str, *, conv_name: str,
                              cutoff: float, outbound_at: float | None, missing_name: bool = False) -> bool:
    """Enqueue the latest eligible text once, after independently reading outbound history."""
    name = conv_name.strip()
    if not name or outbound_at is None or outbound_at < 0 or not isfinite(outbound_at) or not isfinite(cutoff):
        return False
    step = "name-recovery-queued" if missing_name else "recipient-recovery-queued"
    eligible = f"{_RECIPIENT_UNSENT} AND ({_MISSING_NAME_SKIP})" if missing_name else _RECIPIENT_UNSENT
    with _welcome_conn() as con:
        changed = con.execute(
            f"""UPDATE reply_log AS selected SET conv_name=?,status='pending',
                       last_step=?,error=NULL,replied_at=NULL
                WHERE conv_id=? AND message_id=? AND msg_time>=? AND msg_time>?
                  AND {eligible} AND NOT {_RECOVERY_HAS_NEWER_MESSAGE}
                  AND NOT EXISTS (
                      SELECT 1 FROM welcome_deliveries w WHERE w.conv_id=selected.conv_id
                        AND w.state NOT IN ('sent','cancelled')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM reply_log AS attempt WHERE attempt.conv_id=selected.conv_id
                        AND (attempt.status='unknown' OR attempt.last_step IN ('sending','partial'))
                        AND MAX(COALESCE(attempt.replied_at,0),COALESCE(attempt.msg_time,0))>=selected.msg_time
                  )""",
            (name, step, str(conv_id), str(message_id), cutoff, outbound_at),
        ).rowcount
    return changed == 1


def pending(include_failed: bool = True, limit: int = 200) -> list[dict]:
    """待发送的条目，按消息时间正序（失败的可一起补发）。"""
    statuses = ("pending", "failed") if include_failed else ("pending",)
    marks = ",".join("?" * len(statuses))
    con = _conn()
    try:
        rows = con.execute(
            f"SELECT * FROM reply_log WHERE status IN ({marks}) "
            f"AND last_step<>'recipient-blocked' ORDER BY msg_time ASC, id ASC LIMIT ?",
            (*statuses, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def begin_reply_attempt(message_id: str, conv_id: str, scene: str, reply_text: str = "") -> bool:
    """Commit an uncertain outcome before desktop input so a restart cannot replay it."""
    con = _conn()
    try:
        result = con.execute(
            f"""UPDATE reply_log AS selected SET status='unknown', error=?, scene=?, reply_text=?,
                last_step='sending', replied_at=? WHERE conv_id=? AND message_id=?
                AND status IN ('pending','failed') AND last_step<>'recipient-blocked'
                AND (last_step NOT IN ('recovery-queued','recipient-recovery-queued','name-recovery-queued')
                     OR NOT {_RECOVERY_HAS_NEWER_MESSAGE})""",
            ("发送被中断时请核对企微实际落点", scene, reply_text, time.time(), str(conv_id), str(message_id)),
        )
        if result.rowcount == 0:
            con.execute(_SKIP_SUPERSEDED_RECOVERY + " AND selected.conv_id=? AND selected.message_id=?",
                        (time.time(), str(conv_id), str(message_id)))
        con.commit()
        return result.rowcount == 1
    finally:
        con.close()


def reopen_for_reply(message_id: str, conv_id: str) -> bool:
    """把被开场「占位」的记录复位成 pending，让同一条消息能继续走正常回复。

    开场发送前会调 begin_reply_attempt(mid, ...)，把这条记录先置成
    status='unknown'（防止崩溃后重放）。开场文本确认成功后要接着回复客户这句
    话，但 begin_reply_attempt 只接受 pending/failed，于是发送被静默跳过
    （2026-11-25 实测：日志有 [Agent] 生成内容，却没有任何 wecom_send）。
    只在「开场文本已确认」后调用，避免掩盖真正的 unknown。
    """
    con = _conn()
    try:
        cur = con.execute(
            "UPDATE reply_log SET status='pending', error=NULL, last_step='reopen-after-opening'"
            " WHERE conv_id=? AND message_id=? AND status IN ('unknown','skipped')",
            (str(conv_id), str(message_id)),
        )
        con.commit()
        return cur.rowcount == 1
    finally:
        con.close()


def has_unconfirmed_opening(conv_id: str) -> bool:
    con = _conn()
    try:
        return con.execute(
            "SELECT 1 FROM reply_log WHERE conv_id=? AND scene='开场' AND status='unknown' LIMIT 1",
            (str(conv_id),),
        ).fetchone() is not None
    finally:
        con.close()


def mark_sent(message_id: str, conv_id: str, scene: str, reply_text: str,
              duration_ms: int = 0, *, verified: bool = False) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='sent', scene=?, reply_text=?, error=NULL, "
            "last_step=?, attempts=COALESCE(attempts,0)+1, duration_ms=?, "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (scene, reply_text, "sent-confirmed" if verified else "sent",
             max(0, int(duration_ms)), time.time(), str(conv_id), str(message_id)),

        )
        con.commit()
    finally:
        con.close()


def mark_failed(message_id: str, conv_id: str, error: str, scene: str = "", reply_text: str = "") -> None:
    con = _conn()
    try:
        con.execute(
            """UPDATE reply_log SET (status,last_step)=(
                   SELECT CASE WHEN is_recovery THEN 'held' ELSE 'failed' END,
                          CASE WHEN is_recovery THEN 'recovery-failed' ELSE 'failed' END
                   FROM (SELECT EXISTS (
                       SELECT 1 FROM reply_recoveries AS recovery
                       WHERE recovery.conv_id=reply_log.conv_id AND recovery.message_id=reply_log.message_id
                         AND recovery.finished_at IS NULL
                   ) AS is_recovery)
               ), error=?, scene=?, reply_text=?, attempts=COALESCE(attempts,0)+1, replied_at=?
               WHERE conv_id=? AND message_id=?""",
            (str(error)[:500], scene, reply_text, time.time(), str(conv_id), str(message_id)),

        )
        con.commit()
    finally:
        con.close()


def mark_unknown(message_id: str, conv_id: str, error: str, scene: str = "",
                 reply_text: str = "", *, partial: bool = False) -> None:
    """回车已按但回读确认不了：结果不明。

    不能记 sent（可能静默丢失），也不能记 failed（下一轮自动补发会把
    可能已经发出的内容再发一遍）。unknown 不参与自动补发，等人工核对。
    """
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='unknown', error=?, scene=?, reply_text=?, "
            "last_step=?, attempts=COALESCE(attempts,0)+1, "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (str(error)[:500], scene, reply_text, "partial" if partial else "unknown",
             time.time(), str(conv_id), str(message_id)),

        )
        con.commit()
    finally:
        con.close()


def mark_skipped(message_id: str, conv_id: str, reason: str) -> None:
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='skipped', error=?, last_step='skipped', "
            "replied_at=? WHERE conv_id=? AND message_id=?",
            (str(reason)[:500], time.time(), str(conv_id), str(message_id)),

        )
        con.commit()
    finally:
        con.close()


def merge_dify_turn(conv_id: str, current_id: str, earlier_ids: list[str], turn: str) -> None:
    """Keep the same incoming batch available for an explicit retry."""
    with _welcome_conn() as con:
        con.execute("UPDATE reply_log SET dify_turn=? WHERE conv_id=? AND message_id=?", (turn, conv_id, current_id))
        con.executemany(
            "UPDATE reply_log SET status='skipped',error=?,last_step='skipped',replied_at=? "
            "WHERE conv_id=? AND message_id=? AND status IN ('pending','failed')",
            [("已合入本轮 Dify 回复", time.time(), conv_id, mid) for mid in earlier_ids],
        )


def mark_held(message_id: str, conv_id: str, reason: str, scene: str | None = None) -> None:
    """把一条记录挂成 held（等人工处理）。

    scene 可选：开场失败时要记成「开场」，方便后台按场景筛选。
    2026-11-25 修：开场分支一直按 4 个参数调用，而这里只有 3 个形参，
    导致 TypeError 把「挂起」这个动作本身也炸掉——记录卡在 pending，
    客户既收不到回复也不会进人工队列（Garbo_C 那条就是这样丢的）。
    """
    con = _conn()
    try:
        con.execute(
            "UPDATE reply_log SET status='held', error=?, scene=?, reply_text='', "
            "last_step='held', replied_at=? WHERE conv_id=? AND message_id=?",
            (str(reason)[:500], scene or "知识库", time.time(), str(conv_id), str(message_id)),

        )
        con.commit()
    finally:
        con.close()


def hold_before(cutoff: float) -> int:
    """Keep aged customer inputs available for review. Never touch unknown sends."""
    con = _conn()
    try:
        result = con.execute(
            """UPDATE reply_log SET status='held',last_step='held',
               error='消息已超过自动恢复时限，请人工核对'
               WHERE status IN ('pending','failed') AND last_step NOT IN ('recovery-queued','recipient-blocked')
                 AND msg_time>0 AND msg_time<?""",
            (cutoff,),
        )
        con.commit()
        return result.rowcount
    finally:
        con.close()


def retry_held() -> int:
    con = _conn()
    try:
        cur = con.execute(
            """UPDATE reply_log SET status='pending', error=NULL, replied_at=NULL, last_step='requeued'
               WHERE status='held' AND last_step='held' AND error LIKE 'Agent 暂停，待人工处理：%'
                 AND NOT EXISTS (SELECT 1 FROM reply_recoveries AS recovery
                    WHERE recovery.conv_id=reply_log.conv_id AND recovery.message_id=reply_log.message_id)
                 AND conv_id NOT IN (SELECT conv_id FROM welcome_deliveries WHERE state NOT IN ('sent','cancelled'))"""
        )
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def queue_reply_recovery(conv_id: str, message_id: str, *, reason: str,
                         operator: str, legacy_sent: bool = False) -> str:
    """Queue one operator-reviewed message and save its prior state in the same transaction."""
    reason = reason.strip()
    if not conv_id.strip() or not message_id.strip() or not reason or not operator.strip():
        raise ValueError("恢复需要会话编号、消息编号、核对说明和操作者")
    con = _conn()
    try:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT id,status,last_step,error,msg_time,in_text FROM reply_log WHERE conv_id=? AND message_id=?",
            (conv_id, message_id),
        ).fetchone()
        if row is None:
            return "not_found"
        if row["last_step"] in ("recovery-queued", "recipient-recovery-queued", "name-recovery-queued"):
            return "already_queued"
        if row["last_step"] == "sending":
            return "in_progress"
        if row["last_step"] == "recipient-blocked":
            return "not_eligible"
        if row["last_step"] == "partial" or (
            row["status"] == "unknown" and _LEGACY_PARTIAL.match(row["error"] or "")
        ):
            return "partial"
        eligible = (row["status"] in ("held", "unknown") if not legacy_sent
                    else row["status"] == "sent" and row["last_step"] != "sent-confirmed")
        if not eligible or not (row["in_text"] or "").strip():
            return "not_eligible"
        if con.execute(
            """SELECT 1 FROM reply_log WHERE conv_id=? AND TRIM(COALESCE(in_text,''))<>''
               AND (COALESCE(msg_time,0),id)>(?,?) LIMIT 1""",
            (conv_id, row["msg_time"] or 0, row["id"]),
        ).fetchone():
            return "superseded"
        if con.execute(
            "SELECT 1 FROM welcome_deliveries WHERE conv_id=? AND state NOT IN ('sent','cancelled')",
            (conv_id,),
        ).fetchone():
            return "welcome_pending"
        con.execute(
            """INSERT INTO reply_recoveries
               (conv_id,message_id,operator,reason,previous_status,previous_error,requested_at)
               VALUES (?,?,?,?,?,?,?)""",
            (conv_id, message_id, operator, reason, row["status"], row["error"], time.time()),
        )
        con.execute(
            "UPDATE reply_log SET status='pending',error=NULL,last_step='recovery-queued' WHERE id=?",
            (row["id"],),
        )
        con.commit()
        return "queued"
    finally:
        con.close()


def recover_interrupted_replies() -> None:
    """Called under the sender's single-instance lock before processing new input."""
    con = _conn()
    try:
        con.execute("UPDATE reply_log SET last_step='unknown' WHERE status='unknown' AND last_step='sending'")
        con.commit()
    finally:
        con.close()


def skip_superseded_reply_recoveries() -> int:
    con = _conn()
    try:
        result = con.execute(_SKIP_SUPERSEDED_RECOVERY, (time.time(),))
        con.commit()
        return result.rowcount
    finally:
        con.close()


def recent_reply_recoveries(limit: int = 20) -> list[dict]:
    con = _conn()
    try:
        return [dict(row) for row in con.execute("SELECT * FROM reply_recoveries ORDER BY id DESC LIMIT ?", (limit,))]
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


def opening_sent(conv_id: str) -> bool:
    """该会话是否真的发过开场白。

    2026-11-24：`_is_first_contact` 原来用 sent_count>0 判断「已打过招呼」，
    只要回过任何一句话就把会话记进 greeted，导致换账号后那批只被 AI 回过
    几句、从没收到岗位信息开场白的客户永远收不到开场白。改判定依据为
    「有没有 scene='开场' 的 sent 记录」。
    """
    con = _conn()
    try:
        return con.execute(
            "SELECT 1 FROM reply_log WHERE conv_id=? AND scene='开场' AND status='sent' LIMIT 1",
            (str(conv_id),),
        ).fetchone() is not None
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

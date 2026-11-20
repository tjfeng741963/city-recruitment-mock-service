"""节点流程的本地持久化状态。

这个模块只负责游标、会话阶段和发件箱幂等，不执行任何企微键鼠动作。
动作层仍由 autopilot.py + wecom_io_core 负责；因此可以先用纯 Python 测试
断线恢复、复聊一次性和逐条发送幂等，再接入真实客户端。
"""

from __future__ import annotations

import sqlite3
import json
import time
from contextlib import contextmanager, closing
from pathlib import Path
from typing import Any

PHASES = ("idle", "running", "awaiting", "followup_due", "followup_sent", "replied", "expired", "held")
OUTBOX_STATUSES = ("sending", "sent", "failed", "skipped", "unknown")

SCHEMA = """
CREATE TABLE IF NOT EXISTS conv_state (
    session_key TEXT PRIMARY KEY,
    device_code TEXT NOT NULL DEFAULT '',
    position_id INTEGER NOT NULL DEFAULT 0,
    flow_version INTEGER NOT NULL DEFAULT 0,
    node_key TEXT NOT NULL DEFAULT '',
    step_index INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'idle',
    await_since REAL,
    followup_sent_at REAL,
    followup_round INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    wait_minutes INTEGER NOT NULL DEFAULT 15,
    conv_name TEXT NOT NULL DEFAULT '',
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    last_inbound_at REAL NOT NULL DEFAULT 0,
    last_inbound_id TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    node_key TEXT NOT NULL,
    part_index INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL DEFAULT '',
    media_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sending',
    error TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    sent_at REAL,
    UNIQUE(session_key, node_key, part_index)
);
CREATE INDEX IF NOT EXISTS idx_conv_due ON conv_state(phase, await_since);
CREATE INDEX IF NOT EXISTS idx_outbox_session ON outbox(session_key, node_key, part_index);
CREATE TABLE IF NOT EXISTS flow_meta (key TEXT PRIMARY KEY, value REAL NOT NULL);
"""


class FlowState:
    """单进程 sender 使用的 SQLite 状态仓库。每个方法都是短事务。"""

    def __init__(self, path: str | Path, *, now=time.time) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._now = now
        self._init()

    @contextmanager
    def _connect(self):
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
        finally:
            con.close()

    def _init(self) -> None:
        with self._connect() as con:
            con.executescript(SCHEMA)
            columns = {row[1] for row in con.execute("PRAGMA table_info(conv_state)")}
            for name, ddl in {
                "wait_minutes": "INTEGER NOT NULL DEFAULT 15",
                "conv_name": "TEXT NOT NULL DEFAULT ''",
                "snapshot_json": "TEXT NOT NULL DEFAULT '{}'",
                "revision": "INTEGER NOT NULL DEFAULT 1",
                "last_inbound_at": "REAL NOT NULL DEFAULT 0",
                "last_inbound_id": "TEXT NOT NULL DEFAULT ''",
            }.items():
                if name not in columns:
                    con.execute(f"ALTER TABLE conv_state ADD COLUMN {name} {ddl}")
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA busy_timeout=5000")
            con.commit()

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def get(self, session_key: str) -> dict[str, Any] | None:
        with self._connect() as con:
            return self._row(con.execute("SELECT * FROM conv_state WHERE session_key=?", (session_key,)).fetchone())

    def list(self, device_code: str = "", limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as con:
            if device_code:
                rows = con.execute("SELECT * FROM conv_state WHERE device_code=? ORDER BY updated_at DESC LIMIT ?", (device_code, limit)).fetchall()
            else:
                rows = con.execute("SELECT * FROM conv_state ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
            return [dict(row) for row in rows]

    def upsert(self, session_key: str, *, device_code: str = "", position_id: int = 0,
               flow_version: int = 0, node_key: str = "", step_index: int = 0,
               phase: str = "idle", await_since: float | None = None,
               followup_sent_at: float | None = None, followup_round: int = 0,
               last_error: str = "", wait_minutes: int = 15, conv_name: str = "",
               snapshot_json: str = "{}", revision: int | None = None) -> dict[str, Any]:
        self._validate_phase(phase)
        if followup_round not in (0, 1):
            raise ValueError("followup_round must be 0 or 1")
        now = float(self._now())
        with self._connect() as con:
            existing = con.execute("SELECT revision FROM conv_state WHERE session_key=?", (session_key,)).fetchone()
            next_revision = max(1, int(revision or 1)) if existing is None else max(
                int(existing[0]) + 1, int(revision or 0)
            )
            con.execute("""INSERT INTO conv_state
                (session_key,device_code,position_id,flow_version,node_key,step_index,phase,
                 await_since,followup_sent_at,followup_round,last_error,wait_minutes,conv_name,snapshot_json,revision,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(session_key) DO UPDATE SET device_code=excluded.device_code,
                position_id=excluded.position_id,flow_version=excluded.flow_version,node_key=excluded.node_key,
                step_index=excluded.step_index,phase=excluded.phase,await_since=excluded.await_since,
                followup_sent_at=excluded.followup_sent_at,followup_round=excluded.followup_round,
                last_error=excluded.last_error,wait_minutes=excluded.wait_minutes,conv_name=excluded.conv_name,
                snapshot_json=excluded.snapshot_json,revision=excluded.revision,updated_at=excluded.updated_at""",
                (session_key, device_code, int(position_id), int(flow_version), node_key, int(step_index), phase,
                 await_since, followup_sent_at, followup_round, str(last_error)[:2000], max(1, int(wait_minutes)),
                 str(conv_name)[:200], str(snapshot_json), next_revision, now))
            con.commit()
        return self.get(session_key) or {}

    def set_phase(self, session_key: str, phase: str, *, error: str = "",
                  await_since: float | None = None, followup_sent_at: float | None = None) -> bool:
        self._validate_phase(phase)
        with self._connect() as con:
            cur = con.execute("""UPDATE conv_state SET phase=?,last_error=?,await_since=?,followup_sent_at=?,revision=revision+1,updated_at=?
                WHERE session_key=?""", (phase, str(error)[:2000], await_since, followup_sent_at, float(self._now()), session_key))
            con.commit()
            return cur.rowcount == 1

    def set_step(self, session_key: str, node_key: str, step_index: int) -> bool:
        with self._connect() as con:
            cur = con.execute("UPDATE conv_state SET node_key=?,step_index=?,revision=revision+1,updated_at=? WHERE session_key=?",
                              (node_key, int(step_index), float(self._now()), session_key))
            con.commit()
            return cur.rowcount == 1

    def update(self, session_key: str, **fields) -> None:
        allowed = {"wait_minutes", "last_inbound_at", "last_inbound_id", "followup_sent_at", "followup_round", "phase", "last_error"}
        if not fields or not set(fields).issubset(allowed):
            raise ValueError("invalid state fields")
        if "phase" in fields:
            self._validate_phase(fields["phase"])
        with self._connect() as con:
            assignments = ",".join(f"{key}=?" for key in fields)
            con.execute(f"UPDATE conv_state SET {assignments},revision=revision+1,updated_at=? WHERE session_key=?",
                        (*fields.values(), float(self._now()), session_key))

    def claim_device_followup(self, now: float, interval: float = 60) -> bool:
        """Durable device-wide rate limit, including failed attempts and restarts."""
        with self._connect() as con:
            cur = con.execute("""INSERT INTO flow_meta(key,value) VALUES ('last_followup',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                WHERE flow_meta.value<=?""", (now, now - interval))
            return cur.rowcount == 1

    def claim_step(self, session_key: str, node_key: str, part_index: int, *, body: str = "",
                   media_name: str = "") -> bool:
        """声明一条待发送消息；同一会话/节点/段重复 claim 返回 False。"""
        if part_index < 0:
            raise ValueError("part_index must be non-negative")
        key = f"flow:{session_key}:{node_key}:{part_index}"
        with self._connect() as con:
            try:
                con.execute("INSERT INTO outbox(session_key,node_key,part_index,idempotency_key,body,media_name,created_at) VALUES (?,?,?,?,?,?,?)",
                            (session_key, node_key, part_index, key, body, media_name, float(self._now())))
                con.commit()
                return True
            except sqlite3.IntegrityError:
                con.rollback()
                return False

    def mark_outbox(self, session_key: str, node_key: str, part_index: int, status: str, error: str = "") -> bool:
        if status not in OUTBOX_STATUSES:
            raise ValueError(f"invalid outbox status: {status}")
        sent_at = float(self._now()) if status == "sent" else None
        with self._connect() as con:
            cur = con.execute("UPDATE outbox SET status=?,error=?,sent_at=? WHERE session_key=? AND node_key=? AND part_index=?",
                              (status, str(error)[:2000], sent_at, session_key, node_key, int(part_index)))
            con.commit()
            return cur.rowcount == 1

    def outbox(self, session_key: str, node_key: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as con:
            if node_key is None:
                rows = con.execute("SELECT * FROM outbox WHERE session_key=? ORDER BY id", (session_key,)).fetchall()
            else:
                rows = con.execute("SELECT * FROM outbox WHERE session_key=? AND node_key=? ORDER BY part_index",
                                   (session_key, node_key)).fetchall()
            return [dict(row) for row in rows]

    def due_followups(self, now: float | None = None) -> list[dict[str, Any]]:
        current = float(self._now() if now is None else now)
        with self._connect() as con:
            rows = con.execute("""SELECT * FROM conv_state
                WHERE phase IN ('awaiting','followup_due') AND followup_round=0
                AND await_since IS NOT NULL AND await_since <= (? - wait_minutes * 60)
                ORDER BY await_since,session_key""", (current,)).fetchall()
            return [dict(row) for row in rows]

    def claim_followup(self, session_key: str) -> bool:
        """把到期会话原子地占用为 followup_due；成功最多一次。"""
        with self._connect() as con:
            cur = con.execute("""UPDATE conv_state SET phase='followup_due',followup_round=1,revision=revision+1,updated_at=?
                WHERE session_key=? AND phase IN ('awaiting','followup_due') AND followup_round=0""",
                              (float(self._now()), session_key))
            con.commit()
            return cur.rowcount == 1

    def mark_followup_sent(self, session_key: str) -> bool:
        with self._connect() as con:
            cur = con.execute("UPDATE conv_state SET phase='followup_sent',followup_sent_at=?,revision=revision+1,updated_at=? WHERE session_key=? AND followup_round=1",
                              (float(self._now()), float(self._now()), session_key))
            con.commit()
            return cur.rowcount == 1

    def stale_followups(self, now: float | None = None, older_than: float = 1800) -> list[dict[str, Any]]:
        current = float(self._now() if now is None else now)
        with self._connect() as con:
            return [dict(row) for row in con.execute("SELECT * FROM conv_state WHERE phase='followup_sent' AND followup_sent_at IS NOT NULL AND followup_sent_at<=? ORDER BY followup_sent_at",
                                                      (current - older_than,)).fetchall()]

    def reconcile(self, now: float | None = None, *, unknown_after: float = 600,
                  expire_after: float = 1800) -> dict[str, int]:
        """启动/重新上线时收敛悬挂状态，不重发未知结果。"""
        current = float(self._now() if now is None else now)
        result = {"unknown": 0, "followup_due": 0, "expired": 0, "held": 0}
        with self._connect() as con:
            cur = con.execute("UPDATE outbox SET status='unknown',error='进程中断，结果未知' WHERE status='sending' AND created_at<=?",
                              (current - unknown_after,))
            result["unknown"] = cur.rowcount
            cur = con.execute("""UPDATE conv_state SET phase='held',last_error='未确认的发件箱记录，待人工核对',
                revision=revision+1,updated_at=? WHERE phase<>'held' AND
                (session_key IN (SELECT session_key FROM outbox WHERE status IN ('sending','unknown','failed','skipped'))
                 OR (phase='followup_due' AND followup_round=1))""", (current,))
            result["held"] = cur.rowcount
            cur = con.execute("UPDATE conv_state SET phase='followup_due',revision=revision+1,updated_at=? WHERE phase='awaiting' AND followup_round=0 AND await_since IS NOT NULL AND await_since<=? - wait_minutes*60",
                              (current, current))
            result["followup_due"] = cur.rowcount
            cur = con.execute("UPDATE conv_state SET phase='expired',revision=revision+1,updated_at=? WHERE phase='followup_sent' AND followup_sent_at IS NOT NULL AND followup_sent_at<=?",
                              (current, current - expire_after))
            result["expired"] = cur.rowcount
            con.commit()
        return result

    def snapshot(self, destination: str | Path) -> None:
        target = Path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as source, closing(sqlite3.connect(target)) as backup:
            source.backup(backup)

    def restore_mirror(self, items: list[dict], device_code: str) -> int:
        """Restore missing cursors, never infer delivery from a server cursor.

        An active cursor without its local outbox needs operator reconciliation.
        Sequence numbers cannot order branches, so revision is the only ordering.
        """
        from datetime import datetime
        def timestamp(value):
            if not value:
                return None
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        count = 0
        for row in items:
            cid = str(row.get("session_key") or "")
            if row.get("device_code") != device_code or not cid.startswith(("S:", "R:")):
                continue
            existing = self.get(cid)
            if existing:
                if int(row.get("revision") or 1) > existing["revision"]:
                    self.update(cid, phase="held", last_error="服务端游标比本地新，待人工核对")
                continue
            phase = str(row.get("phase") or "held")
            if phase not in ("expired", "replied", "followup_sent"):
                phase = "held"
            self.upsert(cid, device_code=device_code, position_id=int(row.get("position_id") or 0),
                        flow_version=int(row.get("flow_version") or 0), node_key=str(row.get("node_key") or ""),
                        step_index=int(row.get("step_index") or 0), phase=phase,
                        followup_round=int(row.get("followup_round") or 0), conv_name=str(row.get("conv_name") or ""),
                        followup_sent_at=timestamp(row.get("followup_sent_at")), await_since=timestamp(row.get("await_since")),
                        snapshot_json=json.dumps(row.get("snapshot") or {}, ensure_ascii=False),
                        revision=int(row.get("revision") or 1) + 1,
                        last_error="从服务端恢复；缺少本地发件箱时不自动续发" if phase == "held" else "")
            count += 1
        return count

    def daily_snapshot(self, now: float | None = None, keep: int = 7) -> None:
        from datetime import datetime, timedelta, timezone
        china = datetime.fromtimestamp(self._now() if now is None else now, timezone(timedelta(hours=8)))
        # Before 03:00 use yesterday's backup date, then naturally roll at 03:00.
        day = (china - timedelta(hours=3)).strftime("%Y%m%d")
        folder = self.path.parent / "snapshots"
        target = folder / f"flow_state-{day}.db"
        if not target.exists():
            self.snapshot(target)
            for old in sorted(folder.glob("flow_state-*.db"), reverse=True)[keep:]:
                old.unlink()

    @staticmethod
    def _validate_phase(phase: str) -> None:
        if phase not in PHASES:
            raise ValueError(f"invalid phase: {phase}")

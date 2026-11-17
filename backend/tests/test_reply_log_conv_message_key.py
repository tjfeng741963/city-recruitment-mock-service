"""reply_log 幂等键必须是 (conv_id, message_id)，不能是 message_id 单列。

企业微信的 message_id 是按登录账号自增的：同一个数字在 A 号表示 A 号会话
里的某条消息，在 B 号表示另一条完全不同的消息。旧的 message_id UNIQUE 约束
会让换账号后的消息被 `INSERT OR IGNORE` 静默吞掉，客户一直等不到回复
（2026-11-17 实测 11 条被吞）。
"""
from __future__ import annotations

import sqlite3

import pytest

from tests.agent_loader import load_reply_store


@pytest.fixture
def records(tmp_path):
    return load_reply_store(tmp_path / "reply_log.db")


def incoming(records, mid, conv_id, text="你好"):
    return records.record_incoming({
        "id": mid,
        "conv_id": conv_id,
        "conv_name": conv_id.split("_")[-1],
        "text": text,
        "type": 1,
        "time": 100 + int(mid),
    })


def test_same_message_id_on_two_accounts_both_recorded(records):
    assert incoming(records, 77, "S:acctA_contact1") is True
    assert incoming(records, 77, "S:acctB_contact2") is True
    rows = {(r["conv_id"], r["message_id"]) for r in records.pending()}
    assert rows == {("S:acctA_contact1", "77"), ("S:acctB_contact2", "77")}


def test_same_message_id_on_same_conversation_is_idempotent(records):
    assert incoming(records, 77, "S:acctA_contact1") is True
    assert incoming(records, 77, "S:acctA_contact1") is False
    assert len(records.pending()) == 1


def test_mark_sent_only_touches_its_own_conversation(records):
    incoming(records, 77, "S:acctA_contact1")
    incoming(records, 77, "S:acctB_contact2")
    records.mark_sent("77", "S:acctA_contact1", "首句", "回复 A")
    status = {(r["conv_id"], r["message_id"]): r["status"] for r in records.recent(10)}
    assert status[("S:acctA_contact1", "77")] == "sent"
    assert status[("S:acctB_contact2", "77")] == "pending"


def test_legacy_unique_message_id_table_is_migrated(tmp_path):
    path = tmp_path / "legacy.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE reply_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE,
            conv_id TEXT NOT NULL,
            conv_name TEXT, in_text TEXT, in_type INTEGER, msg_time INTEGER,
            scene TEXT, reply_text TEXT, status TEXT NOT NULL DEFAULT 'pending',
            error TEXT, created_at REAL, replied_at REAL
        );
        INSERT INTO reply_log(message_id, conv_id, in_text, status, created_at) VALUES
            ('5', 'S:acctA_contact1', '旧消息 A', 'sent', 1),
            ('6', 'S:acctB_contact2', '旧消息 B', 'pending', 2);
    """)
    con.commit()
    con.close()

    module = load_reply_store(path)

    con = sqlite3.connect(path)
    unique_columns = None
    for row in con.execute("PRAGMA index_list(reply_log)"):
        if row[1].startswith("sqlite_autoindex") and row[2]:
            unique_columns = [r[2] for r in con.execute(f"PRAGMA index_info('{row[1]}')")]
    preserved = con.execute(
        "SELECT id, message_id, conv_id, status FROM reply_log ORDER BY id"
    ).fetchall()
    legacy_left = con.execute(
        "SELECT count(*) FROM sqlite_master WHERE name='reply_log_legacy'"
    ).fetchone()[0]
    con.close()

    assert unique_columns == ["conv_id", "message_id"]
    assert preserved == [(1, "5", "S:acctA_contact1", "sent"), (2, "6", "S:acctB_contact2", "pending")]
    assert legacy_left == 0
    # 迁移后的库能让旧 message_id 出现在另一个账号的会话里
    assert incoming(module, 5, "S:acctC_contact3") is True

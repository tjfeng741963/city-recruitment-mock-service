"""现有客户端日志与 reply_log 升级的回归测试（不碰真实键鼠）。"""

from __future__ import annotations

import re
import sqlite3

from tests.agent_loader import load_autopilot, load_reply_store


def test_log_has_date_level_scope_and_redaction(tmp_path, monkeypatch):
    agent = load_autopilot()
    log_path = tmp_path / "run.log"
    monkeypatch.setattr(agent, "LOG_DIR", tmp_path)
    monkeypatch.setattr(agent, "LOG_PATH", log_path)
    monkeypatch.setattr(agent, "LOG_MAX_BYTES", 10_000)
    monkeypatch.setattr(agent, "LOG_BACKUP_COUNT", 2)

    agent.log("手机13812345678 发送失败", scope="send", message_id="S:1:2", trace_id="tr_x")
    line = log_path.read_text(encoding="utf-8").strip()
    assert re.match(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[WARNING\] \[send\] ", line)
    assert "138****5678" in line
    assert "message_id=S:1:2" in line
    assert "trace_id=tr_x" in line


def test_log_rotates_backups(tmp_path, monkeypatch):
    agent = load_autopilot()
    log_path = tmp_path / "run.log"
    monkeypatch.setattr(agent, "LOG_DIR", tmp_path)
    monkeypatch.setattr(agent, "LOG_PATH", log_path)
    monkeypatch.setattr(agent, "LOG_MAX_BYTES", 250)
    monkeypatch.setattr(agent, "LOG_BACKUP_COUNT", 2)

    for index in range(12):
        agent.log(f"第 {index} 条日志，占位内容占位内容", scope="test")
    assert log_path.exists()
    assert (tmp_path / "run.log.1").exists()
    assert (tmp_path / "run.log.2").exists()


def test_reply_store_adds_columns_and_counts_attempts(tmp_path):
    store = load_reply_store(tmp_path / "reply.db")
    assert store.record_incoming(
        {"id": "m1", "conv_id": "S:1", "conv_name": "张三", "text": "电话13812345678", "type": 0, "time": 1}
    )
    row = store.pending()[0]
    assert row["trace_id"].startswith("tr_")
    assert row["attempts"] == 0
    assert row["last_step"] == "created"

    store.mark_failed("m1", "S:1", "boom")
    store.mark_sent("m1", "S:1", "知识库", "回复", duration_ms=123)
    con = sqlite3.connect(store.DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        final = con.execute(
            "SELECT status,attempts,trace_id,last_step,duration_ms FROM reply_log WHERE message_id='m1'"
        ).fetchone()
    finally:
        con.close()
    assert final["status"] == "sent"
    assert final["attempts"] == 2
    assert final["last_step"] == "sent"
    assert final["duration_ms"] == 123

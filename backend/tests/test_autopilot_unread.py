"""Keep server-only unread recovery compatible with node-flow bookkeeping."""
from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    spec = importlib.util.spec_from_file_location("unread_reply_store", Path(module.__file__).with_name("reply_store.py"))
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply.db"
    records.init()
    monkeypatch.setattr(module, "rlog", records)
    return module


def message(mid, text="question", *, sender="customer", time=100):
    return {"id": str(mid), "text": text, "sender_id": sender, "time": time, "type": 2}


def store_with_unread(tmp_path, messages, *, cursor_ids=()):
    session = tmp_path / "session.db"
    data = tmp_path / "message.db"
    with sqlite3.connect(session) as con:
        con.execute("CREATE TABLE unread_conversation_table(conversation_id,begin_cursor,current_cursor,unread_count)")
        con.execute("INSERT INTO unread_conversation_table VALUES ('S:customer',100,200,10)")
    with sqlite3.connect(data) as con:
        con.execute("CREATE TABLE message_table(conversation_id,server_id,message_id)")
        con.executemany("INSERT INTO message_table VALUES ('S:customer',?,?)", [(100+i, str(mid)) for i, mid in enumerate(cursor_ids)])
    store = MagicMock()
    def connect(name):
        con = sqlite3.connect(session if name == "session.db" else data)
        con.row_factory = sqlite3.Row
        return con
    store._conn.side_effect = connect
    store.recent.return_value = []  # All unread messages fell outside the global recent window.
    store.sessions.return_value = [{"id": "S:customer", "name": "Customer"}]
    store.self_id.return_value = "self"
    store.messages.return_value = messages
    return store


@pytest.mark.parametrize("cursor_ids", [(), (1, 2, 3, 4)])
def test_unread_scan_selects_latest_text_without_replaying_own_or_system_events(agent, tmp_path, cursor_ids):
    store = store_with_unread(tmp_path, [message(1, "old"), message(2, "new"), message(3, ""), message(4, "own", sender="self")], cursor_ids=cursor_ids)
    assert agent.scan(store, {"target": "all"}) == 1
    row = agent.rlog.pending()[0]
    assert (row["message_id"], row["in_text"]) == ("2", "new")
    assert agent.scan(store, {"target": "all"}) == 0
    agent.core_send.send.assert_not_called()


def test_unread_scan_requires_known_self_and_respects_target(agent, tmp_path):
    store = store_with_unread(tmp_path, [message(1)])
    store.self_id.return_value = ""
    assert agent.scan_unread(store, {"target": "all"}) == 0
    store.self_id.return_value = "self"
    assert agent.scan_unread(store, {"target": "Someone else"}) == 0
    assert agent.rlog.pending() == []


@pytest.mark.parametrize("status,error,last_step", [
    ("sent", "", "sent"), ("unknown", "发到了别的会话", "unknown"),
    ("held", "Agent 暂停", "held"), ("skipped", "节点流程已处理", "skipped"),
    ("skipped", "人工接管中", "skipped"), ("void", "发到了别的会话", "failed"),
])
def test_unread_badge_never_requeues_delivered_uncertain_or_flow_consumed_messages(agent, status, error, last_step):
    item = {**message(1), "conv_id": "S:customer", "conv_name": "Customer"}
    agent.rlog.record_incoming(item)
    with agent.rlog._conn() as con:
        con.execute("UPDATE reply_log SET status=?,error=?,last_step=?", (status, error, last_step))
    assert agent.rlog.record_unread(item) is False
    assert agent.rlog.recent()[0]["status"] == status


@pytest.mark.parametrize("active_welcome", [False, True])
def test_recovery_of_historical_skip_does_not_interrupt_active_introduction(agent, active_welcome):
    item = {**message(1), "conv_id": "S:customer", "conv_name": "Customer"}
    agent.rlog.record_incoming(item)
    agent.rlog.mark_skipped("1", "S:customer", "历史消息（初始化跳过）")
    if active_welcome:
        with agent.rlog._conn() as con:
            con.execute("INSERT INTO welcome_deliveries(conv_id,trigger_id,state,updated_at) VALUES ('S:customer','1','ready',0)")
    assert agent.rlog.record_unread(item) is (not active_welcome)
    assert agent.rlog.record_unread(item) is False


def test_node_flow_disables_legacy_requeue_but_still_collects_new_inbound(agent, tmp_path, monkeypatch):
    store = store_with_unread(tmp_path, [message(1)])
    monkeypatch.setattr(agent, "_flow_state", MagicMock())
    assert agent.scan_unread(store, {"target": "all"}) == 1
    agent.rlog.mark_skipped("1", "S:customer", "同会话合并到最新一条")
    assert agent.scan_unread(store, {"target": "all"}) == 0
    store.messages.return_value = [message(2, "new question")]
    assert agent.scan_unread(store, {"target": "all"}) == 1
    assert agent.rlog.pending()[0]["message_id"] == "2"

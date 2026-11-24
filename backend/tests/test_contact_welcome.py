"""New WeChat contacts trigger existing greetings; no desktop APIs run here."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store, stub_text_readback


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    module.rlog = load_reply_store(tmp_path / "reply.db")
    module.log = MagicMock()
    module._brain = MagicMock()
    module._brain.reply_provider = "agent"
    module._brain.flow.return_value = {"nodes": [], "version": 0}
    module._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "Custom first", "delay_ms": 3500},
        {"seq": 2, "kind": "text", "content": "Custom second", "delay_ms": 2000},
    ]}
    module._flow_state = module.flow_state_mod.FlowState(tmp_path / "flow.db")
    module._last_reply_at = 0
    module._consecutive_send_failures = 0
    monkeypatch.setattr(module, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(module.remote_cfg, "takeover_sessions", lambda: set())
    monkeypatch.setattr(module.remote_cfg, "abandoned_sessions", lambda: set())
    monkeypatch.setattr(module.time, "sleep", MagicMock())
    stub_text_readback(module, monkeypatch)
    module.core_send.send.side_effect = lambda store, name, body, **kw: {
        "ok": True, "conversation_id": kw["expect_id"], "detail": "isolated readback"}
    return module


@pytest.fixture
def store(tmp_path):
    path = tmp_path / "user.db"
    with sqlite3.connect(path) as con:
        con.executescript("CREATE TABLE wechat_contactV1(wxid TEXT PRIMARY KEY,name TEXT);"
                          "CREATE TABLE user_table(id TEXT PRIMARY KEY,name TEXT);")
    obj = MagicMock()
    obj.data_dir = tmp_path
    obj.self_id.return_value = "own"
    obj.sessions.return_value = []
    obj.recent.return_value = []
    obj._conn.side_effect = lambda name: sqlite3.connect(f"file:{path}?mode=ro", uri=True) if name == "user.db" else None
    obj.contacts.side_effect = lambda: {row[0]: row[1] for row in read(path, "SELECT wxid,name FROM wechat_contactV1")}
    return obj


CFG = {"target": "all", "device_code": "pc", "cooldown": 0, "dry_run": False}


def read(path, sql, parameters=()):
    with sqlite3.connect(path) as con:
        return con.execute(sql, parameters).fetchall()


def add(store, contact_id, name="New customer", table="wechat_contactV1"):
    with sqlite3.connect(store.data_dir / "user.db") as con:
        con.execute(f"INSERT OR REPLACE INTO {table} VALUES (?,?)", (contact_id, name))


def baseline(agent, store):
    add(store, "old", "Old customer")
    assert agent.scan_added_contacts(store, CFG) == 0
    assert agent.rlog.pending() == []


def test_old_contacts_seed_only_and_new_contact_without_message_sends_saved_order(agent, store):
    baseline(agent, store)
    add(store, "new")
    assert agent.scan_added_contacts(store, CFG) == 1
    queued = agent.rlog.pending()
    assert len(queued) == 1 and queued[0]["in_text"] == "" and queued[0]["in_type"] == 1011
    agent.drain(store, CFG)
    assert [call.args[2] for call in agent.core_send.send.call_args_list] == ["Custom first", "Custom second"]
    assert agent.time.sleep.call_args_list[-2:] == [((3.5,),), ((2.0,),)]
    agent._brain.chat.assert_not_called()
    assert agent.scan_added_contacts(store, CFG) == 0


def test_new_contact_can_start_enabled_flow_without_customer_text(agent, store):
    baseline(agent, store)
    agent._brain.flow.return_value = {"position_id": 1, "version": 3, "status": "enabled", "entry_key": "intro",
        "nodes": [{"node_key": "intro", "node_type": "text", "parts": [{"kind": "text", "body": "Flow intro", "delay_ms": 0}],
                   "await_reply": True, "wait_minutes": 10}], "edges": []}
    add(store, "new")
    assert agent.scan_added_contacts(store, CFG) == 1
    agent.drain(store, CFG)
    assert agent.core_send.send.call_args.args[2] == "Flow intro"
    assert agent._flow_state.get("S:own_new")["phase"] == "awaiting"
    agent._brain.chat.assert_not_called()
    agent._brain.opening.assert_not_called()


def test_empty_successful_baseline_then_first_new_contact(agent, store):
    assert agent.scan_added_contacts(store, CFG) == 0
    add(store, "new")
    assert agent.scan_added_contacts(store, CFG) == 1


def test_reopening_ledger_preserves_baseline_and_exactly_one_pending_trigger(agent, store):
    baseline(agent, store)
    add(store, "new")
    assert agent.scan_added_contacts(store, CFG) == 1
    agent.rlog = load_reply_store(agent.rlog.DB_PATH)
    assert agent.scan_added_contacts(store, CFG) == 0
    assert len(agent.rlog.pending()) == 1


def test_rename_delete_and_reappearance_do_not_welcome_old_contact(agent, store):
    baseline(agent, store)
    add(store, "old", "Changed name")
    assert agent.scan_added_contacts(store, CFG) == 0
    with sqlite3.connect(store.data_dir / "user.db") as con:
        con.execute("DELETE FROM wechat_contactV1")
    assert agent.scan_added_contacts(store, CFG) == 0
    add(store, "old")
    assert agent.scan_added_contacts(store, CFG) == 0


def test_name_missing_at_addition_survives_restart_and_uses_original_event_time(agent, store, monkeypatch):
    baseline(agent, store)
    monkeypatch.setattr(agent.time, "time", lambda: 1234)
    add(store, "new", "")
    assert agent.scan_added_contacts(store, CFG) == 0
    agent.rlog = load_reply_store(agent.rlog.DB_PATH)
    monkeypatch.setattr(agent.time, "time", lambda: 5678)
    add(store, "new", "Named later")
    assert agent.scan_added_contacts(store, CFG) == 1
    assert agent.rlog.pending()[0]["msg_time"] == 1234


def test_internal_employee_and_self_never_become_welcome_candidates(agent, store):
    baseline(agent, store)
    add(store, "coworker", "Employee", table="user_table")
    add(store, "own", "Our account")
    assert agent.scan_added_contacts(store, CFG) == 0
    assert agent.rlog.pending() == []


@pytest.mark.parametrize("failure", ["missing", "schema", "exception"])
def test_unreadable_initial_snapshot_does_not_create_false_baseline(agent, store, failure):
    original = store._conn.side_effect
    if failure == "missing":
        store._conn.side_effect = lambda _: None
    elif failure == "schema":
        store._conn.side_effect = lambda _: sqlite3.connect(":memory:")
    else:
        store._conn.side_effect = sqlite3.OperationalError("unreadable")
    assert agent.scan_added_contacts(store, CFG) == 0
    assert read(agent.rlog.DB_PATH, "SELECT COUNT(*) FROM contact_baselines") == [(0,)]
    store._conn.side_effect = original
    add(store, "old")
    assert agent.scan_added_contacts(store, CFG) == 0
    add(store, "new")
    assert agent.scan_added_contacts(store, CFG) == 1


def test_failed_read_after_baseline_retries_new_contact_when_read_recovers(agent, store):
    baseline(agent, store)
    original = store._conn.side_effect
    add(store, "new")
    store._conn.side_effect = lambda _: None
    assert agent.scan_added_contacts(store, CFG) == 0
    store._conn.side_effect = original
    assert agent.scan_added_contacts(store, CFG) == 1


def test_missing_account_source_never_uses_leftover_decrypted_contact_cache(agent, store):
    add(store, "cached-old")
    cached = sqlite3.connect(":memory:")
    cached.executescript("CREATE TABLE wechat_contactV1(wxid,name);"
                         "INSERT INTO wechat_contactV1 VALUES ('cached-old','Old');")
    store.data_dir = store.data_dir / "missing-profile"
    store._conn.side_effect = lambda _: cached
    try:
        assert agent.scan_added_contacts(store, CFG) == 0
        store._conn.assert_not_called()
        assert read(agent.rlog.DB_PATH, "SELECT COUNT(*) FROM contact_baselines") == [(0,)]
    finally:
        cached.close()


def test_new_accounts_and_different_data_directories_have_separate_baselines(agent, store, tmp_path):
    baseline(agent, store)
    store.self_id.return_value = "other-account"
    add(store, "existing-on-other-account")
    assert agent.scan_added_contacts(store, CFG) == 0
    add(store, "new-on-other-account")
    assert agent.scan_added_contacts(store, CFG) == 1
    store.data_dir = tmp_path / "different-profile"
    store.data_dir.mkdir()
    with sqlite3.connect(store.data_dir / "user.db") as con:
        con.execute("CREATE TABLE wechat_contactV1(wxid,name)")
        con.execute("INSERT INTO wechat_contactV1 VALUES ('other-existing','Known')")
    path = store.data_dir / "user.db"
    store._conn.side_effect = lambda _: sqlite3.connect(path)
    assert agent.scan_added_contacts(store, CFG) == 0
    assert read(agent.rlog.DB_PATH, "SELECT COUNT(*) FROM contact_baselines") == [(3,)]


def test_real_reverse_order_session_id_is_reused(agent, store):
    baseline(agent, store)
    add(store, "new")
    store.sessions.return_value = [{"id": "S:new_own"}]
    assert agent.scan_added_contacts(store, CFG) == 1
    assert agent.rlog.pending()[0]["conv_id"] == "S:new_own"


@pytest.mark.parametrize("seen_id", ["S:own_new", "S:new_own"])
def test_previously_welcomed_contact_not_sent_again_with_other_member_order(agent, store, seen_id):
    baseline(agent, store)
    add(store, "new")
    agent._save_greeted({seen_id})
    assert agent.scan_added_contacts(store, CFG) == 0


def test_transaction_failure_does_not_consume_observation_or_leave_partial_trigger(agent, store):
    baseline(agent, store)
    add(store, "new")
    with sqlite3.connect(agent.rlog.DB_PATH) as con:
        con.execute("CREATE TRIGGER reject_contact_trigger BEFORE INSERT ON reply_log "
                    "BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        agent.scan_added_contacts(store, CFG)
    assert read(agent.rlog.DB_PATH, "SELECT welcome_pending FROM observed_contacts WHERE contact_id='new'") == [(1,)]
    assert agent.rlog.pending() == []
    with sqlite3.connect(agent.rlog.DB_PATH) as con:
        con.execute("DROP TRIGGER reject_contact_trigger")
    assert agent.scan_added_contacts(store, CFG) == 1
    assert agent.scan_added_contacts(store, CFG) == 0


def test_initial_baseline_transaction_failure_rolls_back_all_contacts(agent, store):
    add(store, "old")
    with sqlite3.connect(agent.rlog.DB_PATH) as con:
        con.execute("CREATE TRIGGER reject_baseline BEFORE INSERT ON contact_baselines "
                    "BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        agent.scan_added_contacts(store, CFG)
    assert read(agent.rlog.DB_PATH, "SELECT COUNT(*) FROM observed_contacts") == [(0,)]


def test_explicit_target_keeps_legacy_behavior_and_broadening_has_no_backlog(agent, store):
    add(store, "selected", "Selected")
    cfg = {**CFG, "target": "Selected"}
    assert agent.scan_added_contacts(store, cfg) == 1
    add(store, "outside", "Outside")
    assert agent.scan_added_contacts(store, cfg) == 0
    assert agent.scan_added_contacts(store, CFG) == 0
    assert len(agent.rlog.pending()) == 1


def test_explicit_reverse_session_target_keeps_unnamed_addition_pending(agent, store):
    baseline(agent, store)
    cfg = {**CFG, "target": "S:new_own"}
    store.sessions.return_value = [{"id": "S:new_own"}]
    add(store, "new", "")
    assert agent.scan_added_contacts(store, cfg) == 0
    add(store, "new", "Named later")
    assert agent.scan_added_contacts(store, cfg) == 1
    assert agent.rlog.pending()[0]["conv_id"] == "S:new_own"


def test_dify_does_not_queue_agent_opening_or_replay_contacts_after_switch(agent, store):
    baseline(agent, store)
    agent._brain.reply_provider = "dify"
    add(store, "dify-contact")
    assert agent.scan_added_contacts(store, CFG) == 0
    agent._brain.reply_provider = "agent"
    assert agent.scan_added_contacts(store, CFG) == 0
    assert agent.rlog.pending() == []


@pytest.mark.parametrize("provider", ["agent", "dify"])
def test_startup_waits_for_acknowledged_provider_before_resolving_new_contact(agent, store, provider):
    baseline(agent, store)
    agent._brain.reply_provider = ""
    add(store, "new-before-mode-sync")
    assert agent.scan_added_contacts(store, CFG) == 0
    assert agent.rlog.pending() == []
    agent._brain.reply_provider = provider
    assert agent.scan_added_contacts(store, CFG) == int(provider == "agent")
    agent._brain.reply_provider = "agent"
    assert agent.scan_added_contacts(store, CFG) == 0


@pytest.mark.parametrize("control", ["takeover", "abandoned", "offline", "window"])
def test_contact_welcome_obeys_existing_send_controls(agent, store, monkeypatch, control):
    baseline(agent, store)
    add(store, "new")
    assert agent.scan_added_contacts(store, CFG) == 1
    if control in ("takeover", "abandoned"):
        monkeypatch.setattr(agent.remote_cfg, control + "_sessions", lambda: {"S:own_new"})
    elif control == "window":
        agent.desktop_send_ready.return_value = (False, "not ready")
    agent.drain(store, CFG, wecom_state="offline" if control == "offline" else "online")
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize("name", ["user.db", "user.db-wal"])
def test_contact_database_only_change_updates_watched_signature(agent, tmp_path, name):
    previous = agent.wal_signature(tmp_path)
    (tmp_path / name).write_bytes(b"contact-only change")
    assert agent.wal_signature(tmp_path) != previous


def test_partial_database_refresh_is_not_accepted_and_can_be_retried(agent, store):
    store.refresh.side_effect = [{"decrypted": 3, "failed": 1}, {"decrypted": 4, "failed": 0}]
    with pytest.raises(RuntimeError, match="刷新未完成"):
        agent.refresh_store(store)
    agent.refresh_store(store)
    assert store.refresh.call_count == 2

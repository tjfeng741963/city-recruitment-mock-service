"""Regressions for replies skipped while WeCom's new session name is blank."""

from __future__ import annotations

import os
import sqlite3
import time
from contextlib import closing
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store


ACCOUNT = "self_account"
PEER = "customer_with_underscores"
CID = f"S:{ACCOUNT}_{PEER}"
LEGACY_SKIP = "会话没有可搜索的名字"
CFG = {"target": "all"}


class WeComSnapshot:
    def __init__(self, path):
        self.path = path
        self.data_dir = path
        self.account = ACCOUNT
        self.names = {PEER: "Asky"}
        self.recent_rows = []
        self.conversation_rows = []
        with closing(self._conn("user.db")) as conn, conn:
            conn.execute("CREATE TABLE external_user_relation_v3(user_id,real_remarks,remarks)")
        with closing(self._conn("session.db")) as conn, conn:
            conn.execute(
                "CREATE TABLE unread_conversation_table"
                "(conversation_id,begin_cursor,current_cursor,unread_count)"
            )
        with closing(self._conn("message.db")) as conn, conn:
            conn.execute(
                "CREATE TABLE message_table"
                "(conversation_id,sender_id,send_time,message_id INTEGER PRIMARY KEY,"
                "server_id,content_type,content)"
            )

    def _conn(self, name):
        conn = sqlite3.connect(self.path / name)
        conn.row_factory = sqlite3.Row
        return conn

    def self_id(self):
        return self.account

    def refresh(self):
        return {"failed": 0}

    def contacts(self):
        return dict(self.names)

    def sessions(self, with_names=True):
        return [{"id": CID, "name": ""}]

    def recent(self, limit=60):
        return self.recent_rows[-limit:]

    def messages(self, conv_id, limit=100):
        return [row for row in self.conversation_rows if row["conv_id"] == conv_id][-limit:]

    def add(self, row):
        with closing(self._conn("message.db")) as conn, conn:
            conn.execute(
                "INSERT INTO message_table VALUES (?,?,?,?,?,?,?)",
                (
                    row["conv_id"], row["sender_id"], row["time"], row["id"],
                    row["id"] + 100, row["type"], row["text"],
                ),
            )
        self.conversation_rows.append(row)


def message(mid, stamp, *, cid=CID, sender=PEER, kind=2, text="你已添加了我"):
    return {
        "id": mid,
        "conv_id": cid,
        "conv_name": cid,
        "sender_id": sender,
        "is_self": sender == ACCOUNT,
        "type": kind,
        "text": text,
        "time": stamp,
    }


def skip_for_missing_name(ledger, row):
    assert ledger.record_incoming(row)
    ledger.mark_skipped(row["id"], row["conv_id"], LEGACY_SKIP)


@pytest.fixture
def client(monkeypatch, tmp_path):
    agent = load_autopilot()
    ledger = load_reply_store(tmp_path / "reply.db")
    monkeypatch.setattr(agent, "rlog", ledger)
    return agent, WeComSnapshot(tmp_path), ledger


@pytest.mark.parametrize("reverse_members", [False, True])
def test_recent_scan_resolves_a_missing_direct_name_from_the_exact_peer(client, reverse_members):
    agent, store, ledger = client
    cid = f"S:{PEER}_{ACCOUNT}" if reverse_members else CID
    store.recent_rows = [message(1, int(time.time()), cid=cid)]

    assert agent.scan(store, {"target": "Asky"}) == 1
    assert [(row["conv_id"], row["conv_name"]) for row in ledger.pending()] == [(cid, "Asky")]


@pytest.mark.parametrize("problem", ["ambiguous-name", "unrelated-account", "group-chat"])
def test_recent_scan_does_not_infer_a_name_when_exact_owner_cannot_be_proved(client, problem):
    agent, store, ledger = client
    cid = CID
    if problem == "ambiguous-name":
        store.names["unrelated_contact"] = " asky "
    elif problem == "unrelated-account":
        store.account = "somebody_else"
    else:
        cid = f"R:{ACCOUNT}_{PEER}"
    store.recent_rows = [message(1, int(time.time()), cid=cid)]

    assert agent.scan(store, {"target": "Asky"}) == 0
    assert ledger.pending() == []


def test_unread_scan_resolves_name_when_session_row_has_no_name(client):
    agent, store, ledger = client
    stamp = int(time.time())
    store.add(message(1, stamp))
    store.add(message(2, stamp, kind=1011, text=""))
    with closing(store._conn("session.db")) as conn, conn:
        conn.execute("INSERT INTO unread_conversation_table VALUES (?,100,200,2)", (CID,))

    assert agent.scan_unread(store, {"target": "Asky"}) == 1
    assert [(row["message_id"], row["conv_name"]) for row in ledger.pending()] == [("1", "Asky")]


def test_recovery_requeues_only_latest_same_second_text_and_keeps_first_opening_eligible(client):
    agent, store, ledger = client
    stamp = int(time.time()) - 5
    old, latest = message(1, stamp), message(2, stamp)
    for row in (old, latest):
        store.add(row)
        skip_for_missing_name(ledger, row)
    store.add(message(3, stamp, kind=1011, text=""))

    agent._recover_missing_direct_names(store, CFG, ACCOUNT)
    assert [(row["message_id"], row["conv_name"], row["last_step"]) for row in ledger.pending()] == [
        ("2", "Asky", "name-recovery-queued"),
    ]
    agent._recover_missing_direct_names(store, CFG, ACCOUNT)
    assert [row["message_id"] for row in ledger.pending()] == ["2"]



@pytest.mark.parametrize("late_outbound", [False, True])
def test_drain_sends_configured_first_opening_once_after_safe_name_recovery(client, monkeypatch, tmp_path, late_outbound):
    agent, store, ledger = client
    stamp = int(time.time()) - 5
    inbound = message(1, stamp)
    store.add(inbound)
    skip_for_missing_name(ledger, inbound)
    store.add(message(2, stamp, kind=1011, text=""))

    brain = MagicMock(reply_provider="agent")
    brain.flow.return_value = {"nodes": []}
    brain.opening.return_value = {
        "ok": True,
        "items": [{"seq": 1, "kind": "text", "content": "岗位介绍", "delay_ms": 0}],
    }
    if late_outbound:
        def load_opening():
            store.add(message(3, stamp + 1, sender=ACCOUNT))
            return brain.opening.return_value
        brain.opening.side_effect = load_opening
    send = MagicMock(return_value=("sent", "confirmed", "3"))
    monkeypatch.setattr(agent, "_brain", brain)
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_send_text", send)
    monkeypatch.setattr(agent, "_flow_state", agent.flow_state_mod.FlowState(tmp_path / "flow.db"))
    monkeypatch.setattr(agent, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", set)
    monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", set)
    cfg = {**CFG, "cooldown": 0}

    agent.drain(store, cfg)
    agent.drain(store, cfg)

    if late_outbound:
        send.assert_not_called()
        assert ledger.recent()[0]["status"] == "held"
        return

    assert [(call.args[1:], call.kwargs["route"]) for call in send.call_args_list] == [
        (("Asky", CID, "岗位介绍"), "opening"),
    ]
    brain.log_receipt.assert_called_once_with(CID, 1, "text", "sent")
    assert CID in agent._load_greeted()
    assert ledger.recent()[0]["error"] == "开场已播完，等客户下一条"
    assert ledger.pending() == []
    brain.chat.assert_not_called()


@pytest.mark.parametrize(
    "guard",
    ["outbound", "newer-inbound", "ambiguous-name", "stale", "wrong-account", "attempted", "outside-scope"],
)
def test_recovery_leaves_unsafe_or_out_of_scope_skips_untouched(client, guard):
    agent, store, ledger = client
    stamp = int(time.time()) - (7200 if guard == "stale" else 5)
    row = message(1, stamp)
    store.add(row)
    skip_for_missing_name(ledger, row)
    cfg = dict(CFG)
    if guard == "outbound":
        store.add(message(2, stamp, sender=ACCOUNT))
    elif guard == "newer-inbound":
        store.add(message(2, stamp))
    elif guard == "ambiguous-name":
        store.names["unrelated_contact"] = "Asky"
    elif guard == "wrong-account":
        store.account = "somebody_else"
    elif guard == "attempted":
        with closing(ledger._conn()) as conn, conn:
            conn.execute("UPDATE reply_log SET attempts=1")
    elif guard == "outside-scope":
        cfg["target"] = "different contact"

    agent._recover_missing_direct_names(store, cfg, store.account)
    assert ledger.pending() == []
    assert ledger.recent()[0]["error"] == LEGACY_SKIP



@pytest.mark.parametrize("changed", [None, "newer-inbound", "already-replied"])
@pytest.mark.parametrize("title", ["小e（工作时间09~18点）", "松下11/30温志添"])
def test_recent_title_hold_automatically_requeues_once_with_fresh_history(client, monkeypatch, changed, title):
    agent, store, ledger = client
    stamp = int(time.time()) - 5
    store.names[PEER] = title
    row = {**message(1, stamp), "conv_name": store.names[PEER]}
    store.add(row)
    ledger.record_incoming(row)
    ledger.mark_held(1, CID, agent._RECIPIENT_BLOCKED, "Agent")
    if changed == "newer-inbound":
        store.add(message(2, stamp + 1))
    if changed == "already-replied":
        store.add(message(2, stamp + 1, sender=ACCOUNT))

    agent._recover_missing_direct_names(store, CFG, ACCOUNT)
    if changed:
        assert ledger.pending() == []
        return
    assert [(r["message_id"], r["last_step"]) for r in ledger.pending()] == [("1", "title-recovery-queued")]
    ledger.mark_held(1, CID, agent._RECIPIENT_BLOCKED, "Agent")
    agent._recover_missing_direct_names(store, CFG, ACCOUNT)
    assert ledger.pending() == []

def test_resident_drains_ocr_title_hold_as_normal_reply_once(client, monkeypatch, tmp_path):
    agent, store, ledger = client
    stamp = int(time.time()) - 5
    name = store.names[PEER] = "小e（工作时间09~18点）"
    inbound = {**message(1, stamp, text="岗位在哪里？"), "conv_name": name}
    store.add(inbound)
    assert ledger.record_incoming(inbound)
    ledger.mark_held(1, CID, agent._RECIPIENT_BLOCKED, "Agent")
    brain = MagicMock(reply_provider="agent")
    brain.flow.return_value = {"nodes": []}
    brain.chat.return_value = {"ok": True, "reply": "请看岗位地址。", "trace_id": "reply-trace"}
    send = MagicMock(return_value=("sent", "confirmed", "2"))
    monkeypatch.setattr(agent, "_brain", brain)
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_send_text", send)
    monkeypatch.setattr(agent, "_flow_state", agent.flow_state_mod.FlowState(tmp_path / "flow.db"))
    monkeypatch.setattr(agent, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", set)
    monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", set)
    cfg = {**CFG, "cooldown": 0}

    assert agent.drain(store, cfg)["sent"] == 1
    assert agent.drain(store, cfg)["sent"] == 0
    brain.opening.assert_not_called()
    assert brain.chat.call_args.args == ("岗位在哪里？", CID)
    assert (send.call_args.args[1:], send.call_args.kwargs["route"]) == (
        (name, CID, "请看岗位地址。"), "auto",
    )
    send.assert_called_once()
    assert ledger.recent()[0]["last_step"] == "sent-confirmed"
    assert ledger.recent_reply_recoveries()[0]["outcome"] == "sent"

@pytest.mark.parametrize(("state", "change"), [
    ("fresh", None), ("fresh", "collision"),
    ("legacy-skip", None), ("legacy-skip", "collision"), ("legacy-skip", "late-outbound"),
    ("legacy-opening-hold", None), ("legacy-opening-hold", "collision"), ("legacy-opening-hold", "late-outbound"),
])
def test_resident_uses_verified_remark_for_existing_conversation(client, monkeypatch, tmp_path, state, change):
    agent, store, ledger = client
    stamp = int(time.time()) - 5
    remark = "CR0123456789abcdef"
    store.names = {PEER: "ㅤ", "another_peer": "ㅤ"}
    with closing(store._conn("user.db")) as conn, conn:
        conn.execute("INSERT INTO external_user_relation_v3 VALUES (?,?,?)", (PEER, remark, ""))
        if change == "collision":
            conn.execute("INSERT INTO external_user_relation_v3 VALUES (?,?,?)", ("another_peer", remark, ""))
    store.add(message(1, stamp - 60, sender=ACCOUNT, text="此前已发过岗位介绍"))
    inbound = {**message(2, stamp, text="现在23了吗"), "conv_name": remark if state == "legacy-opening-hold" else CID}
    store.add(inbound)
    assert ledger.record_incoming(inbound)
    if state == "legacy-skip":
        ledger.mark_skipped(2, CID, LEGACY_SKIP)
    elif state == "legacy-opening-hold":
        ledger.mark_held(2, CID, agent._RECIPIENT_BLOCKED, "开场")

    brain = MagicMock(reply_provider="agent")
    brain.flow.return_value = {"nodes": []}
    brain.chat.return_value = {"ok": True, "reply": "具体工价按岗位确认。", "trace_id": "reply-trace"}
    brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "岗位介绍", "delay_ms": 0},
    ]}
    if change == "late-outbound":
        def reply_after_human(*args, **kwargs):
            store.add(message(3, stamp + 1, sender=ACCOUNT))
            return brain.chat.return_value
        brain.chat.side_effect = reply_after_human
    send = MagicMock(return_value=("sent", "confirmed", "3"))
    monkeypatch.setattr(agent, "_brain", brain)
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_send_text", send)
    monkeypatch.setattr(agent, "_flow_state", agent.flow_state_mod.FlowState(tmp_path / "flow.db"))
    monkeypatch.setattr(agent, "GREET_STATE", tmp_path / ".greeted.json")
    if state == "fresh":
        agent._save_greeted({CID})
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", set)
    monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", set)
    cfg = {**CFG, "cooldown": 0}

    result = agent.drain(store, cfg)
    brain.opening.assert_not_called()
    if change:
        assert result["sent"] == 0
        send.assert_not_called()
        return
    assert result["sent"] == 1
    assert agent.drain(store, cfg)["sent"] == 0
    assert brain.chat.call_args.args == ("现在23了吗", CID)
    assert (send.call_args.args[1:], send.call_args.kwargs["route"]) == (
        (remark, CID, "具体工价按岗位确认。"), "auto",
    )
    send.assert_called_once()
    assert ledger.recent()[0]["last_step"] == "sent-confirmed"

def test_new_contact_recovers_first_opening_once_after_unique_remark(client, monkeypatch, tmp_path):
    agent, store, ledger = client
    store.names = {PEER: "ㅤ", "another_peer": "ㅤ"}
    inbound = message(1, int(time.time()) - 5, text="你好")
    store.add(inbound)
    assert ledger.record_incoming(inbound)

    brain = MagicMock(reply_provider="agent")
    brain.flow.return_value = {"nodes": []}
    brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "岗位介绍", "delay_ms": 0},
    ]}
    send = MagicMock(return_value=("sent", "confirmed", "2"))
    monkeypatch.setattr(agent, "_brain", brain)
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_send_text", send)
    monkeypatch.setattr(agent, "_flow_state", agent.flow_state_mod.FlowState(tmp_path / "flow.db"))
    monkeypatch.setattr(agent, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", set)
    monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", set)
    cfg = {**CFG, "cooldown": 0}

    assert agent.drain(store, cfg)["blocked"] == 1
    assert ledger.recent()[0]["last_step"] == "recipient-blocked"
    send.assert_not_called()
    with closing(store._conn("user.db")) as conn, conn:
        conn.execute("INSERT INTO external_user_relation_v3 VALUES (?,?,'')", (PEER, "CR-new-contact"))
    agent.drain(store, cfg)
    agent.drain(store, cfg)

    send.assert_called_once()
    assert send.call_args.args[1:] == ("CR-new-contact", CID, "岗位介绍")
    assert send.call_args.kwargs["route"] == "opening"
    brain.chat.assert_not_called()
    assert CID in agent._load_greeted()

@pytest.mark.parametrize("changed", [None, "late-outbound", "before-enter", "newer-inbound", "newer-attachment", "name-changed", "db-moved", "parser-error", "location-card", "invalid-card"])
def test_reviewed_title_recovery_reaches_resident_send_only_for_same_unanswered_turn(client, monkeypatch, tmp_path, changed):
    agent, store, ledger = client
    stamp = int(time.time()) - 4 * 3600
    name = store.names[PEER]
    inbound = {**message(1, stamp, text="\u5c97\u4f4d\u5728\u54ea\u91cc"), "conv_name": name}
    store.add(inbound)
    assert ledger.record_incoming(inbound)
    ledger.mark_held(1, CID, agent._RECIPIENT_BLOCKED, "Agent")
    assert ledger.queue_reply_recovery(CID, "1", reason="verified", operator="ops", title_recovery=True) == "queued"
    brain = MagicMock(reply_provider="agent")
    brain.flow.return_value = {"nodes": []}
    brain.chat.return_value = {"ok": True, "reply": "Office address", "trace_id": "reply-trace"}
    send = MagicMock(return_value=("sent", "confirmed", "3"))
    monkeypatch.setattr(agent, "_brain", brain)
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_send_text", send)
    monkeypatch.setattr(agent.core_send, "split_media_marks", lambda text: (text, []))
    monkeypatch.setattr(agent, "find_data_dir", lambda: store.data_dir)
    monkeypatch.setattr(agent, "_flow_state", agent.flow_state_mod.FlowState(tmp_path / "flow.db"))
    monkeypatch.setattr(agent, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", set)
    monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", set)
    if changed == "late-outbound":
        def response_after_outbound(*args, **kwargs):
            store.add(message(2, stamp + 1, sender=ACCOUNT))
            return brain.chat.return_value
        brain.chat.side_effect = response_after_outbound
    if changed == "before-enter":
        def send_after_outbound(*args, authorize, **kwargs):
            store.add(message(2, stamp + 1, sender=ACCOUNT))
            assert not authorize()
            return "blocked", agent._RECIPIENT_BLOCKED, ""
        send.side_effect = send_after_outbound
    if changed == "newer-inbound":
        store.add(message(2, stamp + 1))
    if changed == "newer-attachment":
        store.add(message(2, stamp + 1, kind=101, text="image payload"))
    if changed == "name-changed":
        store.names[PEER] = "Changed title"
    if changed == "db-moved":
        def refresh_during_update():
            db = store.data_dir / "message.db"
            old_stamp = db.stat().st_mtime_ns
            os.utime(db, ns=(old_stamp, old_stamp + 1_000_000_000))
            return {"failed": 0}
        monkeypatch.setattr(store, "refresh", refresh_during_update)
    if changed == "parser-error":
        monkeypatch.setattr(agent.core_send, "split_media_marks", MagicMock(side_effect=ValueError))
    if changed in ("location-card", "invalid-card"):
        brain.chat.return_value["location_card"] = {
            "lng": 113.3, "lat": 23.1 if changed == "location-card" else 123.1,
            "name": "Interviews", "address": "100 Main St",
        }
    native_card = MagicMock()
    monkeypatch.setattr(agent, "_send_location_to_recipient", native_card)

    result = agent.drain(store, {**CFG, "cooldown": 0})
    brain.opening.assert_not_called()
    native_card.assert_not_called()
    if changed and changed != "location-card":
        assert send.call_count == (1 if changed == "before-enter" else 0)
        assert result["blocked"] == 1
        assert ledger.recent()[0]["status"] == "held"
    else:
        assert result["sent"] == 1
        body = "Office address"
        if changed == "location-card":
            body += "\nInterviews：100 Main St\n导航：https://uri.amap.com/marker?position=113.3,23.1"
        assert send.call_args.args[1:] == (name, CID, body)
        assert send.call_args.kwargs["authorize"]()
        assert ledger.recent()[0]["last_step"] == "sent-confirmed"
        assert agent.drain(store, {**CFG, "cooldown": 0})["sent"] == 0
        send.assert_called_once()

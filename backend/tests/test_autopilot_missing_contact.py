"""Regressions for replies skipped while WeCom's new session name is blank."""

from __future__ import annotations

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
        self.account = ACCOUNT
        self.names = {PEER: "Asky"}
        self.recent_rows = []
        self.conversation_rows = []
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
def test_recent_title_hold_automatically_requeues_once_with_fresh_history(client, monkeypatch, changed):
    agent, store, ledger = client
    stamp = int(time.time()) - 5
    store.names[PEER] = "小e（工作时间09~18点）"
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

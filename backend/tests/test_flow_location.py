"""Location flow delivery: real SQLite evidence, no desktop actions or network."""
from __future__ import annotations

import json
import sqlite3
import struct
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store

CARD = {"name": "南门面试点", "address": "兴业路东门", "lng": 113.39114, "lat": 23.117692}
CID = "S:me_customer"
CFG = {"cooldown": 0, "device_code": "pc", "dry_run": False}


def content(card=None):
    card = card or CARD
    def field(tag, value):
        raw = value.encode("utf-8")
        n, prefix = len(raw), bytearray()
        while n >= 128:
            prefix.append((n & 127) | 128)
            n >>= 7
        prefix.append(n)
        return bytes([tag]) + prefix + raw
    return (b"\x09" + struct.pack("<d", card["lng"]) + b"\x11" + struct.pack("<d", card["lat"])
            + field(26, card["address"]) + field(34, card["name"]) + b"\x29" + bytes(8) + b"\x32\x00")


@pytest.fixture
def env(tmp_path, monkeypatch):
    agent = load_autopilot()
    monkeypatch.setattr(agent.location_card, "send_card", MagicMock(return_value=(True, "stub")))
    monkeypatch.setattr(agent, "refresh_store", MagicMock())
    monkeypatch.setattr(agent, "log", MagicMock())
    agent._brain = None
    agent._last_reply_at = agent._consecutive_send_failures = 0
    agent._flow_state = agent.flow_state_mod.FlowState(tmp_path / "flow.db")
    monkeypatch.setattr(agent, "rlog", load_reply_store(tmp_path / "reply.db"))
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", lambda: set())
    monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", lambda: set())
    monkeypatch.setattr(agent.time, "sleep", lambda _: None)
    path = tmp_path / "messages.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE message_table(message_id TEXT,conversation_id TEXT,sender_id TEXT,send_time INTEGER,content_type INTEGER,content BLOB)")
    store = MagicMock()
    store.self_id.return_value = "me"
    store.contacts.return_value = {"customer": "Customer"}
    store._conn.side_effect = lambda name: sqlite3.connect(path) if name == "message.db" else None
    def insert(mid="new", cid=CID, sender="me", kind=6, blob=None):
        with sqlite3.connect(path) as db:
            db.execute("INSERT INTO message_table VALUES (?,?,?,?,?,?)", (mid, cid, sender, 100, kind, content() if blob is None else blob))
    return agent, store, insert


def send(env, card=None):
    agent, store, _ = env
    return agent._send_flow_location(store, CID, CARD if card is None else card, lambda _: None, account_id="me")[0]


def test_unique_new_location_requires_matching_account_conversation_and_content(env):
    agent, _, insert = env
    insert("old")
    agent.location_card.send_card.side_effect = lambda *a, **kw: (insert(), (True, "stub"))[1]
    assert send(env) == "sent"
    agent.location_card.send_card.assert_called_once_with(CARD["lng"], CARD["lat"], CARD["address"], CARD["name"], log=agent.location_card.send_card.call_args.kwargs["log"])


@pytest.mark.parametrize("variant", ["no_row", "old_only", "wrong_chat", "incoming", "wrong_account", "wrong_type", "wrong_coordinates", "wrong_name", "wrong_address", "malformed", "duplicate", "account_switch"])
def test_unconfirmed_or_ambiguous_evidence_is_never_sent(env, variant):
    agent, store, insert = env
    insert("old")
    def paste(*args, **kwargs):
        if variant in ("no_row", "old_only"):
            return True, "stub"
        options = {"wrong_chat": {"cid": "S:me_other"}, "incoming": {"sender": "customer"},
                   "wrong_account": {"sender": "other"}, "wrong_type": {"kind": 2},
                   "wrong_coordinates": {"blob": content({**CARD, "lng": 114})},
                   "wrong_name": {"blob": content({**CARD, "name": "另一个点"})},
                   "wrong_address": {"blob": content({**CARD, "address": "别的地址"})},
                   "malformed": {"blob": b"\x09"}}
        insert(**options.get(variant, {}))
        if variant == "duplicate":
            insert("another")
        if variant == "account_switch":
            store.self_id.return_value = "other"
        return True, "stub"
    agent.location_card.send_card.side_effect = paste
    assert send(env) == "unknown"
    assert agent.location_card.send_card.call_count == 1


@pytest.mark.parametrize("failure", ["sender_false", "sender_exception", "refresh_exception"])
def test_uncertain_sender_never_retries(env, failure):
    agent, _, _ = env
    if failure == "sender_false":
        agent.location_card.send_card.return_value = False, "failed"
    elif failure == "sender_exception":
        agent.location_card.send_card.side_effect = RuntimeError("crash")
    else:
        agent.refresh_store.side_effect = RuntimeError("refresh")
    assert send(env) == "unknown"
    agent.location_card.send_card.assert_called_once()


@pytest.mark.parametrize("card", [{}, {**CARD, "lng": True}, {**CARD, "lat": 91}, {**CARD, "lng": float("nan")}, {**CARD, "address": ""}])
def test_invalid_card_never_invokes_sender(env, card):
    assert send(env, card) == "failed"
    env[0].location_card.send_card.assert_not_called()


@pytest.mark.parametrize("failure", ["database", "account", "window"])
def test_unavailable_readback_or_desktop_never_invokes_sender(env, failure):
    agent, store, _ = env
    if failure == "database":
        store._conn.side_effect = RuntimeError("unreadable")
    elif failure == "account":
        store.self_id.return_value = "other"
    else:
        agent.desktop_send_ready.return_value = False, "offline"
    assert send(env) in ("failed", "blocked")
    agent.location_card.send_card.assert_not_called()


def make_flow():
    return {"position_id": 1, "version": 1, "entry_key": "intro", "status": "enabled", "edges": [], "nodes": [
        {"node_key": "intro", "parts": [
            {"kind": "text", "body": "先看地址", "delay_ms": 200},
            {"kind": "favorite_location", "interview_point": CARD["name"], "location": dict(CARD), "delay_before_ms": 500, "delay_ms": 300},
            {"kind": "text", "body": "请按位置前往", "delay_ms": 0}]}]}


def run(env, flow):
    agent, store, _ = env
    agent._flow_state.upsert(CID, node_key="intro", phase="running")
    return agent._run_flow(store, CFG, CID, "Customer", flow, node_key="intro")


def stub_text(agent, monkeypatch, events):
    def text(store, name, cid, body, **kw):
        events.append(body)
        return "sent", "verified", "id"
    monkeypatch.setattr(agent, "_send_text", text)


def test_text_card_text_order_delays_and_durable_evidence(env, monkeypatch):
    agent, _, insert = env
    events = []
    stub_text(agent, monkeypatch, events)
    monkeypatch.setattr(agent.time, "sleep", lambda seconds: events.append(seconds))
    agent.location_card.send_card.side_effect = lambda *a, **kw: (events.append("card"), insert(), (True, "stub"))[-1]
    assert run(env, make_flow()) == "expired"
    assert events == ["先看地址", .2, .5, "card", .3, "请按位置前往", 0]
    rows = agent._flow_state.outbox(CID)
    assert [row["status"] for row in rows] == ["sent"] * 3
    assert json.loads(rows[1]["body"]) == CARD


def test_unknown_card_stops_following_text_and_restart_does_not_replay(env, monkeypatch):
    agent, _, _ = env
    events = []
    stub_text(agent, monkeypatch, events)
    assert run(env, make_flow()) == "held"
    assert events == ["先看地址"]
    assert [row["status"] for row in agent._flow_state.outbox(CID)] == ["sent", "unknown"]
    agent._flow_state = agent.flow_state_mod.FlowState(agent._flow_state.path)
    assert run(env, make_flow()) == "held"
    agent.location_card.send_card.assert_called_once()
    assert events == ["先看地址"]


def test_location_without_verified_text_in_this_run_never_pastes(env):
    flow = make_flow()
    flow["nodes"][0]["parts"].pop(0)
    assert run(env, flow) == "held"
    env[0].location_card.send_card.assert_not_called()


@pytest.mark.parametrize("change", ["takeover", "provider", "account"])
def test_change_during_location_delay_stops_card_and_following_text(env, monkeypatch, change):
    agent, store, _ = env
    events = []
    stub_text(agent, monkeypatch, events)
    def sleep(seconds):
        if seconds != .5:
            return
        if change == "takeover":
            monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", lambda: {CID})
        elif change == "provider":
            agent._brain = MagicMock(reply_provider="dify", reply_mode_generation="changed")
        else:
            store.self_id.return_value = "other"
    monkeypatch.setattr(agent.time, "sleep", sleep)
    assert run(env, make_flow()) == "held"
    assert events == ["先看地址"]
    agent.location_card.send_card.assert_not_called()


def test_location_decoder_supports_long_utf8_and_rejects_truncation(env):
    agent = env[0]
    card = {**CARD, "address": "长地址" * 100}
    blob = content(card)
    assert agent._location_matches(blob, card)
    for end in range(18 + 3 * len(card["address"]) + 2):
        assert not agent._location_matches(blob[:end], card)


def test_upgrade_holds_old_conversation_snapshot_without_replacing_it(env):
    agent = env[0]
    agent._brain = MagicMock(location_steps=1)
    old = make_flow()
    old["nodes"][0]["parts"].pop(1)  # Pre-upgrade server silently removed it.
    row = {"snapshot_json": json.dumps(old)}
    current = {**make_flow(), "location_steps": 1}
    assert agent._flow_for_row(row, current) is None
    assert json.loads(row["snapshot_json"]) == old
    assert agent._flow_for_row({"snapshot_json": json.dumps(current)}, None) == current

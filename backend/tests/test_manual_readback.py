"""Real frozen SQLite reader; desktop sender remains isolated."""

from __future__ import annotations

from contextlib import closing
import importlib.util
import sqlite3
import sys
import types
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import AGENT_DIR, load_autopilot, load_reply_store
from tests.test_bridge_commands import COMMAND, FakeBridge, _cfg


@pytest.fixture
def database(tmp_path, monkeypatch):
    package = types.ModuleType("readback_core")
    package.__path__ = [str(AGENT_DIR / "wecom_io_core")]
    vendor = types.ModuleType("readback_core.vendor")
    vendor.__path__ = []
    extractor = types.ModuleType("readback_core.vendor.key_extract")
    extractor.extract_key = MagicMock()
    win = MagicMock()
    for name, module in {
        "readback_core": package,
        "readback_core.crypto": types.ModuleType("readback_core.crypto"),
        "readback_core.vendor": vendor,
        "readback_core.vendor.key_extract": extractor,
        "readback_core.win": win,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    modules = {}
    for name in ("store", "send"):
        spec = importlib.util.spec_from_file_location(f"readback_core.{name}", AGENT_DIR / "wecom_io_core" / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)
        modules[name] = module
    monkeypatch.setattr(modules["store"], "CACHE", tmp_path)
    path = tmp_path / "message.db"
    with closing(sqlite3.connect(path)) as con, con:
        con.execute("CREATE TABLE message_table (message_id INTEGER PRIMARY KEY, conversation_id TEXT, sender_id TEXT, send_time INTEGER, content_type INTEGER, content TEXT)")

    def insert(mid, *, cid=COMMAND["contact_id"], sender="owner", text=COMMAND["content"]):
        with closing(sqlite3.connect(path)) as con, con:
            con.execute("INSERT INTO message_table VALUES (?,?,?,?,2,?)", (mid, cid, sender, mid, text))

    store = modules["store"].Store.__new__(modules["store"].Store)
    store.data_dir = tmp_path / "owner" / "Data"
    store.sessions = MagicMock(return_value=[{"id": COMMAND["contact_id"], "name": COMMAND["nickname"]}])
    store.refresh = MagicMock()
    yield types.SimpleNamespace(store=store, core=modules["send"], insert=insert, path=path)
    store.refresh.assert_not_called()
    assert win.mock_calls == []
    extractor.extract_key.assert_not_called()


def test_rowid_alias_failure_recovers_using_real_store_message_id(database, tmp_path):
    database.insert(101)
    with closing(sqlite3.connect(database.path)) as con:
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT rowid FROM message_table").fetchone()
        assert row.keys() == ["message_id"]
        with pytest.raises(IndexError):
            _ = row["rowid"]

    agent = load_autopilot()
    agent.rlog = load_reply_store(tmp_path / "reply_log.db")

    def sender(*args, **kwargs):
        database.insert(102)
        # 回读改用位置下标后，必须能读到刚插入的那条，而不是抛 IndexError。
        assert database.core._find_new_sent(database.store, COMMAND["content"], {101}) == COMMAND["contact_id"]
        return {"ok": True, "conversation_id": "", "detail": "sent but legacy readback failed: IndexError"}

    agent.core_send.send.side_effect = sender
    bridge = FakeBridge(dict(COMMAND))
    assert agent.pump_commands(database.store, _cfg(), bridge=bridge) == {"claimed": 1, "sent": 1, "failed": 0}
    assert bridge.receipts[-1][2:] == ("succeeded", f"{COMMAND['contact_id']}:102")
    agent.core_send.send.assert_called_once()


@pytest.mark.parametrize("evidence,returned_cid,success", [
    ("unique", COMMAND["contact_id"], True),
    ("unique", "S:wrong", False),
    ("old-only", COMMAND["contact_id"], False),
    ("multiple", COMMAND["contact_id"], False),
    ("inbound", "", False),
    ("other-conversation", "", False),
    ("different-text", "", False),
    ("normalized", "", True),
])
def test_only_unique_new_outbound_in_expected_conversation_succeeds(database, tmp_path, evidence, returned_cid, success):
    database.insert(101)
    agent = load_autopilot()
    agent.rlog = load_reply_store(tmp_path / "reply_log.db")
    command = dict(COMMAND)
    if evidence == "normalized":
        command["content"] = "  first\r\nsecond\rthird  "

    def sender(*args, **kwargs):
        if evidence in ("unique", "multiple"):
            database.insert(102)
            if evidence == "multiple":
                database.insert(103)
        elif evidence == "inbound":
            database.insert(102, sender="customer")
        elif evidence == "other-conversation":
            database.insert(102, cid="S:other")
        elif evidence == "different-text":
            database.insert(102, text="other body")
        elif evidence == "normalized":
            database.insert(102, text="first\nsecond\nthird")
        return {"ok": True, "conversation_id": returned_cid, "detail": "ok"}

    agent.core_send.send.side_effect = sender
    bridge = FakeBridge(command)
    assert agent.pump_commands(database.store, _cfg(), bridge=bridge) == {"claimed": 1, "sent": int(success), "failed": int(not success)}
    assert bridge.receipts[-1][2:] == (("succeeded", f"{COMMAND['contact_id']}:102") if success else ("unknown", ""))
    assert agent._last_reply_at > 0
    assert bool(agent._last_error) is not success
    agent.core_send.send.assert_called_once()


@pytest.mark.parametrize("unreadable", ["before", "after", "self-id"])
def test_unreadable_snapshot_cannot_report_success(database, tmp_path, unreadable, monkeypatch):
    agent = load_autopilot()
    agent.rlog = load_reply_store(tmp_path / "reply_log.db")
    reader = database.store._conn
    if unreadable == "before":
        monkeypatch.setattr(database.store, "_conn", lambda name: None)
    elif unreadable == "self-id":
        monkeypatch.setattr(database.store, "self_id", lambda: "")

    def sender(*args, **kwargs):
        database.insert(102)
        if unreadable == "before":
            monkeypatch.setattr(database.store, "_conn", reader)
        elif unreadable == "after":
            monkeypatch.setattr(database.store, "_conn", MagicMock(side_effect=sqlite3.OperationalError("unreadable")))
        return {"ok": True, "conversation_id": COMMAND["contact_id"], "detail": "ok"}

    agent.core_send.send.side_effect = sender
    bridge = FakeBridge(dict(COMMAND))
    assert agent.pump_commands(database.store, _cfg(), bridge=bridge)["sent"] == 0
    assert bridge.receipts[-1][2:] == ("unknown", "")


@pytest.mark.parametrize("confirmed", [False, True])
def test_manual_attachment_waits_for_target_message_readback(database, tmp_path, confirmed):
    agent = load_autopilot()
    agent.rlog = load_reply_store(tmp_path / "reply_log.db")
    agent.core_send.split_media_marks.return_value = (COMMAND["content"], [("image", "sample.png")])

    def paste_media(*args, **kwargs):
        # An early paste must not be able to manufacture the text evidence.
        if not confirmed:
            database.insert(102)
        return True, "pressed Enter"

    def send(*args, **kwargs):
        if confirmed:
            database.insert(102)
        return {"ok": True, "conversation_id": "", "detail": "no core readback"}

    agent.core_send.send.side_effect = send
    agent.core_send.paste_media.side_effect = paste_media
    bridge = FakeBridge(dict(COMMAND))
    assert agent.pump_commands(database.store, _cfg(), bridge=bridge)["sent"] == int(confirmed)
    assert agent.core_send.paste_media.call_count == int(confirmed)


@pytest.mark.parametrize("route", ["auto", "opening", "node"])
@pytest.mark.parametrize("new_rows", [0, 1, 2])
def test_automatic_sends_also_require_unique_new_target_row(database, route, new_rows):
    database.insert(101)
    agent = load_autopilot()

    def send(*args, **kwargs):
        for offset in range(new_rows):
            database.insert(102 + offset)
        return {"ok": True, "conversation_id": COMMAND["contact_id"], "detail": "core matched"}

    agent.core_send.send.side_effect = send
    status, _, message_id = agent._send_text(
        database.store, COMMAND["nickname"], COMMAND["contact_id"], COMMAND["content"],
        route=route, log_fn=MagicMock(),
    )

    assert status == ("sent" if new_rows == 1 else "unknown")
    assert bool(message_id) is (new_rows == 1)

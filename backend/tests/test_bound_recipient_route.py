import sqlite3
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


@pytest.fixture
def recipient(tmp_path):
    agent = load_autopilot()
    path = tmp_path / "user.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE external_user_relation_v3(user_id, real_remarks, remarks)")
        db.executemany("INSERT INTO external_user_relation_v3 VALUES (?,?,?)", [
            ("one", "RCP8K6AXH", ""), ("two", "", ""),
        ])
    store = MagicMock()
    store.self_id.return_value = "self"
    store._conn.side_effect = lambda _: sqlite3.connect(path)
    store.contacts.return_value = {"one": "Same", "two": "Same"}
    return agent, store, path


@pytest.mark.parametrize("status", ["awaiting", "verified"])
def test_contact_id_owns_the_only_searchable_remark_even_after_rename(recipient, status):
    agent, store, _ = recipient
    store.contacts.return_value["one"] = "Renamed contact"
    binding = {"status": status, "remark": "RCP8K6AXH"}
    assert agent._resolve_recipient(store, "S:self_one", binding) == (
        "RCP8K6AXH", "verified",
    )
    assert agent._resolve_recipient(store, "S:another_one", binding) == ("", "")


def test_same_name_has_no_search_route_until_bound(recipient):
    agent, store, path = recipient
    with sqlite3.connect(path) as db:
        db.execute("UPDATE external_user_relation_v3 SET real_remarks=''")
    assert agent._resolve_recipient(store, "S:self_one", None) == ("", "conflict")
    assert agent._resolve_recipient(store, "S:self_two", None) == ("", "conflict")


@pytest.mark.parametrize("change", ["moved", "duplicate", "name_collision", "reissued"])
def test_invalid_binding_never_falls_back_to_nickname(recipient, change):
    agent, store, path = recipient
    binding = {"status": "verified", "remark": "RCP8K6AXH"}
    with sqlite3.connect(path) as db:
        if change in {"moved", "duplicate"}:
            db.execute("UPDATE external_user_relation_v3 SET real_remarks='RCP8K6AXH' WHERE user_id='two'")
        if change == "moved":
            db.execute("UPDATE external_user_relation_v3 SET real_remarks='' WHERE user_id='one'")
    if change == "name_collision":
        store.contacts.return_value["two"] = "RCP8K6AXH"
    if change == "reissued":
        binding["status"] = "needs_confirmation"
    expected = "" if change == "reissued" else "needs_confirmation"
    assert agent._resolve_recipient(store, "S:self_one", binding) == ("", expected)



def test_unbound_nickname_with_another_contacts_remark_is_a_conflict(recipient):
    agent, store, path = recipient
    store.contacts.return_value = {"one": "Bob", "two": "Alice"}
    with sqlite3.connect(path) as db:
        db.execute("UPDATE external_user_relation_v3 SET real_remarks='' WHERE user_id='one'")
        db.execute("UPDATE external_user_relation_v3 SET real_remarks='Bob' WHERE user_id='two'")
    assert agent._resolve_recipient(store, "S:self_one", None) == ("", "conflict")



@pytest.mark.parametrize("failure", ["", "unchanged_search", "wrong_search", "wrong_chat", "focus_changed"])
def test_bound_send_checks_both_enters(recipient, monkeypatch, failure):
    agent, store, _ = recipient
    cid = "S:self_one"
    route = {"status": "verified", "remark": "RCP8K6AXH"}
    monkeypatch.setattr(agent.remote_cfg, "recipient_binding_account_active", lambda me: me == "self")
    monkeypatch.setattr(agent.remote_cfg, "recipient_bindings", lambda me: {cid: route})
    empty, typed = (1, b"empty"), (1, b"search")
    captures = [empty, empty if failure == "unchanged_search" else typed, typed]
    monkeypatch.setattr(agent, "_recipient_search_field", MagicMock(side_effect=captures))
    heading = (1, b"heading")
    final = (2, b"heading") if failure == "focus_changed" else heading
    monkeypatch.setattr(agent, "_recipient_heading", MagicMock(side_effect=[heading, heading, final]))
    monkeypatch.setattr(agent, "_outbound_snapshot", MagicMock(side_effect=[{}, {"22": "response"}]))
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda frame, _: (
        "Same" if (frame == typed and failure == "wrong_search") or
        (frame == heading and failure == "wrong_chat") else route["remark"]
    ))
    inputs = MagicMock()
    monkeypatch.setattr(agent.win, "tap", inputs, raising=False)

    def desktop_sender(active_store, term, body, *, expect_id, verify_db, log):
        assert term == route["remark"]
        log("步骤0 前台就位")
        agent.win.tap("enter")
        log("步骤1 已回车进入会话")
        log("步骤3 输入框校验通过")
        agent.win.tap("enter")
        return {"ok": True, "conversation_id": expect_id}

    agent.core_send.send.side_effect = desktop_sender
    result = agent._send_text(store, "Same", cid, "response", route="auto", log_fn=MagicMock())
    assert result[0] == ("blocked" if failure else "sent")
    expected_enters = 0 if failure in {"unchanged_search", "wrong_search"} else 1 if failure else 2
    assert inputs.call_count == expected_enters

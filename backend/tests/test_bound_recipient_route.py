import sqlite3
from pathlib import Path
from subprocess import CompletedProcess
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



@pytest.mark.parametrize(
    ("nickname", "change", "expected_status", "expected_enters"),
    [
        ("", "", "sent", 2),
        ("\u3164", "", "sent", 2),
        ("Same", "", "sent", 2),
        ("Same", "moved", "blocked", 0),
        ("Same", "duplicate_remark", "blocked", 0),
        ("Same", "nickname_collision", "blocked", 0),
        ("Same", "wrong_title", "blocked", 1),
        ("Same", "moved_before_paste", "blocked", 1),
        ("Same", "moved_before_enter", "blocked", 1),
    ],
)
def test_nonpilot_send_uses_only_the_current_peer_unique_remark(
    recipient, monkeypatch, nickname, change, expected_status, expected_enters,
):
    agent, store, path = recipient
    cid, remark = "S:self_one", "RCP8K6AXH"
    store.contacts.return_value["one"] = nickname
    if change in {"moved", "duplicate_remark"}:
        with sqlite3.connect(path) as db:
            db.execute("UPDATE external_user_relation_v3 SET real_remarks=? WHERE user_id='two'", (remark,))
            if change == "moved":
                db.execute("UPDATE external_user_relation_v3 SET real_remarks='' WHERE user_id='one'")
    elif change == "nickname_collision":
        store.contacts.return_value["two"] = remark
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_recipient_binding_enabled", False)
    monkeypatch.setattr(agent, "_recipient_heading", lambda: (1, b"heading"))
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda *_: (
        "Other contact" if change == "wrong_title" else remark
    ))
    monkeypatch.setattr(agent, "_outbound_snapshot", MagicMock(side_effect=[{}, {"22": "response"}]))
    presses = MagicMock()
    monkeypatch.setattr(agent.win, "tap", presses, raising=False)

    def move_remark():
        with sqlite3.connect(path) as db:
            db.execute("UPDATE external_user_relation_v3 SET real_remarks='' WHERE user_id='one'")
            db.execute("UPDATE external_user_relation_v3 SET real_remarks=? WHERE user_id='two'", (remark,))

    def desktop_sender(_store, _term, _body, *, expect_id, verify_db, log):
        log("步骤0 前台就位")
        agent.win.hotkey("ctrl", "v")
        agent.win.tap("enter")
        log("步骤1 已回车进入会话")
        if change == "moved_before_paste":
            move_remark()
        agent.win.hotkey("ctrl", "v")
        log("步骤3 输入框校验通过")
        if change == "moved_before_enter":
            move_remark()
        agent.win.tap("enter")
        return {"ok": True, "conversation_id": expect_id}

    agent.core_send.send.side_effect = desktop_sender
    result = agent._send_text(store, nickname, cid, "response", route="auto", log_fn=MagicMock())

    if expected_enters:
        agent.core_send.send.assert_called_once()
        args, kwargs = agent.core_send.send.call_args
        assert args == (store, remark, "response")
        assert kwargs["expect_id"] == cid
        assert kwargs["verify_db"] is True
    else:
        agent.core_send.send.assert_not_called()
    assert result[0] == expected_status
    assert presses.call_count == expected_enters
    if result[0] == "sent":
        assert result[2] == f"{cid}:22"


@pytest.mark.parametrize("failure", ["", "unchanged_search", "wrong_search", "wrong_chat", "focus_changed"])
def test_bound_send_checks_both_enters(recipient, monkeypatch, failure):
    agent, store, _ = recipient
    cid = "S:self_one"
    route = {"status": "verified", "remark": "RCP8K6AXH"}
    monkeypatch.setattr(agent, "_recipient_binding_enabled", True)
    monkeypatch.setattr(agent.remote_cfg, "recipient_binding_account_active", lambda me: me == "self")
    monkeypatch.setattr(agent.remote_cfg, "recipient_bindings", lambda me: {cid: route})
    empty, typed = (1, b"empty"), (1, b"search")
    captures = [empty, empty if failure == "unchanged_search" else typed, typed]
    monkeypatch.setattr(agent, "_recipient_search_field", MagicMock(side_effect=captures))
    heading = (1, b"heading")
    final = (2, b"heading") if failure == "focus_changed" else heading
    monkeypatch.setattr(agent, "_recipient_heading", MagicMock(side_effect=[heading, heading, heading, final]))
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


@pytest.mark.parametrize(
    ("name", "language"),
    [
        ("Dark", "en-US"),
        ("RCP8K6AXH", "en-US"),
        ("Alice-23", "en-US"),
        ("小明", "zh-Hans-CN"),
        ("Evans_峰", "zh-Hans-CN"),
        ("1", "zh-Hans-CN"),
    ],
)
def test_recipient_ocr_uses_language_for_expected_name(monkeypatch, name, language):
    agent = load_autopilot()
    monkeypatch.setenv("SystemRoot", r"C:\Windows")

    def recognize(command, *, env, **_):
        selected = env.get("CITY_RECRUIT_HEADING_LANGUAGE", "zh-Hans-CN")
        # As seen on Windows, Chinese OCR can misread an English name.
        result = name if selected == language else "unrelated title"
        return CompletedProcess(command, 0, stdout=result.encode("utf-8"))

    monkeypatch.setattr(agent.subprocess, "run", recognize)
    assert agent._recognize_recipient_heading((1, b"heading"), name) == name


@pytest.mark.parametrize(("name", "first", "fallback_used"), [
    ("\u91ca\u6000", "", True),
    ("\u91ca\u6000", "\u5176\u4ed6\u8054\u7cfb\u4eba", False),
    ("Dark", "", False),
])
def test_title_ocr_uses_grayscale_only_after_empty_chinese_read(monkeypatch, name, first, fallback_used):
    agent = load_autopilot()
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    used = []

    def recognize(command, *, env, **_):
        frame = Path(env["CITY_RECRUIT_HEADING_IMAGE"]).read_bytes()
        used.append(frame)
        return CompletedProcess(command, 0, stdout=(first if frame == b"mono" else name).encode("utf-8"))

    monkeypatch.setattr(agent.subprocess, "run", recognize)
    result = agent._recognize_recipient_heading((1, b"mono", b"gray"), name)
    assert result == (name if fallback_used else first)
    assert used == ([b"mono", b"gray"] if fallback_used else [b"mono"])


@pytest.mark.parametrize("heading", [None, (42, b"another contact")])
def test_unique_contact_does_not_authorize_a_missing_or_different_title(monkeypatch, heading):
    agent = load_autopilot()
    store = MagicMock()
    store.self_id.return_value = "self"
    store.contacts.return_value = {"one": "Dark"}
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_recipient_heading", lambda: heading)
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda *_: "Another contact")
    monkeypatch.setattr(agent, "_outbound_snapshot", lambda *_: {})
    presses = MagicMock()
    monkeypatch.setattr(agent.win, "tap", presses, raising=False)

    def desktop_sender(_store, _term, _body, *, expect_id, verify_db, log):
        log("\u6b65\u9aa40 foreground")
        agent.win.tap("enter")
        log("\u6b65\u9aa41 selected")
        log("\u6b65\u9aa43 before send")
        agent.win.tap("enter")
        return {"ok": True, "conversation_id": expect_id}

    agent.core_send.send.side_effect = desktop_sender
    result = agent._send_text(store, "Dark", "S:self_one", "response", route="opening", log_fn=MagicMock())

    assert result[0] == "blocked"
    presses.assert_called_once_with("enter")



@pytest.mark.parametrize("glyph, recognized, competitor, verified", [
    ("wave", "小e(工作时间09·18点)", "", True),
    ("dot", "小e(工作时间09·18点)", "", False),
    ("wave", "小e(工作时间09·8点)", "", False),
    ("wave", "小e(工作时间09·18点)", "小e（工作时间09·18点）", False),
])
def test_mixed_title_requires_the_whole_title_and_wave_pixels(recipient, monkeypatch, glyph, recognized, competitor, verified):
    agent, store, path = recipient
    name = "小e（工作时间09~18点）"
    store.contacts.return_value = {"one": name}
    if competitor:
        with sqlite3.connect(path) as db:
            db.execute("UPDATE external_user_relation_v3 SET remarks=? WHERE user_id='two'", (competitor,))
    raster, rect = title_raster(glyph)
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda *_: "小e")
    monkeypatch.setattr(agent, "_read_native_title_words", lambda *_: (recognized, [rect]), raising=False)
    heading = (1, b"mono", b"gray", raster)
    assert agent._verified_recipient_heading(heading, name, store, "self", "S:self_one") is verified


def title_raster(glyph):
    if glyph == "wave":
        rows = ["..##......", ".#..#...#.", "#....###..", ".........."]
    else:
        rows = ["..........", "....##....", "....##....", ".........."]
    pixels = bytes(0 if char == "#" else 255 for row in rows for char in row)
    return (10, 4, pixels), [0, 0, 10, 4]


@pytest.mark.parametrize("changed", [False, True])
def test_mixed_title_send_rechecks_live_frame_before_body_paste(recipient, monkeypatch, changed):
    agent, store, path = recipient
    with sqlite3.connect(path) as db:
        db.execute("UPDATE external_user_relation_v3 SET real_remarks=''")
    name = "小e（工作时间09~18点）"
    cid = "S:self_one"
    store.contacts.return_value = {"one": name}
    raster, rect = title_raster("wave")
    frame = (1, b"mono", b"gray", raster)
    frames = [frame, frame, (2, *frame[1:]) if changed else frame, frame, frame]
    monkeypatch.setattr(agent, "_guard_recipient", True)
    monkeypatch.setattr(agent, "_recipient_heading", MagicMock(side_effect=frames))
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda *_: "小e")
    monkeypatch.setattr(agent, "_read_native_title_words", lambda *_: ("小e(工作时间09·18点)", [rect]), raising=False)
    monkeypatch.setattr(agent, "_outbound_snapshot", MagicMock(side_effect=[{}, {"22": "response"}]))
    pressed, pasted = MagicMock(), MagicMock()
    monkeypatch.setattr(agent.win, "tap", pressed, raising=False)
    monkeypatch.setattr(agent.win, "hotkey", pasted, raising=False)

    def desktop_sender(_store, _term, _body, *, expect_id, verify_db, log):
        log("步骤0 前台就位")
        agent.win.hotkey("ctrl", "v")
        agent.win.tap("enter")
        log("步骤1 已回车进入会话")
        agent.win.hotkey("ctrl", "v")
        log("步骤3 输入框校验通过")
        agent.win.tap("enter")
        return {"ok": True, "conversation_id": expect_id}

    agent.core_send.send.side_effect = desktop_sender
    result = agent._send_text(store, name, cid, "response", route="auto", log_fn=MagicMock())
    assert result[0] == ("blocked" if changed else "sent")
    assert pressed.call_count == pasted.call_count == (1 if changed else 2)


def test_title_width_equivalent_contacts_are_ambiguous():
    agent = load_autopilot()
    store = MagicMock()
    store.self_id.return_value = "self"
    store.contacts.return_value = {"one": "小e（工作时间09~18点）", "two": "小e(工作时间09~18点)"}
    assert not agent._local_recipient_term(store, "S:self_one")

"""发送结果记账与节流（agent/autopilot.py drain + agent/reply_store.py）。

2026-11-16 事故回归：
1. 失败"零成本"立即重试下一个会话 → 3 秒连发 3 个客户 → 触发风控掉登录。
   修复：冷却在按键前更新，成败都消耗；连续失败退避最多 4 倍。
2. "已发送但回读失败"被记成 sent：可能静默丢失。修复：新增 unknown 态，
   不参与自动补发，人工核对后逐条重新入队。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests import agent_loader
from tests.agent_loader import load_autopilot, stub_text_readback


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    stub_text_readback(module, monkeypatch)
    spec = importlib.util.spec_from_file_location(
        "isolated_reply_store",
        Path(module.__file__).with_name("reply_store.py"),
    )
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply_log.db"
    records.init()
    records.record_incoming({
        "id": 10, "conv_id": "S:customer", "conv_name": "Customer",
        "text": "salary?", "type": 2, "time": 100,
    })
    monkeypatch.setattr(module, "rlog", records)
    module._brain = MagicMock()
    module._brain.chat.return_value = {"ok": True, "parts": ["hi"], "medias": [], "scene": "Agent", "detail": "ok"}
    module._brain.opening.return_value = {"ok": False, "items": [], "detail": "no opening"}
    module._last_reply_at = 0
    module._consecutive_send_failures = 0
    return module


CFG = {"cooldown": 0, "reply_first": "1", "reply_next": "233", "brain": {"mode": "agent"}}


def _status_of(records):
    rows = records.recent(5)
    return {r["message_id"]: r["status"] for r in rows}.get("10")


def test_send_failure_consumes_cooldown_and_counts_backoff(agent):
    agent.core_send.send.return_value = {"ok": False, "detail": "抢不到前台，已中止"}
    before = agent._last_reply_at
    stats = agent.drain(MagicMock(), CFG)
    assert stats["sent"] == 0 and stats["failed"] == 1
    # 失败也算一次企微操作：冷却时间戳必须前进（修复前失败不更新，立即重试）
    assert agent._last_reply_at > before
    assert agent._consecutive_send_failures == 1
    assert _status_of(agent.rlog) == "failed"


@pytest.mark.parametrize("detail", [
    "已发送但回读失败：No item with that key",
    "已发送，但库里还没读到（WAL 可能有延迟），请人工看一眼",
])
def test_readback_failure_is_unknown_not_sent(agent, detail):
    agent.core_send.send.return_value = {"ok": True, "conversation_id": "", "detail": detail}
    stats = agent.drain(MagicMock(), CFG)
    assert stats["unknown"] == 1 and stats["sent"] == 0
    assert _status_of(agent.rlog) == "unknown"
    assert agent._consecutive_send_failures == 1
    # unknown 不参与自动补发
    assert agent.rlog.pending(include_failed=True) == []


def test_success_resets_backoff_counter(agent):
    agent.core_send.send.return_value = {"ok": False, "detail": "失败一"}
    agent.drain(MagicMock(), CFG)
    assert agent._consecutive_send_failures == 1
    agent.core_send.send.side_effect = lambda *args, **kwargs: {
        "ok": True, "conversation_id": kwargs["expect_id"], "detail": "sent",
    }
    agent.rlog.record_incoming({
        "id": 11, "conv_id": "S:customer2", "conv_name": "Customer",
        "text": "hi", "type": 2, "time": 200,
    })
    # 第二轮会把上一轮 failed 的第 10 条一起补发（既有行为），两条都成功
    stats = agent.drain(MagicMock(), CFG)
    assert stats["sent"] == 2
    assert agent._consecutive_send_failures == 0
    assert _status_of(agent.rlog) == "sent"


def test_brain_failure_still_blocks_input(agent):
    agent._brain.chat.return_value = {"ok": False, "detail": "HTTP 503"}
    stats = agent.drain(MagicMock(), CFG)
    assert stats["blocked"] == 1
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize("case,reason", [
    ("ready", None),
    ("hidden", "window_hidden"),
    ("cloaked", "window_unavailable"),
    ("disabled", "window_unavailable"),
    ("foreign", "window_owner_unverified"),
    ("missing", "window_missing"),
    ("locked", "desktop_unavailable"),
    ("probe_error", "window_probe_failed"),
    ("restored", None),
    ("still_minimized", "window_minimized"),
    ("restore_switches_window", "window_changed"),
    ("restore_changes_owner", "window_changed"),
    ("minimized_foreign", "window_owner_unverified"),
])
def test_send_window_guard_checks_current_core_choice(monkeypatch, case, reason):
    agent = load_autopilot(mock_send_window=False)
    monkeypatch.setattr(agent, "log", MagicMock())
    monkeypatch.setattr(agent, "_reply_desktop_active", lambda: case != "locked")
    monkeypatch.setattr(agent, "_is_wecom_window_owner", lambda pid: pid == 9344 and case not in ("foreign", "minimized_foreign"))
    monkeypatch.setattr(agent.time, "sleep", MagicMock())
    may_restore = case in ("restored", "still_minimized", "restore_switches_window", "restore_changes_owner")
    agent.win.user32.IsIconic.side_effect = lambda _hwnd: (
        case in ("still_minimized", "minimized_foreign") or (may_restore and not agent.win.user32.ShowWindow.called)
    )
    if case == "hidden":
        agent.win.find_window.return_value = {"hwnd": 20, "rect": (0, 0, 1180, 715), "visible": False}
    elif case == "missing":
        agent.win.find_window.return_value = None
    else:
        agent.win.find_window.return_value = {"hwnd": 20, "rect": (0, 0, 1412, 647), "visible": True}
    agent.win.win32gui.IsWindow.return_value = True
    agent.win.win32gui.IsWindowVisible.return_value = case != "hidden"
    agent.win.win32gui.IsWindowEnabled.return_value = case != "disabled"
    agent.win.win32gui.GetClassName.return_value = "WeWorkWindow"
    agent.win.win32process.GetWindowThreadProcessId.return_value = (2, 9344)
    if case == "restore_switches_window":
        target = agent.win.find_window.return_value
        agent.win.find_window.side_effect = lambda: (
            {**target, "hwnd": 30} if agent.win.user32.ShowWindow.called else target
        )
    if case == "restore_changes_owner":
        agent.win.win32process.GetWindowThreadProcessId.side_effect = lambda _hwnd: (
            (2, 9999) if agent.win.user32.ShowWindow.called else (2, 9344)
        )
    dwm = MagicMock()

    def attribute(_hwnd, _attribute, output, _size):
        output._obj.value = int(case == "cloaked")
        return int(case == "probe_error")

    dwm.DwmGetWindowAttribute.side_effect = attribute
    monkeypatch.setattr(agent.ctypes, "WinDLL", lambda _: dwm, raising=False)
    if may_restore:
        assert agent.desktop_send_ready("health") == (True, "")
        agent.win.user32.ShowWindow.assert_not_called()
    outcome, _, _ = agent._send_text(MagicMock(), "Test", "S:test", "test", route="auto", log_fn=MagicMock())

    if may_restore:
        agent.win.user32.ShowWindow.assert_called_once_with(20, 9)
    else:
        agent.win.user32.ShowWindow.assert_not_called()
    if reason is None:
        agent.core_send.send.assert_called_once()
    else:
        assert outcome == "blocked"
        agent.core_send.send.assert_not_called()
        record = next(call for call in agent.log.call_args_list if call.args == ("wecom_send_window_blocked",))
        assert record.kwargs["reason_code"] == reason


def test_process_exit_during_send_leaves_a_durable_unknown(agent):
    def exit_during_send(*args, **kwargs):
        assert _status_of(agent.rlog) == "unknown"
        raise SystemExit(1)

    agent.core_send.send.side_effect = exit_during_send
    with pytest.raises(SystemExit):
        agent.drain(MagicMock(), CFG)
    agent.rlog.init()
    assert agent.rlog.pending(include_failed=True) == []
    agent.drain(MagicMock(), CFG)
    agent.core_send.send.assert_called_once()


def test_send_events_link_foreground_samples_without_message_content(agent, monkeypatch, tmp_path):
    monkeypatch.setattr(agent, "LOG_DIR", tmp_path)
    monkeypatch.setattr(agent, "LOG_PATH", tmp_path / "run.log")
    monkeypatch.setattr(agent, "_foreground_sample", lambda: {"foreground_pid": 42, "window_class": "ConsoleWindowClass"})

    def send(*args, log, **kwargs):
        log("开始发送 -> 「测试昵称」：hidden-test-body")
        log("步骤0 前台就位、窗口可见")
        log("步骤3 输入框校验通过（hidden-test-hint）")
        log("步骤4 已回车发送")
        return {"ok": True, "conversation_id": "", "detail": "库里还没读到"}

    agent.core_send.send.side_effect = send
    agent.drain(MagicMock(), CFG)
    lines = (tmp_path / "run.log").read_text(encoding="utf-8")
    events = [line for line in lines.splitlines() if " wecom_send " in line]
    fields = [dict(field.split("=", 1) for field in line.split(" wecom_send ", 1)[1].split()) for line in events]
    assert [event["phase"] for event in fields] == ["start", "core_0", "core_3", "core_4", "result"]
    assert len({event["attempt_id"] for event in fields}) == 1
    assert all(event["route"] == "auto" and event["foreground_pid"] == "42" for event in fields)
    assert all(event["trace_id"] and event["part"] == "1" for event in fields)
    assert fields[-1]["outcome"] == "unknown"
    assert fields[-1]["reason_code"] == "target_conversation_missing"
    assert "hidden-test-body" not in lines and "hidden-test-hint" not in lines


def test_approved_recovery_requeues_only_selected_unknown_record(tmp_path):
    spec = importlib.util.spec_from_file_location(
        "isolated_reply_store2",
        agent_loader.AGENT_DIR / "reply_store.py",
    )
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply_log.db"
    records.init()
    records.record_incoming({
        "id": 10, "conv_id": "S:customer", "conv_name": "Customer",
        "text": "salary?", "type": 2, "time": 100,
    })
    records.mark_unknown("10", "S:customer", "已发送但回读失败", scene="kb", reply_text="hi")
    assert records.pending(include_failed=True) == []
    assert records.queue_reply_recovery("S:customer", "10", reason="checked", operator="test") == "queued"
    rows = records.pending(include_failed=True)
    assert len(rows) == 1 and rows[0]["status"] == "pending"


def _rich_plain_text(*parts):
    def sized(tag, payload):
        length = len(payload)
        prefix = bytes((length,)) if length < 128 else bytes((0x80 | (length & 127), length >> 7))
        return tag + prefix + payload

    return b"".join(
        sized(b"\x0a", b"\x08\x00" + sized(b"\x12", sized(b"\x0a", part.encode("utf-8"))))
        for part in parts
    )


@pytest.mark.parametrize(("case", "status"), [
    ("exact", "sent"),
    ("previous_id", "unknown"),
    ("wrong_body", "unknown"),
    ("duplicate", "unknown"),
    ("other_new_outbound", "unknown"),
    ("foreign_core_cid", "unknown"),
    ("no_final_enter", "unknown"),
    ("invalid_fragment", "unknown"),
])
def test_guarded_opening_confirms_exact_fragmented_outbound(monkeypatch, case, status):
    agent = load_autopilot()
    cid = "S:self_one"
    first = "Long first line " * 10
    body = first + "\U0001f600" + "\nsecond line"
    exact = _rich_plain_text(first, "\U0001f600", "\nsecond line")
    agent._guard_recipient = True
    store = MagicMock()
    store.self_id.return_value = "self"
    store.contacts.return_value = {"one": "Dark"}
    c = store._conn.return_value
    rows = [(42, exact)]
    if case == "wrong_body":
        rows = [(42, _rich_plain_text(first, "\nsecond line"))]
    if case == "invalid_fragment":
        rows = [(42, exact[:-1])]
    if case == "duplicate":
        rows.append((43, exact))
    if case == "other_new_outbound":
        rows.append((43, "Another message"))
    c.execute.return_value.fetchall.side_effect = [
        rows if case == "previous_id" else [],
        rows,
    ]
    heading = (1, b"heading")
    monkeypatch.setattr(agent, "_recipient_heading", lambda: heading)
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda *_: "Dark")

    def send(_store, _name, _body, *, log, **_):
        log("\u6b65\u9aa40 foreground")
        agent.win.tap("enter")
        log("\u6b65\u9aa41 selected")
        log("\u6b65\u9aa43 checked")
        if case != "no_final_enter":
            agent.win.tap("enter")
            log("\u6b65\u9aa44 sent")
        return {"ok": True, "conversation_id": "S:self_other" if case == "foreign_core_cid" else ""}

    agent.core_send.send.side_effect = send
    actual, _, outbound_id = agent._send_text(store, "Dark", cid, body, route="opening", log_fn=MagicMock())
    assert actual == status
    assert outbound_id == (cid + ":42" if status == "sent" else "")
    agent.core_send.send.assert_called_once()

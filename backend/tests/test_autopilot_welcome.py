"""Exercise the existing orchestrator; every desktop input API is mocked."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from tests.agent_loader import load_autopilot, load_reply_store

PARTS = ["你好，欢迎咨询招聘岗位。", "我先帮你了解一下。", "请问你现在在哪个城市？"]
CFG = {"target": "all", "cooldown": 0, "brain": {"mode": "flow"}}


def setup_agent(tmp_path, monkeypatch):
    agent = load_autopilot()
    records = load_reply_store(tmp_path / "replies.db")
    monkeypatch.setattr(agent, "rlog", records)
    monkeypatch.setattr(agent, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(agent.time, "sleep", lambda _: None)
    agent._brain = MagicMock(mode="flow")
    agent._brain.greet.return_value = {"ok": True, "reply": "\n".join(PARTS), "parts": PARTS}
    agent._last_reply_at = 0
    agent.core_send.send.return_value = {"ok": True, "detail": "mocked only"}
    store = MagicMock()
    store.self_id.return_value = 'test'
    outbox = []
    store.outbox = outbox
    store.messages.side_effect = lambda *args, **kwargs: list(outbox)

    def send(*args, **kwargs):
        result = agent.core_send.send.return_value
        if result.get('ok'):
            outbox.append({'id': f'out-{len(outbox)}', 'sender_id': 'test', 'text': args[2]})
        return result

    agent.core_send.send.side_effect = send
    store.recent.return_value = [{"id": 1, "conv_id": "S:test", "conv_name": "专用测试联系人", "text": "", "type": 1011, "time": 100, "is_self": False}]
    return agent, store


def test_empty_new_contact_record_sends_configured_parts_and_persists_first_contact_state(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    assert agent.scan(store, CFG) == 1
    assert agent.drain(store, CFG)["sent"] == 1
    agent._brain.greet.assert_called_once_with("S:test")
    agent._brain.reply.assert_not_called()
    assert [call.args[2] for call in agent.core_send.send.call_args_list] == PARTS
    assert all(call.kwargs["expect_id"] == "S:test" for call in agent.core_send.send.call_args_list)
    assert all(call.kwargs["verify_db"] is True for call in agent.core_send.send.call_args_list)
    assert agent._load_greeted() == {"S:test"}

    # Restart: preserve actual files, rebuild the module and read the same marker.
    again = load_autopilot()
    monkeypatch.setattr(again, "rlog", agent.rlog)
    monkeypatch.setattr(again, "GREET_STATE", agent.GREET_STATE)
    assert not again._is_first_contact("S:test", again._load_greeted())
    assert again.scan(store, CFG) == 0  # Replay of the same source record is not a new greeting.
    assert again.drain(store, CFG)["sent"] == 0
    again.core_send.send.assert_not_called()


def test_later_welcome_parts_use_same_open_chat_fast_path(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    calls = []
    win_api = SimpleNamespace(
        __name__="wecom_io_core.win",
        wxwork_alive=lambda: True,
        find_window=lambda: {"hwnd": 7},
        ensure_foreground=lambda hwnd, tries=4: True,
        hotkey=lambda *keys: calls.append(("hotkey", keys)),
        tap=lambda key: calls.append(("tap", key)),
        set_clipboard=lambda text: calls.append(("clipboard", text)),
        release_modifiers=lambda: None,
    )
    agent.core_send.win = win_api
    agent.core_send._wait_visible = lambda *args: None
    agent.core_send.verify_input_box = lambda text, retries=5: (True, "synthetic input ok")
    result = agent._send_welcome_part_fast(store, "第二段", lambda msg: calls.append(("log", msg)))
    assert result == {"ok": True, "conversation_id": "", "detail": "已发送（同一会话快速续发）"}
    assert ("hotkey", ("ctrl", "f")) not in calls
    assert ("tap", "enter") in calls
    assert ("clipboard", "第二段") in calls


def test_offline_and_dry_run_do_not_send_greeting_or_mutate_server_state(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    assert agent.drain(store, CFG, wecom_state="login_required")["blocked"] == 1
    agent.drain(store, CFG, dry=True)
    agent._brain.greet.assert_not_called()
    agent._brain.reply.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert not agent.GREET_STATE.exists()
    assert agent.rlog.pending()[0]["status"] == "pending"


def test_question_arriving_during_welcome_waits_until_all_parts_are_sent(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.rlog.record_incoming({"id": 2, "conv_id": "S:test", "conv_name": "专用测试联系人",
                                "text": "工资多少", "type": 2, "time": 101})
    assert agent.drain(store, CFG)["sent"] == 1
    assert [call.args[2] for call in agent.core_send.send.call_args_list] == PARTS
    pending = agent.rlog.pending()
    assert len(pending) == 1
    assert pending[0]["message_id"] == "2"
    assert pending[0]["in_text"] == "工资多少"
    agent._brain.reply.return_value = {"ok": True, "reply": "本厂工资", "scene": "知识库"}
    assert agent.drain(store, CFG)["sent"] == 1
    assert agent._brain.reply.call_args.args[0] == "工资多少"


def test_flow_welcome_interval_is_capped_after_remote_refresh(tmp_path, monkeypatch):
    agent = load_autopilot()

    cfg = {"brain": {"mode": "flow"}, "interval": 20.0}
    assert agent._enforce_flow_welcome_interval(cfg) is True
    assert cfg["interval"] == agent.WELCOME_SCAN_INTERVAL == 3.0

    # Reapplying the guard is what happens after each bridge heartbeat. Once
    # capped, it must be a no-op and leave the short interval in place.
    assert agent._enforce_flow_welcome_interval(cfg) is False
    assert cfg["interval"] == 3.0


def test_non_flow_interval_is_not_changed(tmp_path, monkeypatch):
    agent = load_autopilot()
    cfg = {"brain": {"mode": "kb"}, "interval": 20.0}
    assert agent._enforce_flow_welcome_interval(cfg) is False
    assert cfg["interval"] == 20.0

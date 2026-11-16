"""Exercise the existing orchestrator; every desktop input API is mocked."""
from __future__ import annotations

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

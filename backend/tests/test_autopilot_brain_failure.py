from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    spec = importlib.util.spec_from_file_location("isolated_reply_store", Path(module.__file__).with_name("reply_store.py"))
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply_log.db"
    records.init()
    records.record_incoming({"id": 10, "conv_id": "S:customer", "conv_name": "Customer", "text": "salary?", "type": 2, "time": 100})
    monkeypatch.setattr(module, "rlog", records)
    module._brain = MagicMock()
    module._last_reply_at = 0
    module.core_send.send.return_value = {"ok": True, "detail": "sent"}
    return module


CFG = {"cooldown": 0, "reply_first": "1", "reply_next": "233", "brain": {"mode": "kb"}}


@pytest.mark.parametrize("response", [
    {"ok": False, "detail": "HTTP 503"},
    {"ok": False, "detail": "timeout"},
    {"ok": True, "reply": "   "},
    {"ok": True, "reply": 123},
    {},
])
def test_failed_or_empty_brain_response_holds_without_input_and_without_automatic_retry(agent, response):
    agent._brain.reply.return_value = response
    result = agent.drain(MagicMock(), CFG)
    assert result["blocked"] == 1
    agent.core_send.send.assert_not_called()
    agent.compat.wait_clipboard_writable.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "held"
    assert agent.rlog.recent()[0]["reply_text"] == ""
    assert "知识库暂停" in agent.rlog.recent()[0]["error"]
    assert agent.rlog.pending() == []
    agent.drain(MagicMock(), CFG)
    agent._brain.reply.assert_called_once()


def test_brain_exception_is_held_and_can_be_explicitly_requeued(agent):
    agent._brain.reply.side_effect = TimeoutError("offline")
    agent.drain(MagicMock(), CFG)
    agent.core_send.send.assert_not_called()
    # Reinitializing the database leaves held entries out of the send queue.
    agent.rlog.init()
    assert agent.rlog.pending() == []
    assert agent.rlog.retry_held() == 1
    agent._brain.reply.side_effect = None
    agent._brain.reply.return_value = {"ok": True, "reply": "Actual knowledge base answer", "detail": "ok"}
    assert agent.drain(MagicMock(), CFG)["sent"] == 1
    assert agent.core_send.send.call_args.args[2] == "Actual knowledge base answer"
    assert agent.rlog.recent()[0]["status"] == "sent"
    assert agent.rlog.retry_held() == 0


def test_non_text_message_is_held_without_calling_brain_or_sender(agent):
    with agent.rlog._conn() as con:
        con.execute("UPDATE reply_log SET in_text='',in_type=14")
    result = agent.drain(MagicMock(), CFG)
    assert result["blocked"] == 1
    agent._brain.reply.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "held"


def test_dry_run_does_not_mutate_held_or_sent_state(agent):
    agent._brain.reply.return_value = {"ok": False, "detail": "timeout"}
    assert agent.drain(MagicMock(), CFG, dry=True)["blocked"] == 1
    assert agent.rlog.recent()[0]["status"] == "pending"
    agent._brain.reply.return_value = {"ok": True, "reply": "answer"}
    assert agent.drain(MagicMock(), CFG, dry=True)["sent"] == 1
    assert agent.rlog.recent()[0]["status"] == "pending"
    agent.core_send.send.assert_not_called()


def test_explicit_fixed_mode_still_uses_configured_reply(agent):
    agent._brain = None
    cfg = {**CFG, "brain": {"mode": "fixed"}, "reply_first": "Configured fixed reply"}
    assert agent.drain(MagicMock(), cfg)["sent"] == 1
    assert agent.core_send.send.call_args.args[2] == "Configured fixed reply"


def test_kb_mode_without_initialized_brain_does_not_send_fixed_reply(agent):
    agent._brain = None
    assert agent.drain(MagicMock(), CFG)["blocked"] == 1
    agent.core_send.send.assert_not_called()


def test_retry_held_cli_requeues_and_exits_without_initializing_store(agent, tmp_path, monkeypatch):
    agent.rlog.mark_held("10", "timeout")
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--retry-held"])
    assert agent.main() == 0
    assert agent.rlog.pending()[0]["message_id"] == "10"
    agent.core_send.send.assert_not_called()
    agent.Store.assert_not_called()

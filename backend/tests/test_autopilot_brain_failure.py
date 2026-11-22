from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, stub_text_readback


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    stub_text_readback(module, monkeypatch)
    spec = importlib.util.spec_from_file_location("isolated_reply_store", Path(module.__file__).with_name("reply_store.py"))
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply_log.db"
    records.init()
    records.record_incoming({"id": 10, "conv_id": "S:customer", "conv_name": "Customer", "text": "salary?", "type": 2, "time": 100})
    monkeypatch.setattr(module, "rlog", records)
    module._brain = MagicMock()
    # 会话已播过开场：这些用例只测对话阶段的失败暂停
    monkeypatch.setattr(module, "_is_first_contact", lambda cid, seen: False)
    module._brain.chat.return_value = {"ok": True, "reply": "hi", "parts": ["hi"], "medias": [], "scene": "Agent", "detail": "ok"}
    module._last_reply_at = 0
    module.core_send.send.return_value = {"ok": True, "conversation_id": "S:customer", "detail": "sent"}
    return module


CFG = {"cooldown": 0, "reply_first": "1", "reply_next": "233", "brain": {"mode": "agent"}}


@pytest.mark.parametrize("response", [
    {"ok": False, "detail": "HTTP 503"},
    {"ok": False, "detail": "timeout"},
    {"ok": True, "parts": [], "medias": [], "detail": "空"},
    {"ok": True, "parts": ["   "], "medias": [], "detail": "空"},
    {},
])
def test_failed_or_empty_brain_response_holds_without_input_and_without_automatic_retry(agent, response):
    agent._brain.chat.return_value = response
    result = agent.drain(MagicMock(), CFG)
    assert result["blocked"] == 1
    agent.core_send.send.assert_not_called()
    agent.compat.wait_clipboard_writable.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "held"
    assert agent.rlog.recent()[0]["reply_text"] == ""
    assert "Agent 暂停" in agent.rlog.recent()[0]["error"]
    assert agent.rlog.pending() == []
    agent.drain(MagicMock(), CFG)
    agent._brain.chat.assert_called_once()


def test_brain_exception_is_held_and_can_be_explicitly_requeued(agent):
    agent._brain.chat.side_effect = TimeoutError("offline")
    agent.drain(MagicMock(), CFG)
    agent.core_send.send.assert_not_called()
    # Reinitializing the database leaves held entries out of the send queue.
    agent.rlog.init()
    assert agent.rlog.pending() == []
    assert agent.rlog.retry_held() == 1
    agent._brain.chat.side_effect = None
    agent._brain.chat.return_value = {"ok": True, "reply": "Actual agent answer", "parts": ["Actual agent answer"], "medias": [], "detail": "ok"}
    assert agent.drain(MagicMock(), CFG)["sent"] == 1
    assert agent.core_send.send.call_args.args[2] == "Actual agent answer"
    assert agent.rlog.recent()[0]["status"] == "sent"
    assert agent.rlog.retry_held() == 0


def test_non_text_message_is_held_without_calling_brain_or_sender(agent):
    with agent.rlog._conn() as con:
        con.execute("UPDATE reply_log SET in_text='',in_type=14")
    result = agent.drain(MagicMock(), CFG)
    assert result["blocked"] == 1
    agent._brain.chat.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "held"


def test_dry_run_does_not_mutate_held_or_sent_state(agent):
    agent._brain.chat.return_value = {"ok": False, "detail": "timeout"}
    assert agent.drain(MagicMock(), CFG, dry=True)["blocked"] == 1
    assert agent.rlog.recent()[0]["status"] == "pending"
    agent._brain.chat.return_value = {"ok": True, "reply": "answer", "parts": ["answer"], "medias": [], "detail": "ok"}
    assert agent.drain(MagicMock(), CFG, dry=True)["sent"] == 1
    assert agent.rlog.recent()[0]["status"] == "pending"
    agent.core_send.send.assert_not_called()


def test_fixed_mode_still_uses_configured_reply(agent):
    agent._brain = None
    cfg = {**CFG, "brain": {"mode": "fixed"}, "reply_first": "Configured fixed reply"}
    assert agent.drain(MagicMock(), cfg)["sent"] == 1
    assert agent.core_send.send.call_args.args[2] == "Configured fixed reply"


def test_agent_mode_without_initialized_brain_uses_configured_reply(agent):
    agent._brain = None
    assert agent.drain(MagicMock(), CFG)["sent"] == 1


def test_retry_held_cli_requeues_and_exits_without_initializing_store(agent, tmp_path, monkeypatch):
    agent.rlog.mark_held("10", "S:customer", "timeout")
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--retry-held"])
    assert agent.main() == 0
    assert agent.rlog.pending()[0]["message_id"] == "10"
    agent.core_send.send.assert_not_called()
    agent.Store.assert_not_called()


@pytest.mark.parametrize("outcome", [
    {"ok": False, "detail": "发到了别的会话", "conversation_id": "S:other"},
    {"ok": True, "detail": "sent", "conversation_id": "S:other"},
    {"ok": True, "detail": "回读失败"},
])
def test_uncertain_landing_stops_parts_media_and_batch_without_requeue(agent, outcome):
    agent.rlog.record_incoming({"id": 11, "conv_id": "S:next", "conv_name": "Next", "text": "hello", "type": 2, "time": 101})
    agent._brain.chat.return_value = {"ok": True, "parts": ["first", "second"], "medias": [], "scene": "Agent"}
    agent.core_send.split_media_marks.side_effect = lambda text: (text, [("image", "test.png")])
    agent.core_send.send.return_value = outcome

    result = agent.drain(MagicMock(), CFG)

    assert result["unknown"] == 1
    agent.core_send.send.assert_called_once()
    agent.core_send.paste_media.assert_not_called()
    rows = {r["conv_id"]: r for r in agent.rlog.recent()}
    assert rows["S:customer"]["status"] == "unknown"
    assert rows["S:next"]["status"] == "pending"
    agent.rlog.init()
    assert [r["conv_id"] for r in agent.rlog.pending()] == ["S:next"]


def test_confirmed_first_part_is_not_replayed_when_second_part_fails(agent, monkeypatch):
    monkeypatch.setattr(agent.time, "sleep", lambda seconds: None)
    agent._brain.chat.return_value = {"ok": True, "parts": ["first", "second"], "medias": []}
    agent.core_send.send.side_effect = [
        {"ok": True, "conversation_id": "S:customer", "detail": "ok"},
        {"ok": False, "conversation_id": "", "detail": "抢不到前台"},
    ]

    assert agent.drain(MagicMock(), CFG)["unknown"] == 1
    assert agent.rlog.recent()[0]["status"] == "unknown"
    agent.rlog.init()
    agent.drain(MagicMock(), CFG)
    assert [call.args[2] for call in agent.core_send.send.call_args_list] == ["first", "second"]

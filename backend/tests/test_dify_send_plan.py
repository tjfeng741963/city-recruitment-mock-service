from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


def test_executes_server_delays_and_interleaves_media(monkeypatch):
    agent = load_autopilot()
    calls = []
    monkeypatch.setattr(agent.time, "sleep", lambda seconds: calls.append(("wait", seconds)))
    monkeypatch.setattr(agent, "_send_text", lambda *args, **kwargs: calls.append(("text", args[3])) or ("sent", "ok", "id"))
    monkeypatch.setattr(agent, "_send_dify_media", lambda *args: calls.append(("video", args[2]["name"])) or ("sent", "ok"), raising=False)
    plan = [
        {"type": "text", "content": "岗位说明", "delay_ms": 0},
        {"type": "video", "name": "work.mp4", "delay_ms": 3500},
        {"type": "text", "content": "想约面试吗？", "delay_ms": 6500},
    ]
    assert agent._send_dify_plan(MagicMock(), "候选人", "S:contact", plan, MagicMock()) == ("sent", "ok", 3)
    assert calls == [("text", "岗位说明"), ("wait", 3.5), ("video", "work.mp4"), ("wait", 6.5), ("text", "想约面试吗？")]


def test_unknown_media_outcome_stops_invitation(monkeypatch):
    agent = load_autopilot()
    sender = MagicMock(return_value=("sent", "ok", "id"))
    monkeypatch.setattr(agent, "_send_text", sender)
    monkeypatch.setattr(agent, "_send_dify_media", MagicMock(return_value=("unknown", "no readback")))
    plan = [
        {"type": "text", "content": "岗位说明", "delay_ms": 0},
        {"type": "video", "name": "work.mp4", "delay_ms": 0},
        {"type": "text", "content": "想约面试吗？", "delay_ms": 0},
    ]
    assert agent._send_dify_plan(MagicMock(), "候选人", "S:contact", plan, MagicMock()) == ("unknown", "no readback", 1)
    assert sender.call_count == 1


@pytest.mark.parametrize("delays,valid", [([0, 5300], True), ([0], False), ([0, True], False)])
def test_client_accepts_only_valid_server_plan(delays, valid):
    agent = load_autopilot()
    from brain import Brain

    client = MagicMock(device_code="test-device")
    client._post.return_value = {"ok": True, "provider": "dify", "reply": {
        "messages": [{"type": "text", "content": "工作内容"}, {"type": "video", "name": "work.mp4"}],
        "delays_before_ms": delays,
    }}
    response = Brain.chat(client, "你好", "S:contact")
    assert client._post.call_args.args[1]["ordered_reply"] is True
    assert response["ok"] is valid
    if valid:
        assert response["plan"][1] == {"type": "video", "name": "work.mp4", "delay_ms": 5300}

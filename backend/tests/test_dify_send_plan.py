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


@pytest.mark.parametrize("kind", ["image", "video"])
def test_blocked_dify_media_is_never_pasted(kind):
    agent = load_autopilot()
    agent.desktop_send_ready.return_value = (False, "企微窗口不可用")
    store = MagicMock()
    store.self_id.return_value = "account"

    status, detail = agent._send_dify_media(store, "S:contact", {"type": kind, "name": "asset"}, MagicMock())

    assert (status, detail) == ("blocked", "企微窗口不可用")
    agent.core_send.paste_media.assert_not_called()


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


def test_faq_plan_confirms_text_and_holds_media_without_verified_recipient(monkeypatch):
    agent = load_autopilot()
    send_text = MagicMock(return_value=("sent", "readback", "id"))
    send_media = MagicMock(return_value=("sent", "readback"))
    monkeypatch.setattr(agent, "_sequence_block_reason", lambda *args: "")
    monkeypatch.setattr(agent, "_send_text", send_text)
    monkeypatch.setattr(agent, "_send_agent_media", send_media)
    plan = [{"type": "text", "content": "现场图", "delay_ms": 0},
            {"type": "image", "name": "a.png", "delay_ms": 1000},
            {"type": "video", "name": "b.mp4", "delay_ms": 1000}]
    status, detail, count = agent._send_faq_plan(MagicMock(), {}, "候选人", "S:contact", plan, MagicMock())
    assert send_text.call_args.args[2] == "S:contact"
    assert (status, count) == ("blocked", 1)
    assert "文字已回读；图片、视频待核验" in detail
    send_media.assert_not_called()

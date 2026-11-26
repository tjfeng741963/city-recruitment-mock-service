from hashlib import sha256
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


def test_faq_client_revalidates_bound_asset_even_when_cached():
    load_autopilot()
    from brain import Brain

    client = MagicMock(device_code="test-device")
    client._post.side_effect = [{"ok": True}, RuntimeError("HTTP 409")]
    for allowed in (True, False):
        assert Brain.authorize_faq_media(client, "trace", "S:self_contact", "fixture.png") is allowed
        client._post.assert_called_with("/api/v1/agent/faq-media/validate", {
            "device_code": "test-device", "trace_id": "trace",
            "session_key": "S:self_contact", "name": "fixture.png",
        }, timeout=5)


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
    status, detail, count = agent._send_faq_plan(
        MagicMock(), {}, "候选人", "S:contact", plan, MagicMock(), authorize_asset=lambda _: True,
    )
    assert send_text.call_args.args[2] == "S:contact"
    assert (status, count) == ("blocked", 1)
    assert "无法核对" in detail
    send_media.assert_not_called()


def test_faq_group_keeps_text_without_attempting_media(monkeypatch):
    agent = load_autopilot()
    send_text = MagicMock(return_value=("sent", "readback", "id"))
    monkeypatch.setattr(agent, "_sequence_block_reason", lambda *args: "")
    monkeypatch.setattr(agent, "_send_text", send_text)
    plan = [{"type": "text", "content": "岗位说明", "delay_ms": 0},
            {"type": "image", "name": "a.png", "delay_ms": 1000}]
    status, _, count = agent._send_faq_plan(
        MagicMock(), {}, "群聊", "R:room", plan, MagicMock(), authorize_asset=lambda _: True,
    )
    assert (status, count) == ("blocked", 1)
    assert send_text.call_args.kwargs["require_recipient"] is False
    agent.core_send.paste_media.assert_not_called()


def test_faq_text_builds_recipient_proof_even_without_optional_desktop_guard(monkeypatch):
    agent = load_autopilot()
    store = MagicMock()
    store.self_id.return_value = "self"
    cid = "S:self_contact"
    heading = (7, b"contact")
    monkeypatch.setattr(agent, "_resolve_recipient", lambda *_: ("收件人", ""))
    monkeypatch.setattr(agent, "_recipient_heading", lambda: heading)
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda *_: "收件人")
    monkeypatch.setattr(agent, "_outbound_snapshot", MagicMock(side_effect=[{}, {"42": "回答"}]))
    def send(_store, name, body, *, expect_id, verify_db, log):
        assert (name, body, expect_id, verify_db) == ("收件人", "回答", cid, True)
        log("步骤0 前台就位")
        agent.win.tap("enter")
        log("步骤1 进入会话")
        log("步骤3 输入框校验")
        agent.win.tap("enter")
        return {"ok": True, "conversation_id": cid}
    agent.core_send.send.side_effect = send
    result = agent._send_text(store, "旧名字", cid, "回答", route="auto", log_fn=MagicMock(), require_recipient=True)
    assert result[0] == "sent"
    assert agent._recipient_proof == (cid, heading)


@pytest.mark.parametrize("interrupt", ["", "takeover", "account", "source", "binding", "heading",
                                       "download", "corrupt", "revoked", "readback"])
def test_faq_runs_guarded_media_in_server_order(tmp_path, monkeypatch, interrupt):
    agent = load_autopilot()
    cid, name = "S:self_contact", "候选人"
    store = MagicMock()
    store.self_id.return_value = "self"
    heading = (1, b"contact")
    calls = []
    change = {}
    check = lambda *_: "接管" if change.get("takeover") else ""
    monkeypatch.setattr(agent, "_sequence_block_reason", check)
    monkeypatch.setattr(agent, "_reply_source_identity", lambda: (change.get("source"),))
    monkeypatch.setattr(agent, "_recipient_heading", lambda: change.get("heading", heading))
    monkeypatch.setattr(agent, "_recipient_binding_enabled", interrupt == "binding")
    monkeypatch.setattr(agent.remote_cfg, "recipient_binding_account_active", lambda _: True)
    monkeypatch.setattr(agent.remote_cfg, "recipient_bindings", lambda _: {
        cid: {"status": "verified", "remark": change.get("binding", "original")},
    })
    def send_text(*args, **kwargs):
        assert kwargs["require_recipient"] is True
        agent._recipient_proof = (cid, heading)
        calls.append("text")
        return "sent", "readback", "id"
    monkeypatch.setattr(agent, "_send_text", send_text)

    def wait(seconds):
        calls.append(seconds)
        if interrupt in ("takeover", "account", "source", "binding", "heading"):
            change[interrupt] = (2, b"other") if interrupt == "heading" else "other"
        if interrupt == "account":
            store.self_id.return_value = "other"
    monkeypatch.setattr(agent.time, "sleep", wait)

    plan = [{"type": "text", "content": "现场图", "delay_ms": 0}]
    for index, (kind, ext) in enumerate([("image", "png"), ("video", "mp4")], 1):
        data = kind.encode()
        filename = f"dify-asset-{index}-{sha256(data).hexdigest()}.{ext}"
        (tmp_path / filename).write_bytes(b"wrong" if interrupt == "corrupt" else data)
        plan.append({"type": kind, "name": filename, "delay_ms": index * 1000})
    monkeypatch.setattr(agent.media_fetch, "local_file", lambda filename: tmp_path / filename)
    def fetch(filename, kind, **kwargs):
        calls.append("download:" + kind)
        return interrupt != "download", "missing"
    monkeypatch.setattr(agent.media_fetch, "ensure_media", fetch)
    def send_media(store, target, filename, kind, log, *, route, authorize):
        assert target == cid and route == "faq" and authorize()
        calls.append(kind)
        return ("unknown", "readback missing") if interrupt == "readback" and kind == "video" else ("sent", "readback")
    monkeypatch.setattr(agent, "_send_agent_media", send_media)
    authorize_asset = MagicMock(return_value=interrupt != "revoked")
    status, _, count = agent._send_faq_plan(store, {}, name, cid, plan, MagicMock(), authorize_asset=authorize_asset)
    if interrupt in ("takeover", "account", "source", "binding", "heading"):
        assert (status, count, calls) == ("blocked", 1, ["text", 1])
    elif interrupt in ("download", "corrupt"):
        assert (status, count, calls) == ("failed", 1, ["text", 1, "download:图片"])
    elif interrupt == "revoked":
        assert (status, count, calls) == ("blocked", 1, ["text", 1, "download:图片"])
        authorize_asset.assert_called_once_with(plan[1]["name"])
    else:
        assert (status, count) == (("unknown", 2) if interrupt == "readback" else ("sent", 3))
        assert calls == ["text", 1, "download:图片", "image", 2, "download:视频", "video"]
        assert [call.args[0] for call in authorize_asset.call_args_list] == [step["name"] for step in plan[1:]]


@pytest.mark.parametrize("change_at", ["paste", "enter"])
def test_faq_media_veto_checks_existing_keys_without_extra_input(monkeypatch, change_at):
    agent = load_autopilot()
    keys = MagicMock()
    paste = MagicMock()
    monkeypatch.setattr(agent.win, "tap", keys, raising=False)
    monkeypatch.setattr(agent.win, "hotkey", paste, raising=False)

    ready = True
    def sender(*_args, **_kwargs):
        nonlocal ready
        try:
            ready = change_at != "paste"
            agent.win.hotkey("ctrl", "v")
            ready = False
            agent.win.tap("enter")
        except Exception:
            return False, "guard denied"
        return True, "unexpected"
    agent.core_send.paste_media.side_effect = sender
    status, _ = agent._send_media(MagicMock(), "S:self_contact", "test.png", MagicMock(),
                                  route="faq", authorize=lambda: ready)
    assert status == "blocked"
    assert paste.call_count == (0 if change_at == "paste" else 1)
    keys.assert_not_called()
    assert agent.win.tap is keys and agent.win.hotkey is paste

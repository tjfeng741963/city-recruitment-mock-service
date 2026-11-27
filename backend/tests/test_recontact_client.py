from unittest.mock import MagicMock
from hashlib import sha256
import json

import pytest

from tests.agent_loader import load_autopilot, load_reply_store


CID = "S:self_candidate"
INBOUND = 1_800_000_000_000
LOCATION = "面试点：广州\nhttps://uri.amap.com/marker?position=113.4,23.1"


@pytest.fixture
def setup(tmp_path, monkeypatch):
    agent = load_autopilot()
    agent.original_send_text = agent._send_text
    agent.rlog = load_reply_store(tmp_path / "reply_log.db")
    store = MagicMock()
    store.self_id.return_value = "self"
    store.data_dir = tmp_path
    monkeypatch.setattr(agent, "find_data_dir", MagicMock(return_value=tmp_path))
    command = {
        "kind": "recontact", "id": "recontact-1", "lease_token": "lease-1",
        "lease_until": 4_102_444_800_000, "contact_id": CID, "nickname": "嘉宝",
        "content": LOCATION, "recontact_kind": "location", "recontact_account_id": "self",
        "recontact_inbound_before_ms": INBOUND,
    }
    bridge = agent.agent_client.BridgeClient("https://bridge.example", "test-token", "dev-01")

    def request(method, path, body):
        assert method == "POST"
        if path.endswith("/claim?recontact=1"):
            return {"command": command}
        if path.endswith("/recontact-check"):
            assert body == {"command_id": command["id"], "lease_token": command["lease_token"]}
            return {"ok": True}
        if path.endswith("/receipts"):
            return {"ok": True}
        pytest.fail(f"Unexpected bridge operation {path}")

    monkeypatch.setattr(bridge, "_request", MagicMock(side_effect=request))
    monkeypatch.setattr(agent, "_recontact_latest_inbound", MagicMock(return_value=(INBOUND,"1")))
    monkeypatch.setattr(agent, "_send_text", MagicMock(return_value=("sent", "已回读", CID + ":11")))
    monkeypatch.setattr(agent.compat, "wait_clipboard_writable", MagicMock(return_value=True))
    monkeypatch.setattr(agent.core_send, "paste_media", MagicMock(return_value=(True, "已回读")))
    return agent, store, bridge, command


def assert_receipt(bridge, status, message_id="", reason=""):
    receipts = [call.args[2] for call in bridge._request.call_args_list if call.args[1].endswith("/receipts")]
    assert len(receipts) == 1
    result = receipts[0]
    assert (result["status"], result["message_id"]) == (status, message_id)
    assert reason in result["error"]


def test_location_uses_text_sender_and_confirmed_target_receipt(setup):
    agent, store, bridge, command = setup
    assert agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)["sent"] == 1
    assert_receipt(bridge, "succeeded", CID + ":11")
    args, kwargs = agent._send_text.call_args
    assert args == (store, "嘉宝", CID, command["content"])
    assert kwargs["require_recipient"] is True
    assert kwargs["authorize"]()
    agent.core_send.split_media_marks.assert_not_called()


def test_same_second_new_local_reply_stops_recontact(setup):
    agent, store, bridge, command = setup
    encoded = json.dumps([bridge.device_code, CID + ":1"], separators=(",", ":")).encode()
    command["recontact_inbound_source"] = "bridge-inbound:" + sha256(encoded).hexdigest()
    agent._recontact_latest_inbound.return_value = (INBOUND, "2")
    assert agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)["failed"] == 1
    assert_receipt(bridge, "failed", reason="来信已变化")
    agent._send_text.assert_not_called()


@pytest.mark.parametrize("revocation", ["account", "directory", "new_reply", "server"])
def test_recontact_never_sends_after_recipient_or_authorization_changes(setup, revocation):
    agent, store, bridge, command = setup
    if revocation == "account":
        command["recontact_account_id"] = "old-account"
    elif revocation == "directory":
        agent.find_data_dir.return_value = store.data_dir / "other"
    elif revocation == "new_reply":
        agent._recontact_latest_inbound.return_value = (INBOUND + 1000,"2")
    else:
        original = bridge._request.side_effect
        bridge._request.side_effect = lambda *args: {"ok": False} if args[1].endswith("/recontact-check") else original(*args)
    assert agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)["failed"] == 1
    assert_receipt(bridge, "failed", reason={"account": "账号", "directory": "账号", "new_reply": "回复", "server": "授权"}[revocation])
    agent._send_text.assert_not_called()
    agent.core_send.paste_media.assert_not_called()


@pytest.mark.parametrize("correct_heading", [True, False])
def test_media_requires_a_verified_current_chat_and_a_unique_media_id(setup, tmp_path, monkeypatch, correct_heading):
    agent, store, bridge, command = setup
    item = tmp_path / "clip.mp4"
    item.write_bytes(b"demo")
    command["content"] = "dify-asset-1-" + agent.sha256(item.read_bytes()).hexdigest() + ".mp4"
    command["recontact_kind"] = "video"
    monkeypatch.setattr(agent.media_fetch, "ensure_media", MagicMock(return_value=(True, "")))
    monkeypatch.setattr(agent.media_fetch, "local_file", MagicMock(return_value=item))
    monkeypatch.setattr(agent, "_recipient_binding_enabled", False)
    monkeypatch.setattr(agent, "_recipient_heading", MagicMock(return_value=(1, b"chat")))
    monkeypatch.setattr(agent, "_resolve_recipient", MagicMock(return_value=("嘉宝", "")))
    monkeypatch.setattr(agent, "_recognize_recipient_heading", MagicMock(return_value="嘉宝" if correct_heading else "别人"))
    monkeypatch.setattr(agent, "_media_outbound_snapshot", MagicMock(side_effect=[{"10"}, {"10", "12"}]))
    stats = agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)
    assert stats["sent"] == int(correct_heading)
    if correct_heading:
        assert_receipt(bridge, "succeeded", CID + ":12")
        agent.core_send.paste_media.assert_called_once()
    else:
        assert_receipt(bridge, "failed", reason="收件人")
        agent.core_send.paste_media.assert_not_called()
        assert agent._send_text.call_args.kwargs["open_only"] is True


@pytest.mark.parametrize("search_matches", [True, False])
def test_media_can_open_the_verified_chat_without_sending_navigation_text(setup, tmp_path, monkeypatch, search_matches):
    agent, store, bridge, command = setup
    item = tmp_path / "picture.png"
    item.write_bytes(b"demo")
    command["content"] = "dify-asset-1-" + agent.sha256(item.read_bytes()).hexdigest() + ".png"
    command["recontact_kind"] = "image"
    monkeypatch.setattr(agent.media_fetch, "ensure_media", MagicMock(return_value=(True, "")))
    monkeypatch.setattr(agent.media_fetch, "local_file", MagicMock(return_value=item))
    monkeypatch.setattr(agent, "_send_text", agent.original_send_text)
    monkeypatch.setattr(agent, "_recipient_binding_enabled", False)
    monkeypatch.setattr(agent, "_resolve_recipient", MagicMock(return_value=("嘉宝", "")))
    search = (1, b"typed-search")
    old_chat = (1, b"old-chat", b"")
    expected_chat = (1, b"expected-chat", b"")
    monkeypatch.setattr(agent, "_recipient_search_field", MagicMock(side_effect=[(1, b"before"), search, search]))
    monkeypatch.setattr(agent, "_recipient_heading", MagicMock(side_effect=[old_chat, *[expected_chat] * 5]))
    monkeypatch.setattr(agent, "_recognize_recipient_heading", lambda frame, _: (
        "嘉宝" if frame == expected_chat or (search_matches and frame == search) else "别人"
    ))
    monkeypatch.setattr(agent, "_media_outbound_snapshot", MagicMock(side_effect=[set(), {"12"}]))
    input_events = MagicMock()
    monkeypatch.setattr(agent.win, "tap", input_events)

    def open_without_sending(active_store, name, content, *, log, dry, verify_db, **options):
        assert dry is True and verify_db is False
        log("步骤0 前台就位")
        agent.win.tap("enter")
        log("步骤1 已进入会话")
        return {"ok": True, "detail": "DRY-RUN"}

    agent.core_send.send.side_effect = open_without_sending
    stats = agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)
    assert stats["sent"] == int(search_matches)
    if search_matches:
        assert_receipt(bridge, "succeeded", CID + ":12")
        input_events.assert_called_once_with("enter")
        agent.core_send.paste_media.assert_called_once()
    else:
        assert_receipt(bridge, "failed", reason="会话")
        input_events.assert_not_called()
        agent.core_send.paste_media.assert_not_called()


def test_failure_reason_survives_a_lost_receipt_response(setup):
    agent, store, bridge, command = setup
    command["recontact_account_id"] = "old-account"
    original = bridge._request.side_effect

    def lose_receipt(*args):
        if args[1].endswith("/receipts"):
            raise TimeoutError("offline")
        return original(*args)

    bridge._request.side_effect = lose_receipt
    assert agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)["failed"] == 1
    bridge._request.reset_mock()
    bridge._request.side_effect = original
    assert agent.flush_manual_receipts(bridge, force=True)
    assert_receipt(bridge, "failed", reason="账号")


def test_inbound_arriving_during_chat_selection_vetoes_final_enter(setup, monkeypatch):
    agent, store, bridge, _ = setup
    monkeypatch.setattr(agent, "_send_text", agent.original_send_text)
    monkeypatch.setattr(agent, "_resolve_recipient", MagicMock(return_value=("嘉宝", "")))
    monkeypatch.setattr(agent, "_recipient_heading", MagicMock(return_value=(1, b"chat", b"chat")))
    monkeypatch.setattr(agent, "_recognize_recipient_heading", MagicMock(return_value="嘉宝"))
    monkeypatch.setattr(agent, "_outbound_snapshot", MagicMock(return_value={}))
    input_events = MagicMock()
    monkeypatch.setattr(agent.win, "tap", input_events)
    monkeypatch.setattr(agent, "wal_signature", MagicMock(side_effect=[("before",), ("before",), ("after",)]))
    agent._recontact_latest_inbound.side_effect = [(INBOUND, "1"), (INBOUND + 1000, "2")]

    def select_and_send(active_store, name, content, *, log, **options):
        log("步骤0 前台就位")
        agent.win.tap("enter")
        log("步骤1 已进入会话")
        log("步骤3 输入校验通过")
        agent.win.tap("enter")
        pytest.fail("Final Enter must be vetoed")

    agent.core_send.send.side_effect = select_and_send
    assert agent.pump_commands(store, {"cooldown": 0}, bridge=bridge)["failed"] == 1
    assert_receipt(bridge, "failed", reason="候选人已回复")
    input_events.assert_called_once_with("enter")

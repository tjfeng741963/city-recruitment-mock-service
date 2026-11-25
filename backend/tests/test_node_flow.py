"""Workflow orchestration regression tests; every desktop input API is stubbed."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store, stub_text_readback


FLOW = {
    "position_id": 1, "version": 1, "status": "enabled", "entry_key": "qualify",
    "nodes": [
        {"node_key": "qualify", "node_type": "text", "parts": [{"kind": "text", "body": "先看要求", "delay_ms": 0}], "await_reply": True, "wait_minutes": 2},
        {"node_key": "wage", "node_type": "text", "parts": [{"kind": "text", "body": "岗位薪资", "delay_ms": 0}], "await_reply": True, "wait_minutes": 15},
        {"node_key": "followup", "node_type": "followup", "parts": [{"kind": "text", "body": "看明白了吗？", "delay_ms": 0}]},
        {"node_key": "end", "node_type": "end", "parts": []},
    ],
    "edges": [
        {"from_key": "qualify", "to_key": "wage", "trigger": "any_reply"},
        {"from_key": "qualify", "to_key": "followup", "trigger": "timeout"},
        {"from_key": "wage", "to_key": "end", "trigger": "any_reply"},
        {"from_key": "followup", "to_key": "end", "trigger": "default"},
    ],
}
CFG = {"cooldown": 0, "device_code": "pc", "dry_run": False}


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    stub_text_readback(module, monkeypatch)
    monkeypatch.setattr(module, "_media_outbound_snapshot", lambda *args: {
        str(i) for i in range(module.core_send.paste_media.call_count)
    })
    module._brain = MagicMock()
    module._brain.flow.return_value = json.loads(json.dumps(FLOW))
    module._brain.chat.return_value = {"ok": True, "reply": "这是答疑", "parts": ["这是答疑"], "medias": []}
    module._flow_state = module.flow_state_mod.FlowState(tmp_path / "flow_state.db", now=lambda: module.time.time())
    module._last_reply_at = module._last_flow_followup_at = 0
    module._consecutive_send_failures = 0
    monkeypatch.setattr(module, "GREET_STATE", tmp_path / ".greeted.json")
    monkeypatch.setattr(module, "log", MagicMock())
    monkeypatch.setattr(module, "rlog", load_reply_store(tmp_path / "reply.db"))
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    monkeypatch.setattr(module.remote_cfg, "takeover_sessions", lambda: set())
    monkeypatch.setattr(module.remote_cfg, "abandoned_sessions", lambda: set())
    module.core_send.send.return_value = {"ok": True, "conversation_id": "S:customer", "detail": "已发送并回读确认"}
    module.media_fetch.ensure_media = MagicMock(return_value=(True, "ready"))
    return module


def incoming(agent, mid=1, text="你好"):
    agent.rlog.record_incoming({"id": mid, "conv_id": "S:customer", "conv_name": "Customer", "text": text, "type": 2, "time": 100})


def start(agent):
    incoming(agent)
    agent.drain(MagicMock(), CFG)


def test_first_contact_and_reply_each_have_one_output_without_chat(agent):
    start(agent)
    assert agent._flow_state.get("S:customer")["phase"] == "awaiting"
    assert agent._flow_state.get("S:customer")["wait_minutes"] == 2
    assert agent.core_send.send.call_count == 1
    incoming(agent, 2, "可以")  # same second, different message ID must be processed
    agent.drain(MagicMock(), CFG)
    assert agent.core_send.send.call_count == 2
    assert agent.core_send.send.call_args.args[2] == "岗位薪资"
    assert agent._flow_state.get("S:customer")["node_key"] == "wage"
    agent._brain.chat.assert_not_called()


@pytest.mark.parametrize("result", ["sent", "unknown", "taken_over"])
def test_location_link_waits_and_uses_expected_text_recipient(agent, monkeypatch, result):
    address = "南门面试点：南路1号\n导航：https://uri.amap.com/marker?position=113.39,23.11"
    flow = json.loads(json.dumps(FLOW))
    flow["nodes"][0]["parts"] = [
        {"kind": "favorite_location", "body": address, "delay_before_ms": 3500, "delay_ms": 700},
        {"kind": "text", "body": "到了联系我", "delay_ms": 0},
    ]
    events = []
    takeover = set()

    def sleep(seconds):
        events.append(seconds)
        if seconds == 3.5 and result == "taken_over":
            takeover.add("S:customer")

    monkeypatch.setattr(agent.time, "sleep", sleep)
    monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", lambda: takeover)
    def send_text(store, name, cid, body, **kwargs):
        assert name == "Customer" and cid == "S:customer"
        events.append(body)
        return ("unknown", "未回读到发送结果", "") if result == "unknown" else ("sent", "已回读", "")

    sender = MagicMock(side_effect=send_text)
    monkeypatch.setattr(agent, "_send_text", sender)
    agent._flow_state.upsert("S:customer", device_code="pc", position_id=1, flow_version=1,
                            node_key="qualify", phase="running", conv_name="Customer", snapshot_json=json.dumps(flow))

    phase = agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", flow, node_key="qualify")
    outbox = agent._flow_state.outbox("S:customer", "qualify")
    if result == "sent":
        assert phase == "awaiting"
        assert [row["status"] for row in outbox] == ["sent", "sent"]
        assert events.index(3.5) < events.index(address) < events.index(0.7) < events.index("到了联系我")
    elif result == "taken_over":
        assert phase == "held"
        sender.assert_not_called()
    else:
        assert phase == "held"
        assert [row["status"] for row in outbox] == ["unknown"]
        sender.assert_called_once()


def test_system_event_does_not_open_gate_and_completed_flow_does_not_replay_opening(agent):
    start(agent)
    incoming(agent, 2, "")
    agent.drain(MagicMock(), CFG)
    assert agent.core_send.send.call_count == 1
    incoming(agent, 3, "好")
    agent.drain(MagicMock(), CFG)
    incoming(agent, 4, "好")
    agent.drain(MagicMock(), CFG)
    assert agent._flow_state.get("S:customer")["phase"] == "expired"
    incoming(agent, 5, "包住吗")
    agent.drain(MagicMock(), CFG)
    agent._brain.opening.assert_not_called()
    assert agent._brain.chat.call_args.kwargs["sent_summary"] == ["先看要求", "岗位薪资"]


def test_terminal_wait_reply_is_handed_to_ai_on_the_same_message(agent):
    terminal_flow = json.loads(json.dumps(FLOW))
    terminal_flow["edges"][2]["to_key"] = ""
    agent._brain.flow.return_value = terminal_flow
    start(agent)
    incoming(agent, 2, "符合")
    agent.drain(MagicMock(), CFG)
    assert agent._flow_state.get("S:customer")["node_key"] == "wage"

    incoming(agent, 3, "工资多少")
    agent.drain(MagicMock(), CFG)

    agent._brain.chat.assert_called_once()
    assert agent._brain.chat.call_args.args[0] == "工资多少"
    assert agent._brain.chat.call_args.kwargs["sent_summary"] == ["先看要求", "岗位薪资"]
    assert agent.core_send.send.call_count == 3
    assert agent.core_send.send.call_args.args[2] == "这是答疑"


def test_existing_contacts_stay_in_normal_chat(agent, monkeypatch):
    monkeypatch.setattr(agent, "_is_first_contact", lambda cid, seen: False)
    incoming(agent)
    agent.drain(MagicMock(), CFG)
    agent._brain.chat.assert_called_once()
    assert agent._flow_state.get("S:customer") is None


def test_legacy_first_contact_waits_for_the_next_message_before_chat(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "旧开场介绍", "media_name": "", "delay_ms": 2000}
    ]}
    def generate(hint, cid, **kwargs):
        assert agent.core_send.send.call_args.args[2] == "旧开场介绍"
        return {"ok": True, "reply": "这是答疑"}

    agent._brain.chat.side_effect = generate
    start(agent)
    # 开场播完就停，等客户下一条（2026-11-25 确认：不再补一条首句回复）
    agent._brain.chat.assert_not_called()
    assert agent.core_send.send.call_args.args[2] == "旧开场介绍"
    agent._brain.chat.reset_mock(side_effect=True)
    incoming(agent, 2, "工资多少")
    agent.drain(MagicMock(), CFG)
    agent._brain.chat.assert_called_once_with("工资多少", "S:customer", sent_summary=None)
    assert agent.core_send.send.call_args.args[2] == "这是答疑"


def test_verified_legacy_opening_clears_the_previous_send_error(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "欢迎", "delay_ms": 0},
    ]}
    agent._consecutive_send_failures = 2
    agent._last_error = "输入框校验失败"

    start(agent)

    agent._brain.log_receipt.assert_called_once_with("S:customer", 1, "text", "sent")
    assert agent._consecutive_send_failures == 0
    assert agent._last_error == ""


def test_hidden_window_keeps_opening_pending_until_the_window_recovers(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "欢迎", "delay_ms": 0},
    ]}
    agent.desktop_send_ready.return_value = (False, "企微窗口不可用")
    incoming(agent)

    assert agent.drain(MagicMock(), CFG)["blocked"] == 1
    assert agent.rlog.recent()[0]["status"] == "pending"
    agent.core_send.send.assert_not_called()

    agent.desktop_send_ready.return_value = (True, "")
    agent.drain(MagicMock(), CFG)
    agent.core_send.send.assert_called_once()


@pytest.mark.parametrize("kind", ["image", "video"])
def test_window_change_after_verified_opening_text_stops_remaining_parts(agent, kind):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "欢迎", "delay_ms": 0},
        {"seq": 2, "kind": kind, "media_name": "asset", "delay_ms": 0},
        {"seq": 3, "kind": "text", "content": "请问想去哪个城市？", "delay_ms": 0},
    ]}
    agent.desktop_send_ready.side_effect = [(True, ""), (True, ""), (False, "企微窗口不可用")]

    incoming(agent)
    assert agent.drain(MagicMock(), CFG)["skipped"] == 1
    rows = {row["message_id"]: row for row in agent.rlog.recent()}
    assert rows["1"]["status"] == "skipped"
    assert not agent.rlog.has_unconfirmed_opening("S:customer")
    assert [call.args[3] for call in agent._brain.log_receipt.call_args_list] == ["sent", "failed"]
    agent.core_send.send.assert_called_once()
    agent.core_send.paste_media.assert_not_called()
    agent._brain.chat.assert_not_called()


def test_unconfirmed_legacy_opening_holds_even_when_another_message_arrives(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "欢迎", "delay_ms": 0},
        {"seq": 2, "kind": "image", "media_name": "sample.png", "delay_ms": 0},
    ]}
    agent.core_send.send.return_value = {"ok": True, "conversation_id": "", "detail": "库里还没读到"}
    incoming(agent)
    assert agent.drain(MagicMock(), CFG)["unknown"] == 1
    agent._brain.log_receipt.assert_called_once()
    assert agent._brain.log_receipt.call_args.args[3] == "failed"

    agent.rlog.init()
    incoming(agent, 2, "又发了一条")
    assert agent.drain(MagicMock(), CFG)["blocked"] == 1
    assert {row["message_id"]: row["status"] for row in agent.rlog.recent()} == {"1": "unknown", "2": "held"}
    agent.core_send.send.assert_called_once()
    agent.core_send.paste_media.assert_not_called()
    agent._brain.chat.assert_not_called()


def test_revoked_legacy_opening_holds_without_falling_back_to_ai(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": False, "blocked": True, "items": [], "detail": "设备鉴权失效"}
    incoming(agent)

    result = agent.drain(MagicMock(), CFG)

    assert result["blocked"] == 1
    agent._brain.chat.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "held"


def test_legacy_opening_initial_sync_pending_waits_before_opening_and_chat(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": False, "pending": True, "items": [], "detail": "配置尚未成功同步"}
    incoming(agent)
    result = agent.drain(MagicMock(), CFG)
    assert result["blocked"] == 1
    agent._brain.chat.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "pending"
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "配置同步后的欢迎", "media_name": "", "delay_ms": 0},
    ]}

    agent.drain(MagicMock(), CFG)

    # 开场只播清单，不补首句回复；客户下一条才进 chat
    agent._brain.chat.assert_not_called()
    assert agent.core_send.send.call_args_list[0].args[2] == "配置同步后的欢迎"


def test_flow_initial_sync_pending_never_falls_back_to_legacy_or_ai(agent):
    agent._brain.flow.return_value = {"ok": False, "pending": True, "nodes": [], "version": 0}
    incoming(agent)
    assert agent.drain(MagicMock(), CFG)["blocked"] == 1
    agent._brain.opening.assert_not_called()
    agent._brain.chat.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert agent.rlog.recent()[0]["status"] == "pending"


def test_legacy_welcome_keeps_one_snapshot_when_cached_opening_changes_mid_send(agent):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    shared = {"ok": True, "items": [
        {"seq": 1, "kind": "text", "content": "旧首句", "media_name": "", "delay_ms": 0},
        {"seq": 2, "kind": "text", "content": "旧第二句", "media_name": "", "delay_ms": 0},
    ]}
    agent._brain.opening.return_value = shared
    sent = []
    def send(store, name, body, **kwargs):
        sent.append(body)
        shared["items"][1]["content"] = "新第二句"
        return {"ok": True, "conversation_id": "S:customer", "detail": "sent"}
    agent.core_send.send.side_effect = send

    start(agent)

    assert sent == ["旧首句", "旧第二句"]


@pytest.mark.parametrize("kind", ["text", "image", "video"])
def test_legacy_opening_waits_each_configured_delay_after_success(agent, monkeypatch, kind):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": kind, "content": "开场文本", "media_name": "test.png", "delay_ms": 3500},
    ]}
    if kind != "text":
        agent._brain.opening.return_value["items"].insert(0,
            {"seq": 0, "kind": "text", "content": "确认目标", "delay_ms": 0})
    waits = []
    agent.core_send.paste_media.return_value = (True, "sent")
    monkeypatch.setattr(agent.time, "sleep", waits.append)

    start(agent)

    assert waits == ([3.5] if kind == "text" else [0.0, 3.5])
    if kind == "text":
        agent.core_send.send.assert_called_once()
    else:
        agent.core_send.paste_media.assert_called_once()


@pytest.mark.parametrize("kind", ["text", "image", "video"])
def test_failed_legacy_opening_does_not_add_success_delay_or_retry(agent, monkeypatch, kind):
    agent._brain.flow.return_value = {"nodes": [], "version": 0}
    agent._brain.opening.return_value = {"ok": True, "items": [
        {"seq": 1, "kind": kind, "content": "开场文本", "media_name": "test.png", "delay_ms": 3500},
    ]}
    agent.core_send.send.return_value = {"ok": False, "detail": "failed"}
    if kind != "text":
        agent._brain.opening.return_value["items"].insert(0,
            {"seq": 0, "kind": "text", "content": "确认目标", "delay_ms": 0})
        agent.core_send.send.return_value = {"ok": True, "conversation_id": "S:customer"}
    agent.core_send.paste_media.return_value = (False, "failed")
    waits = []
    monkeypatch.setattr(agent.time, "sleep", waits.append)

    start(agent)

    assert waits == ([] if kind == "text" else [0.0])
    if kind == "text":
        agent.core_send.send.assert_called_once()
    else:
        agent.core_send.paste_media.assert_called_once()


@pytest.mark.parametrize("result,status", [
    ({"ok": False, "detail": "发到了别的会话"}, "failed"),
    ({"ok": True, "detail": "回读失败", "conversation_id": ""}, "unknown"),
])
def test_failed_or_unconfirmed_delivery_holds_without_advancing(agent, result, status):
    agent.core_send.send.return_value = result
    start(agent)
    assert agent._flow_state.get("S:customer")["phase"] == "held"
    assert agent._flow_state.outbox("S:customer")[0]["status"] == status
    incoming(agent, 2, "多少钱")
    agent.drain(MagicMock(), CFG)
    assert agent.core_send.send.call_count == 1
    agent._brain.chat.assert_not_called()


def test_sent_part_does_not_replay_but_unknown_part_never_skips_forward(agent):
    state = agent._flow_state
    state.upsert("S:customer", node_key="qualify", phase="running")
    state.claim_step("S:customer", "qualify", 0, body="先看要求")
    assert agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", FLOW, node_key="qualify") == "held"
    agent.core_send.send.assert_not_called()
    # An operator confirmed the result; reopening the state leaves the outbox intact.
    state.mark_outbox("S:customer", "qualify", 0, "sent")
    assert agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", FLOW, node_key="qualify") == "awaiting"
    assert state.get("S:customer")["step_index"] == 1
    agent.core_send.send.assert_not_called()


def test_old_snapshot_wins_and_disabled_latest_flow_does_not_break_active_chat(agent):
    start(agent)
    agent._brain.flow.return_value = {"version": 2, "nodes": [], "edges": []}
    incoming(agent, 2, "符合")
    agent.drain(MagicMock(), CFG)
    assert agent.core_send.send.call_args.args[2] == "岗位薪资"
    assert agent._flow_state.get("S:customer")["flow_version"] == 1


def test_disabled_flow_node_is_bypassed_without_sending_its_content(agent):
    state = MagicMock()
    state.claim_step.return_value = True
    agent._flow_store = lambda: state
    agent.core_send.send.return_value = {"ok": True, "conversation_id": "S:customer", "detail": "sent"}
    flow = {
        "nodes": [
            {"node_key": "skip", "node_type": "text", "status": "disabled", "await_reply": False,
             "parts": [{"kind": "text", "body": "停用节点内容", "delay_ms": 0}]},
            {"node_key": "active", "node_type": "text", "status": "enabled", "await_reply": True,
             "wait_minutes": 10, "parts": [{"kind": "text", "body": "启用节点内容", "delay_ms": 0}]},
            {"node_key": "end", "node_type": "end", "status": "enabled", "parts": []},
        ],
        "edges": [
            {"from_key": "skip", "to_key": "active", "trigger": "default"},
            {"from_key": "active", "to_key": "end", "trigger": "any_reply"},
        ],
    }

    result = agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", flow, node_key="skip")

    assert result == "awaiting"
    state.claim_step.assert_called_once_with("S:customer", "active", 0, body="启用节点内容", media_name="")
    assert agent.core_send.send.call_count == 1
    assert agent.core_send.send.call_args.args[2] == "启用节点内容"


def test_disabled_wait_node_bypasses_reply_and_never_fires_its_timeout(agent):
    state = MagicMock()
    state.claim_step.return_value = True
    agent._flow_store = lambda: state
    flow = {
        "nodes": [
            {"node_key": "skip_wait", "node_type": "text", "status": "disabled", "await_reply": True,
             "parts": [{"kind": "text", "body": "停用等待内容", "delay_ms": 0}]},
            {"node_key": "active", "node_type": "text", "status": "enabled", "await_reply": True,
             "parts": [{"kind": "text", "body": "回复后的内容", "delay_ms": 0}]},
            {"node_key": "followup", "node_type": "followup", "status": "disabled",
             "parts": [{"kind": "text", "body": "不应发送超时复聊", "delay_ms": 0}]},
            {"node_key": "end", "node_type": "end", "status": "enabled", "parts": []},
        ],
        "edges": [
            {"from_key": "skip_wait", "to_key": "active", "trigger": "any_reply"},
            {"from_key": "skip_wait", "to_key": "followup", "trigger": "timeout"},
            {"from_key": "active", "to_key": "end", "trigger": "any_reply"},
            {"from_key": "followup", "to_key": "end", "trigger": "default"},
        ],
    }

    result = agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", flow, node_key="skip_wait")

    assert result == "awaiting"
    state.claim_step.assert_called_once_with("S:customer", "active", 0, body="回复后的内容", media_name="")
    assert agent.core_send.send.call_args.args[2] == "回复后的内容"


def test_branch_uses_keyword_match_and_default_fallback(agent):
    state = MagicMock()
    state.claim_step.return_value = True
    agent._flow_store = lambda: state
    flow = {
        "nodes": [
            {"node_key": "branch", "node_type": "branch", "status": "enabled", "parts": []},
            {"node_key": "matched", "node_type": "text", "status": "enabled", "await_reply": True,
             "parts": [{"kind": "text", "body": "命中工资分支", "delay_ms": 0}]},
            {"node_key": "fallback", "node_type": "text", "status": "enabled", "await_reply": True,
             "parts": [{"kind": "text", "body": "默认分支", "delay_ms": 0}]},
            {"node_key": "end", "node_type": "end", "status": "enabled", "parts": []},
        ],
        "edges": [
            {"from_key": "branch", "to_key": "matched", "trigger": "keyword", "condition_value": "工资", "priority": 2},
            {"from_key": "branch", "to_key": "fallback", "trigger": "default", "condition_value": "", "priority": 0},
            {"from_key": "matched", "to_key": "end", "trigger": "any_reply"},
            {"from_key": "fallback", "to_key": "end", "trigger": "any_reply"},
        ],
    }

    matched = agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", flow, node_key="branch", hint="问下工资多少")
    assert matched == "awaiting"
    assert agent.core_send.send.call_args.args[2] == "命中工资分支"

    agent.core_send.send.reset_mock()
    fallback = agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", flow, node_key="branch", hint="想了解面试地址")
    assert fallback == "awaiting"
    assert agent.core_send.send.call_args.args[2] == "默认分支"


def test_followup_once_has_durable_rate_limit_and_failure_stays_held(agent, monkeypatch):
    now = datetime(2026, 11, 19, 4, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(agent.time, "time", lambda: now)
    start(agent)
    state = agent._flow_state
    state.set_phase("S:customer", "awaiting", await_since=now - 121)
    agent._flow_tick(MagicMock(), CFG, "online")
    assert state.get("S:customer")["phase"] == "followup_sent"
    assert state.get("S:customer")["followup_round"] == 1
    assert agent.core_send.send.call_count == 2
    agent._flow_tick(MagicMock(), CFG, "online")
    assert agent.core_send.send.call_count == 2
    now += 1801
    agent._flow_tick(MagicMock(), CFG, "online")
    assert state.get("S:customer")["phase"] == "expired"


def test_due_followup_remains_unclaimed_while_window_is_blocked(agent, monkeypatch):
    now = datetime(2026, 11, 19, 4, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(agent.time, "time", lambda: now)
    start(agent)
    state = agent._flow_state
    state.set_phase("S:customer", "awaiting", await_since=now - 121)
    agent.desktop_send_ready.return_value = (False, "企微窗口不可用")

    agent._flow_tick(MagicMock(), CFG, "online")
    assert state.get("S:customer")["phase"] == "awaiting"
    agent.core_send.send.assert_called_once()

    agent.desktop_send_ready.return_value = (True, "")
    agent._flow_tick(MagicMock(), CFG, "online")
    assert state.get("S:customer")["phase"] == "followup_sent"


def test_followup_failure_never_marked_sent(agent, monkeypatch):
    now = datetime(2026, 11, 19, 4, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(agent.time, "time", lambda: now)
    start(agent)
    agent._flow_state.set_phase("S:customer", "awaiting", await_since=now - 121)
    agent.core_send.send.return_value = {"ok": False, "detail": "没找到会话"}
    agent._flow_tick(MagicMock(), CFG, "online")
    assert agent._flow_state.get("S:customer")["phase"] == "held"
    assert agent._flow_state.get("S:customer")["followup_sent_at"] is None


@pytest.mark.parametrize("phase", ["running", "awaiting"])
def test_background_flow_waits_for_authorization_before_sending_snapshot(agent, monkeypatch, phase):
    now = datetime(2026, 11, 19, 4, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(agent.time, "time", lambda: now)
    start(agent)
    state = agent._flow_state
    state.set_phase("S:customer", phase, await_since=now - 121)
    agent.core_send.send.reset_mock()
    agent._brain.flow.return_value = {"ok": False, "blocked": True, "nodes": []}

    agent._flow_tick(MagicMock(), CFG, "online")

    agent.core_send.send.assert_not_called()
    assert state.get("S:customer")["phase"] == phase


def test_media_without_verified_text_never_pastes(agent):
    media_flow = {"nodes": [{"node_key": "photo", "parts": [{"kind": "image", "media_name": "宿舍.jpg"}]}], "edges": []}
    agent._flow_state.upsert("S:customer", node_key="photo", phase="running")
    assert agent._run_flow(MagicMock(), CFG, "S:customer", "Customer", media_flow, node_key="photo") == "held"
    agent.core_send.paste_media.assert_not_called()


@pytest.mark.parametrize("dry,online", [(True, "online"), (False, "offline")])
def test_followup_dry_and_offline_never_send(agent, dry, online):
    agent._flow_tick(MagicMock(), {**CFG, "dry_run": dry}, online)
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize("reason", ["quiet", "takeover", "abandoned"])
def test_followup_quiet_and_operator_controls_are_respected(agent, monkeypatch, reason):
    now = datetime(2026, 11, 19, 15 if reason == "quiet" else 4, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(agent.time, "time", lambda: now)
    start(agent)
    agent._flow_state.set_phase("S:customer", "awaiting", await_since=now - 121)
    if reason == "takeover":
        monkeypatch.setattr(agent.remote_cfg, "takeover_sessions", lambda: {"S:customer"})
    if reason == "abandoned":
        monkeypatch.setattr(agent.remote_cfg, "abandoned_sessions", lambda: {"S:customer"})
    agent._flow_tick(MagicMock(), CFG, "online")
    assert agent.core_send.send.call_count == 1
    assert agent._flow_state.get("S:customer")["phase"] == "awaiting"

def test_switch_keeps_old_snapshot_and_routes_new_message(agent):
    start(agent)
    prior = agent._flow_state.get("S:customer")
    assert prior["phase"] == "awaiting"
    agent._brain.reply_mode_generation = "new-mode"
    agent._brain.reply_provider = "dify"
    agent._brain.flow.return_value = {"nodes": [], "provider": "dify", "reply_mode_id": "new-mode"}
    agent._brain.chat.return_value = {"ok": True, "reply": "Dify reply", "parts": ["Dify reply"], "medias": []}
    agent.core_send.send.reset_mock()
    incoming(agent, 2, "问新的问题")
    result = agent.drain(MagicMock(), CFG)
    assert result["sent"] == 1
    agent._brain.chat.assert_called_once()
    assert agent.core_send.send.call_args.args[2] == "Dify reply"
    after = agent._flow_state.get("S:customer")
    assert after["phase"] == "held"
    assert after["snapshot_json"] == prior["snapshot_json"]

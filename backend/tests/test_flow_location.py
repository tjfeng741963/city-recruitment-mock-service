"""Navigation links keep the saved location and conversation during upgrades."""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot

CARD = {"name": "南门面试点", "address": "兴业路东门", "lng": 113.39114, "lat": 23.117692}
LINK = "南门面试点：兴业路东门\n导航：https://uri.amap.com/marker?position=113.39114,23.117692"
CID = "S:me_customer"


@pytest.mark.parametrize("point, expected_status", [(CARD, "sent"), ({**CARD, "lat": False}, "failed")])
def test_existing_native_snapshot_sends_only_a_verified_navigation_text(tmp_path, monkeypatch, point, expected_status):
    agent = load_autopilot()
    agent._brain = None
    agent._last_reply_at = agent._consecutive_send_failures = 0
    agent._flow_state = agent.flow_state_mod.FlowState(tmp_path / "flow.db")
    monkeypatch.setattr(agent.time, "sleep", lambda _: None)
    monkeypatch.setattr(agent, "_sequence_block_reason", lambda *args: "")
    sender = MagicMock(return_value=("sent", "已回读", "message-id"))
    monkeypatch.setattr(agent, "_send_text", sender)
    native = MagicMock()
    monkeypatch.setattr(agent.location_card, "send_card", native)
    # This is the shape persisted by the native-card client before the upgrade.
    flow = {"position_id": 1, "version": 1, "entry_key": "intro", "status": "enabled", "location_steps": 1,
            "edges": [], "nodes": [{"node_key": "intro", "parts": [
                {"kind": "favorite_location", "interview_point": CARD["name"], "location": point, "delay_ms": 0}
            ]}]}
    agent._flow_state.upsert(CID, node_key="intro", phase="running", snapshot_json=json.dumps(flow))
    store = MagicMock()
    phase = agent._run_flow(store, {"cooldown": 0}, CID, "Customer", flow, node_key="intro")
    native.assert_not_called()
    if expected_status == "sent":
        assert phase == "expired"
        assert sender.call_args.args == (store, "Customer", CID, LINK)
    else:
        assert phase == "held"
        sender.assert_not_called()
    assert [part["status"] for part in agent._flow_state.outbox(CID)] == [expected_status]


def test_existing_conversation_preserves_its_flow_before_location_upgrade():
    agent = load_autopilot()
    agent._brain = MagicMock(location_steps=1, reply_mode_generation="")
    existing = {"nodes": [{"node_key": "intro", "parts": [{"kind": "text", "body": "先看地址"}]}]}
    updated = {**existing, "location_steps": 1}
    assert agent._flow_for_row({"snapshot_json": json.dumps(existing)}, updated) == existing

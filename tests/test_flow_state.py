from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from flow_state import FlowState  # noqa: E402


def test_claim_step_is_idempotent_and_cursor_survives_restart(tmp_path):
    path = tmp_path / "state" / "flow_state.db"
    state = FlowState(path, now=lambda: 100.0)
    state.upsert("S:1", device_code="pc-win-01", node_key="qualify", phase="running")
    assert state.claim_step("S:1", "qualify", 0, body="要求")
    assert not state.claim_step("S:1", "qualify", 0, body="要求")
    assert state.mark_outbox("S:1", "qualify", 0, "sent")
    state.set_step("S:1", "qualify", 1)
    restarted = FlowState(path, now=lambda: 101.0)
    assert restarted.get("S:1")["step_index"] == 1
    assert restarted.outbox("S:1")[0]["status"] == "sent"


def test_reconcile_marks_unknown_and_due_followup_once(tmp_path):
    now = 10_000.0
    state = FlowState(tmp_path / "flow.db", now=lambda: now)
    state.upsert("S:unknown", phase="running")
    state.claim_step("S:unknown", "wage", 0, body="复聊")
    now += 601
    assert state.reconcile(now)["unknown"] == 1
    assert state.get("S:unknown")["phase"] == "held"
    state.upsert("S:1", phase="awaiting", await_since=now - 901, wait_minutes=15)
    assert state.reconcile(now)["followup_due"] == 1
    assert state.claim_followup("S:1")
    assert not state.claim_followup("S:1")
    assert state.mark_followup_sent("S:1")
    assert state.get("S:1")["phase"] == "followup_sent"
    assert state.reconcile(now + 1801)["expired"] == 1


def test_revision_rate_limit_and_custom_wait_survive_restart(tmp_path):
    state = FlowState(tmp_path / "flow.db", now=lambda: 10000)
    state.upsert("S:1", phase="awaiting", await_since=9800, wait_minutes=2)
    original = state.get("S:1")["revision"]
    state.set_step("S:1", "wage", 1)
    state.update("S:1", last_inbound_at=9900, last_inbound_id="message-1")
    assert state.get("S:1")["revision"] == original + 2
    assert state.reconcile()["followup_due"] == 1
    assert state.claim_device_followup(10000)
    restarted = FlowState(state.path)
    assert not restarted.claim_device_followup(10059)
    assert restarted.claim_device_followup(10060)


def test_missing_outbox_mirror_is_held_and_backups_preserve_cursor(tmp_path):
    state = FlowState(tmp_path / "flow.db")
    state.restore_mirror([{"device_code":"pc", "session_key":"S:1", "phase":"awaiting", "revision":4}], "pc")
    assert state.get("S:1")["phase"] == "held"
    assert state.get("S:1")["revision"] == 5
    state.daily_snapshot(1800000000)
    files = list((tmp_path / "snapshots").glob("*.db"))
    assert len(files) == 1
    assert FlowState(files[0]).get("S:1")["phase"] == "held"

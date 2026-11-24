from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store
from tests.test_bridge_commands import COMMAND, FakeBridge, _cfg, _mock_store


@pytest.fixture
def setup_agent(tmp_path, monkeypatch):
    agent = load_autopilot()
    agent.rlog = load_reply_store(tmp_path / "reply_log.db")
    clock = [1800000000.0]
    sleep = MagicMock(side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    monkeypatch.setattr(agent, "time", SimpleNamespace(time=lambda: clock[0], sleep=sleep, strftime=agent.time.strftime))
    return agent, clock, sleep


def assert_unknown(agent, bridge, stats):
    assert stats == {"claimed": 1, "sent": 0, "failed": 1}
    assert bridge.receipts == [(COMMAND["id"], COMMAND["lease_token"], "unknown", "")]
    saved = agent.rlog.recent_manual_receipts()[0]
    assert saved["status"] == "unknown"
    assert saved["receipt_state"] == "acked"
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize("deadline", [
    None, True, False, "4102444800000", "", 0, -1, float("nan"),
    float("inf"), float("-inf"), [], {}, pytest.param(10 ** 1000, id="oversized-integer"),
])
def test_invalid_lease_stops_before_store_clipboard_and_sender(setup_agent, deadline):
    agent, _, sleep = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": deadline})
    store = _mock_store()
    assert_unknown(agent, bridge, agent.pump_commands(store, _cfg(), bridge=bridge))
    store.sessions.assert_not_called()
    agent.compat.wait_clipboard_writable.assert_not_called()
    sleep.assert_not_called()


def test_missing_lease_stays_unknown_instead_of_falling_back_to_sending(setup_agent):
    agent, _, _ = setup_agent
    command = {k: v for k, v in COMMAND.items() if k != "lease_until"}
    bridge = FakeBridge(command)
    assert_unknown(agent, bridge, agent.pump_commands(_mock_store(), _cfg(), bridge=bridge))
    agent.compat.wait_clipboard_writable.assert_not_called()


@pytest.mark.parametrize("offset", [-1, 0])
def test_expired_and_exact_deadline_stop_before_clipboard(setup_agent, offset):
    agent, clock, _ = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": clock[0] * 1000 + offset})
    assert_unknown(agent, bridge, agent.pump_commands(_mock_store(), _cfg(), bridge=bridge))
    agent.compat.wait_clipboard_writable.assert_not_called()


def test_slow_claim_response_returns_after_its_original_lease(setup_agent):
    agent, clock, _ = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": (clock[0] + 60) * 1000})
    original_claim = bridge.claim

    def delayed_claim(only=""):
        clock[0] += 66
        return original_claim(only=only)

    bridge.claim = delayed_claim
    assert_unknown(agent, bridge, agent.pump_commands(_mock_store(), _cfg(), bridge=bridge))
    agent.compat.wait_clipboard_writable.assert_not_called()
    assert bridge.claim_calls == 1


def test_lease_expires_during_existing_cooldown(setup_agent):
    agent, clock, sleep = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": (clock[0] + 5) * 1000})
    agent._last_reply_at = clock[0]
    assert_unknown(agent, bridge, agent.pump_commands(_mock_store(), _cfg(cooldown=8), bridge=bridge))
    sleep.assert_called_once_with(8)
    agent.compat.wait_clipboard_writable.assert_not_called()


@pytest.mark.parametrize("clipboard_ready", [True, False])
def test_lease_expires_during_clipboard_wait(setup_agent, clipboard_ready):
    agent, clock, _ = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": (clock[0] + 5) * 1000})

    def wait_clipboard(**kwargs):
        clock[0] += 6
        return clipboard_ready

    agent.compat.wait_clipboard_writable.side_effect = wait_clipboard
    assert_unknown(agent, bridge, agent.pump_commands(_mock_store(), _cfg(), bridge=bridge))
    agent.compat.wait_clipboard_writable.assert_called_once_with(timeout=15)


def test_lease_expires_during_read_only_snapshot(setup_agent):
    agent, clock, _ = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": (clock[0] + 5) * 1000})
    store = _mock_store()

    def snapshot(*args, **kwargs):
        clock[0] += 6
        return []

    fetch = store._conn.return_value.execute.return_value.fetchall
    fetch.side_effect = snapshot
    assert_unknown(agent, bridge, agent.pump_commands(store, _cfg(), bridge=bridge))
    fetch.assert_called_once()


def test_valid_lease_preserves_existing_sender_and_real_id_receipt(setup_agent):
    agent, clock, _ = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": (clock[0] + 60) * 1000})
    store = _mock_store()
    store._conn.return_value.execute.return_value.fetchall.side_effect = [[], [(102, COMMAND["content"])]]
    agent.core_send.send.return_value = {"ok": True}
    assert agent.pump_commands(store, _cfg(), bridge=bridge) == {"claimed": 1, "sent": 1, "failed": 0}
    agent.core_send.send.assert_called_once()
    assert bridge.receipts == [(COMMAND["id"], COMMAND["lease_token"], "succeeded", f"{COMMAND['contact_id']}:102")]


def test_failed_unknown_receipt_recovers_without_reclaim_or_input(setup_agent):
    agent, clock, _ = setup_agent
    bridge = FakeBridge({**COMMAND, "lease_until": clock[0] * 1000})
    bridge.receipt = MagicMock(side_effect=TimeoutError("response lost"))
    assert agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)["sent"] == 0
    saved = agent.rlog.pending_manual_receipts(bridge.base_url, bridge.device_code)[0]
    assert saved["status"] == "unknown" and saved["message_id"] == ""
    recovered = FakeBridge()
    assert agent.flush_manual_receipts(recovered, force=True)
    assert recovered.claim_calls == 0
    assert recovered.receipts == [(COMMAND["id"], COMMAND["lease_token"], "unknown", "")]
    agent.compat.wait_clipboard_writable.assert_not_called()
    agent.core_send.send.assert_not_called()


def test_historical_success_receipt_is_not_reclassified_by_expired_clock(setup_agent):
    agent, clock, _ = setup_agent
    bridge = FakeBridge()
    agent.rlog.begin_manual_command(bridge.base_url, bridge.device_code, COMMAND["id"], COMMAND["lease_token"])
    agent.rlog.finish_manual_command(bridge.base_url, bridge.device_code, COMMAND["id"], COMMAND["lease_token"], "succeeded", "historical-id")
    clock[0] += 10 ** 8
    assert agent.flush_manual_receipts(bridge, force=True)
    assert bridge.receipts == [(COMMAND["id"], COMMAND["lease_token"], "succeeded", "historical-id")]
    assert bridge.claim_calls == 0
    agent.compat.wait_clipboard_writable.assert_not_called()
    agent.core_send.send.assert_not_called()

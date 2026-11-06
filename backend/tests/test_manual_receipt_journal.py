from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store
from tests.test_bridge_commands import COMMAND, FakeBridge, _cfg, _mock_store


class ReceiptBridge(FakeBridge):
    def __init__(self, command=None, receipt_error=None):
        super().__init__(command)
        self.receipt_error = receipt_error
        self.receipt_response = {"ok": True}

    def receipt(self, *args):
        result = super().receipt(*args)
        if self.receipt_error:
            raise self.receipt_error
        return self.receipt_response if self.receipt_response is not None else result


@pytest.fixture
def agent(tmp_path):
    module = load_autopilot()
    module.rlog = load_reply_store(tmp_path / "reply_log.db")
    module.core_send.send.return_value = {"ok": True, "conversation_id": "", "detail": "sent"}
    return module


def restart(agent):
    module = load_autopilot()
    module.rlog = load_reply_store(agent.rlog.DB_PATH)
    return module


def pending(agent, bridge):
    return agent.rlog.pending_manual_receipts(bridge.base_url, bridge.device_code)


def seed(agent, bridge, command=COMMAND, status="succeeded", message_id="real-message"):
    agent.rlog.begin_manual_command(bridge.base_url, bridge.device_code, command["id"], command["lease_token"])
    agent.rlog.finish_manual_command(bridge.base_url, bridge.device_code, command["id"], command["lease_token"], status, message_id)


def test_result_committed_before_http_and_retries_after_restart_without_sending(agent):
    bridge = ReceiptBridge(dict(COMMAND), TimeoutError("response lost"))
    original = bridge.receipt

    def verify_durable(*args):
        saved = pending(agent, bridge)[0]
        assert saved["status"] == "succeeded"
        assert saved["message_id"] == f"keyboard-{COMMAND['id']}"
        return original(*args)

    bridge.receipt = verify_durable
    assert agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)["sent"] == 1
    agent.core_send.send.assert_called_once()
    replay = restart(agent)
    recovered = ReceiptBridge()
    assert replay.pump_commands(_mock_store(), _cfg(), bridge=recovered, wecom_state="offline")["sent"] == 0
    replay.core_send.send.assert_not_called()
    assert recovered.claim_calls == 0
    assert recovered.receipts == bridge.receipts
    assert pending(replay, recovered) == []
    assert replay.rlog.recent_manual_receipts()[0]["receipt_state"] == "acked"


def test_attempt_is_durable_before_sender_and_crash_recovers_as_unknown(agent):
    bridge = ReceiptBridge(dict(COMMAND))

    def crash(*args, **kwargs):
        assert pending(agent, bridge)[0]["status"] == "unknown"
        raise KeyboardInterrupt()

    agent.core_send.send.side_effect = crash
    with pytest.raises(KeyboardInterrupt):
        agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    replay = restart(agent)
    recovered = ReceiptBridge(dict(COMMAND))
    replay.pump_commands(_mock_store(), _cfg(), bridge=recovered)
    assert recovered.receipts == [(COMMAND["id"], COMMAND["lease_token"], "unknown", "")]
    replay.core_send.send.assert_not_called()


def test_journal_write_failure_stops_before_clipboard_or_sender(agent, monkeypatch):
    bridge = ReceiptBridge(dict(COMMAND))
    monkeypatch.setattr(agent.rlog, "begin_manual_command", MagicMock(side_effect=sqlite3.OperationalError("disk full")))
    assert agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)["failed"] == 1
    agent.core_send.send.assert_not_called()
    agent.compat.wait_clipboard_writable.assert_not_called()
    assert bridge.receipts == []


def test_result_write_failure_keeps_pre_send_unknown_after_restart(agent, monkeypatch):
    bridge = ReceiptBridge(dict(COMMAND))
    monkeypatch.setattr(agent.rlog, "finish_manual_command", MagicMock(side_effect=sqlite3.OperationalError("disk full")))
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    assert bridge.receipts == []
    replay = restart(agent)
    recovered = ReceiptBridge()
    replay.pump_commands(_mock_store(), _cfg(), bridge=recovered, wecom_state="hidden")
    assert recovered.receipts[-1][2:] == ("unknown", "")
    replay.core_send.send.assert_not_called()


def test_ack_write_failure_replays_identical_receipt(agent, monkeypatch):
    bridge = ReceiptBridge()
    seed(agent, bridge)
    original = agent.rlog.mark_manual_receipt
    monkeypatch.setattr(agent.rlog, "mark_manual_receipt", MagicMock(side_effect=sqlite3.OperationalError("disk full")))
    assert agent.flush_manual_receipts(bridge, force=True) is False
    assert len(pending(agent, bridge)) == 1
    monkeypatch.setattr(agent.rlog, "mark_manual_receipt", original)
    assert agent.flush_manual_receipts(bridge, force=True) is True
    assert bridge.receipts[0] == bridge.receipts[1]


@pytest.mark.parametrize("error", [TimeoutError("offline"), HTTPError("http://bridge.example", 503, "unavailable", {}, None), HTTPError("http://bridge.example", 401, "auth", {}, None), HTTPError("http://bridge.example", 403, "forbidden", {}, None)])
def test_transient_or_auth_failures_keep_receipt_and_prevent_new_claims(agent, error):
    bridge = ReceiptBridge(dict(COMMAND), error)
    seed(agent, bridge)
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    assert pending(agent, bridge)[0]["status"] == "succeeded"
    assert bridge.claim_calls == 0
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize("status", [409, 422])
def test_rejected_receipt_is_retained_for_review_and_does_not_block_other_receipts(agent, status):
    bridge = ReceiptBridge()
    seed(agent, bridge)
    second = {**COMMAND, "id": "cmd-second"}
    seed(agent, bridge, second)
    original = bridge.receipt

    def reject_first(*args):
        if args[0] == COMMAND["id"]:
            raise HTTPError("http://bridge.example", status, "conflict", {}, None)
        return original(*args)

    bridge.receipt = reject_first
    assert agent.flush_manual_receipts(bridge, force=True) is True
    records = {item["command_id"]: item for item in agent.rlog.recent_manual_receipts()}
    assert records[COMMAND["id"]]["receipt_state"] == "rejected"
    assert records[second["id"]]["receipt_state"] == "acked"
    assert records[COMMAND["id"]]["error"].startswith(f"HTTP {status}")
    assert "lease_token" not in records[COMMAND["id"]]


def test_retry_is_throttled_and_dry_run_never_calls_network(agent, monkeypatch):
    bridge = ReceiptBridge(receipt_error=TimeoutError("offline"))
    seed(agent, bridge)
    monkeypatch.setattr(agent.time, "time", lambda: 1000)
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    assert len(bridge.receipts) == 1
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge, dry=True)
    agent.pump_commands(_mock_store(), _cfg(dry_run=True), bridge=bridge)
    assert len(bridge.receipts) == 1
    assert len(pending(agent, bridge)) == 1


@pytest.mark.parametrize("field,value", [("base_url", "http://other.example"), ("device_code", "other-device")])
def test_receipts_never_go_to_reconfigured_destination(agent, field, value):
    bridge = ReceiptBridge()
    seed(agent, bridge)
    other = ReceiptBridge()
    setattr(other, field, value)
    assert agent.flush_manual_receipts(other, force=True) is True
    assert other.receipts == []
    assert len(pending(agent, bridge)) == 1


@pytest.mark.parametrize("response", [{}, {"ok": False}, {"ok": "true"}])
def test_unacknowledged_response_does_not_delete_receipt(agent, response):
    bridge = ReceiptBridge()
    bridge.receipt_response = response
    seed(agent, bridge)
    assert agent.flush_manual_receipts(bridge, force=True) is False
    assert len(pending(agent, bridge)) == 1


def test_same_attempt_never_reexecutes_and_only_failed_outcome_allows_new_lease(agent):
    bridge = ReceiptBridge(dict(COMMAND))
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    replay = restart(agent)
    replay.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    replay.core_send.send.assert_not_called()
    assert not replay.rlog.begin_manual_command(bridge.base_url, bridge.device_code, COMMAND["id"], "new-lease")
    failed = {**COMMAND, "id": "failed-command"}
    seed(replay, bridge, failed, status="failed", message_id="")
    assert replay.rlog.begin_manual_command(bridge.base_url, bridge.device_code, failed["id"], "new-lease")
    assert not replay.rlog.begin_manual_command(bridge.base_url, bridge.device_code, failed["id"], "new-lease")


def test_pre_send_guard_failure_is_durably_reported_as_failed(agent):
    bridge = ReceiptBridge({**COMMAND, "nickname": ""}, TimeoutError("offline"))
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    assert pending(agent, bridge)[0]["status"] == "failed"
    agent.core_send.send.assert_not_called()


def test_wrong_conversation_or_sender_exception_is_unknown(agent):
    bridge = ReceiptBridge(dict(COMMAND))
    agent.core_send.send.return_value = {"ok": False, "conversation_id": "S:wrong", "detail": "wrong destination"}
    agent.pump_commands(_mock_store(), _cfg(), bridge=bridge)
    assert bridge.receipts[-1][2] == "unknown"


def test_old_reply_database_is_upgraded_without_changing_existing_records(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as con:
        con.execute("CREATE TABLE reply_log (id INTEGER PRIMARY KEY,message_id TEXT,conv_id TEXT,status TEXT)")
        con.execute("INSERT INTO reply_log VALUES (1,'old','S:old','sent')")
    records = load_reply_store(path)
    assert records.stats() == {"sent": 1, "total": 1}
    assert records.begin_manual_command("http://bridge.example", "device", "command", "lease")
    assert records.recent()[0]["message_id"] == "old"


def test_flush_cli_operates_without_store_or_input_and_exits(agent, tmp_path, monkeypatch):
    bridge = ReceiptBridge()
    seed(agent, bridge)
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--flush-receipts"])
    monkeypatch.setattr(agent, "_make_bridge", lambda *args: bridge)
    assert agent.main() == 0
    assert pending(agent, bridge) == []
    agent.Store.assert_not_called()
    agent.core_send.send.assert_not_called()


def test_flush_cli_dry_run_preserves_receipts(agent, tmp_path, monkeypatch):
    bridge = ReceiptBridge()
    seed(agent, bridge)
    (tmp_path / "config.json").write_text(json.dumps({"dry_run": True}), encoding="utf-8")
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--flush-receipts"])
    monkeypatch.setattr(agent, "_make_bridge", MagicMock())
    assert agent.main() == 0
    assert len(pending(agent, bridge)) == 1
    agent._make_bridge.assert_not_called()


def test_history_does_not_print_lease_tokens(agent, capsys):
    bridge = ReceiptBridge()
    seed(agent, bridge)
    agent.print_history()
    output = capsys.readouterr().out
    assert COMMAND["id"] in output
    assert COMMAND["lease_token"] not in output


def test_concurrent_attempt_claims_have_one_winner(agent):
    def begin(_):
        return agent.rlog.begin_manual_command("http://bridge.example", "device", "command", "lease")
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(begin, range(2))) == [False, True]


@pytest.mark.parametrize("error", [TimeoutError("offline"), HTTPError("http://bridge.example", 409, "conflict", {}, None)])
def test_flush_cli_returns_failure_for_pending_or_rejected_receipts(agent, tmp_path, monkeypatch, error):
    bridge = ReceiptBridge(receipt_error=error)
    seed(agent, bridge)
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--flush-receipts"])
    monkeypatch.setattr(agent, "_make_bridge", lambda *args: bridge)
    assert agent.main() == 1
    agent.Store.assert_not_called()


def test_flush_cli_requires_bridge_configuration(agent, tmp_path, monkeypatch):
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent.sys, "argv", ["autopilot.py", "--flush-receipts"])
    assert agent.main() == 2
    agent.Store.assert_not_called()

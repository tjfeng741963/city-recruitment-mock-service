from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store, stub_text_readback


def incoming(ledger, mid, cid="S:customer", stamp=100):
    ledger.record_incoming({
        "id": mid, "conv_id": cid, "conv_name": "Customer",
        "text": "Is this job available?", "type": 2, "time": stamp,
    })


def approve(ledger, mid="10", cid="S:customer"):
    return ledger.queue_reply_recovery(cid, mid, reason="Verified WeCom history", operator="test")


@pytest.fixture
def ledger(tmp_path):
    return load_reply_store(tmp_path / "reply_log.db")


def test_only_selected_old_row_is_requeued_and_retains_message_time(ledger):
    incoming(ledger, 10)
    incoming(ledger, 10, "S:other")
    assert ledger.hold_before(200) == 2
    assert approve(ledger) == "queued"
    ledger.init()
    assert ledger.hold_before(200) == 0
    assert [(r["conv_id"], r["msg_time"]) for r in ledger.pending()] == [("S:customer", 100)]
    report = ledger.recent_reply_recoveries()[0]
    assert (report["previous_status"], report["outcome"], report["operator"], report["reason"]) == (
        "held", "queued", "test", "Verified WeCom history",
    )


def test_queued_recovery_is_atomic_and_failure_returns_to_review(ledger):
    incoming(ledger, 10)
    ledger.hold_before(200)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: approve(ledger), range(2))) == ["already_queued", "queued"]
    assert ledger.begin_reply_attempt("10", "S:customer", "Agent", "answer")
    assert approve(ledger) == "in_progress"
    ledger.mark_failed("10", "S:customer", "No foreground")
    assert ledger.pending() == []
    assert ledger.recent()[0]["status"] == "held"
    assert ledger.recent_reply_recoveries()[0]["outcome"] == "failed"


def test_interrupted_recovery_stays_unknown_and_requires_fresh_approval(ledger):
    incoming(ledger, 10)
    ledger.mark_unknown("10", "S:customer", "No readback")
    assert approve(ledger) == "queued"
    assert ledger.begin_reply_attempt("10", "S:customer", "Agent", "answer")
    ledger.init()
    assert ledger.pending() == []
    assert ledger.recent_reply_recoveries()[0]["outcome"] == "unknown"
    ledger.recover_interrupted_replies()
    assert approve(ledger) == "queued"
    assert [r["outcome"] for r in ledger.recent_reply_recoveries()] == ["queued", "unknown"]


def test_sent_and_superseded_messages_cannot_be_recovered(ledger):
    incoming(ledger, 10)
    incoming(ledger, 11, stamp=101)
    ledger.mark_sent("10", "S:customer", "Agent", "answer")
    assert approve(ledger) == "not_eligible"
    ledger.mark_unknown("10", "S:customer", "No readback")
    assert approve(ledger) == "superseded"
    assert ledger.recent_reply_recoveries() == []


def test_legacy_sent_needs_explicit_override_and_verified_sent_is_protected(ledger):
    incoming(ledger, 10)
    ledger.mark_sent("10", "S:customer", "Agent", "legacy outcome")
    assert approve(ledger) == "not_eligible"
    assert ledger.queue_reply_recovery(
        "S:customer", "10", reason="No outbound in WeCom", operator="test", legacy_sent=True,
    ) == "queued"
    assert ledger.recent_reply_recoveries()[0]["previous_status"] == "sent"
    assert ledger.begin_reply_attempt("10", "S:customer", "Agent", "answer")
    ledger.mark_sent("10", "S:customer", "Agent", "answer", verified=True)
    assert ledger.queue_reply_recovery(
        "S:customer", "10", reason="Checked", operator="test", legacy_sent=True,
    ) == "not_eligible"


@pytest.mark.parametrize("stage", ["before_drain", "before_send"])
def test_newer_message_arriving_after_approval_cancels_stale_request(ledger, stage):
    incoming(ledger, 10)
    ledger.hold_before(200)
    assert approve(ledger) == "queued"
    incoming(ledger, 11, stamp=101)
    if stage == "before_drain":
        assert ledger.skip_superseded_reply_recoveries() == 1
    else:
        assert not ledger.begin_reply_attempt("10", "S:customer", "Agent", "answer")
    assert [r["message_id"] for r in ledger.pending()] == ["11"]
    assert ledger.recent_reply_recoveries()[0]["outcome"] == "skipped"


def test_legacy_retry_does_not_bulk_requeue_expired_or_unknown(ledger):
    incoming(ledger, 10)
    incoming(ledger, 11, "S:other")
    ledger.mark_unknown("11", "S:other", "No readback")
    ledger.hold_before(200)
    assert ledger.retry_held() == 0
    assert ledger.pending() == []


def test_failed_recovery_brain_is_not_replayed_by_bulk_retry(ledger):
    incoming(ledger, 10)
    ledger.hold_before(200)
    assert approve(ledger) == "queued"
    ledger.mark_held("10", "S:customer", "Agent 暂停，待人工处理：timeout")
    assert ledger.retry_held() == 0
    assert ledger.recent_reply_recoveries()[0]["outcome"] == "held"


def test_known_partial_requires_manual_completion(ledger):
    incoming(ledger, 10)
    ledger.mark_unknown("10", "S:customer", "First segment delivered", partial=True)
    assert approve(ledger) == "partial"
    assert ledger.pending() == []


@pytest.mark.parametrize("error", ["已确认 1 段文本，其余未完成：回读失败",
                                  "开场第 2 项未完成，已有 1 项执行成功：回读失败"])
def test_previous_partial_accounting_remains_protected(ledger, error):
    incoming(ledger, 10)
    ledger.mark_unknown("10", "S:customer", error)
    assert approve(ledger) == "partial"


def test_command_queues_only_after_explicit_confirmation_and_drain_replies_once(ledger, tmp_path, monkeypatch):
    agent = load_autopilot()
    stub_text_readback(agent, monkeypatch)
    monkeypatch.setattr(agent, "ROOT", tmp_path)
    monkeypatch.setattr(agent, "rlog", ledger)
    monkeypatch.setattr(agent, "_is_first_contact", lambda *_: False)
    monkeypatch.setattr(agent, "_check_reply_mode", lambda *_: True)
    incoming(ledger, 10)
    ledger.hold_before(200)
    command = ["autopilot.py", "--retry-message", "S:customer", "10", "--reason", "Checked"]
    monkeypatch.setattr(agent.sys, "argv", command)
    with pytest.raises(SystemExit) as error:
        agent.main()
    assert error.value.code == 2 and ledger.pending() == []
    monkeypatch.setattr(agent.sys, "argv", [*command, "--verified-unsent"])
    assert agent.main() == 0
    agent.Store.assert_not_called()
    agent.core_send.send.assert_not_called()

    agent._brain = None
    agent.core_send.send.return_value = {"ok": True, "conversation_id": "S:customer", "detail": "ok"}
    cfg = {"cooldown": 0, "reply_first": "answer", "reply_next": "answer", "_reply_mode_enabled": True}
    assert agent.drain(MagicMock(), cfg)["sent"] == 1
    assert agent.drain(MagicMock(), cfg)["sent"] == 0
    agent.core_send.send.assert_called_once()
    assert ledger.recent_reply_recoveries()[0]["outcome"] == "sent"

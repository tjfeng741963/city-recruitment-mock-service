"""Subprocess fixture: real journal/client, isolated desktop APIs."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import sys
from unittest.mock import MagicMock

from tests.agent_loader import load_autopilot, load_reply_store


def run(folder: Path, phase: str):
    cfg = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    agent = load_autopilot()
    agent.ROOT = folder
    agent.rlog = load_reply_store(folder / "reply_log.db")
    events = {"sender_calls": 0, "brain_calls": 0}
    store = MagicMock()
    store.sessions.return_value = [{"name": "Recovery fixture", "id": "S:recovery"}]
    store.self_id.return_value = "fixture-owner"
    store.messages.side_effect = [[], [{"id": 102, "sender_id": "fixture-owner", "text": "synthetic recovery reply"}]]

    def sender(*args, **kwargs):
        if phase != "pump":
            raise AssertionError("Recovery must not invoke the sender")
        events["sender_calls"] += 1
        return {"ok": True, "conversation_id": "", "detail": "isolated sender fixture"}

    agent.core_send.send.side_effect = sender
    agent.compat.wait_clipboard_writable.return_value = True
    agent.Store.side_effect = AssertionError("CLI recovery must not initialize a desktop Store")
    bridge = agent.agent_client.BridgeClient(cfg["bridge_server"], cfg["bridge_token"], cfg["device_code"])
    result = {}
    if phase == "pump":
        result["stats"] = agent.pump_commands(store, {"cooldown": 0, "dry_run": False}, bridge=bridge)
    elif phase == "flush":
        sys.argv = ["autopilot.py", "--flush-receipts"]
        result["exit_code"] = agent.main()
        result["stats"] = agent.pump_commands(store, {"cooldown": 0, "dry_run": False}, bridge=bridge)
        assert not agent.Store.called
    elif phase in {"hold", "held-restart"}:
        if phase == "hold":
            agent.rlog.record_incoming({"id": 10, "conv_id": "S:recovery", "conv_name": "Recovery fixture", "text": "synthetic question", "type": 2, "time": 100})
        agent._brain = MagicMock()

        def answer(*args, **kwargs):
            events["brain_calls"] += 1
            return {"ok": False, "detail": "synthetic KB unavailable"} if phase == "hold" else {"ok": True, "reply": "recovered KB answer"}

        agent._brain.reply.side_effect = answer
        result["stats"] = agent.drain(store, {"cooldown": 0, "reply_first": "1", "reply_next": "233", "brain": {"mode": "kb"}})
    elif phase == "retry-held":
        sys.argv = ["autopilot.py", "--retry-held"]
        result["exit_code"] = agent.main()
        assert not agent.Store.called
    else:
        raise AssertionError("Unexpected fixture phase")
    result["events"] = events
    result["receipt_counts"] = agent.rlog.manual_receipt_counts(bridge.base_url, bridge.device_code)
    result["reply_counts"] = agent.rlog.stats()
    assert not store.refresh.called
    return result


if __name__ == "__main__":
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        result = run(Path(sys.argv[1]), sys.argv[2])
    print(json.dumps(result))

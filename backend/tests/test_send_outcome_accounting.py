"""发送结果记账与节流（agent/autopilot.py drain + agent/reply_store.py）。

2026-11-16 事故回归：
1. 失败"零成本"立即重试下一个会话 → 3 秒连发 3 个客户 → 触发风控掉登录。
   修复：冷却在按键前更新，成败都消耗；连续失败退避最多 4 倍。
2. "已发送但回读失败"被记成 sent：可能静默丢失。修复：新增 unknown 态，
   不参与自动补发，--retry-held 人工重新入队。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests import agent_loader
from tests.agent_loader import load_autopilot


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    spec = importlib.util.spec_from_file_location(
        "isolated_reply_store",
        Path(module.__file__).with_name("reply_store.py"),
    )
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply_log.db"
    records.init()
    records.record_incoming({
        "id": 10, "conv_id": "S:customer", "conv_name": "Customer",
        "text": "salary?", "type": 2, "time": 100,
    })
    monkeypatch.setattr(module, "rlog", records)
    module._brain = MagicMock()
    module._brain.chat.return_value = {"ok": True, "parts": ["hi"], "medias": [], "scene": "Agent", "detail": "ok"}
    module._brain.opening.return_value = {"ok": False, "items": [], "detail": "no opening"}
    module._last_reply_at = 0
    module._consecutive_send_failures = 0
    return module


CFG = {"cooldown": 0, "reply_first": "1", "reply_next": "233", "brain": {"mode": "agent"}}


def _status_of(records):
    rows = records.recent(5)
    return {r["message_id"]: r["status"] for r in rows}.get("10")


def test_send_failure_consumes_cooldown_and_counts_backoff(agent):
    agent.core_send.send.return_value = {"ok": False, "detail": "抢不到前台，已中止"}
    before = agent._last_reply_at
    stats = agent.drain(MagicMock(), CFG)
    assert stats["sent"] == 0 and stats["failed"] == 1
    # 失败也算一次企微操作：冷却时间戳必须前进（修复前失败不更新，立即重试）
    assert agent._last_reply_at > before
    assert agent._consecutive_send_failures == 1
    assert _status_of(agent.rlog) == "failed"


def test_readback_failure_is_unknown_not_sent(agent):
    agent.core_send.send.return_value = {"ok": True, "detail": "已发送但回读失败：No item with that key"}
    stats = agent.drain(MagicMock(), CFG)
    assert stats["unknown"] == 1 and stats["sent"] == 0
    assert _status_of(agent.rlog) == "unknown"
    assert agent._consecutive_send_failures == 1
    # unknown 不参与自动补发
    assert agent.rlog.pending(include_failed=True) == []


def test_success_resets_backoff_counter(agent):
    agent.core_send.send.return_value = {"ok": False, "detail": "失败一"}
    agent.drain(MagicMock(), CFG)
    assert agent._consecutive_send_failures == 1
    agent.core_send.send.return_value = {"ok": True, "detail": "sent"}
    agent.rlog.record_incoming({
        "id": 11, "conv_id": "S:customer2", "conv_name": "Customer",
        "text": "hi", "type": 2, "time": 200,
    })
    # 第二轮会把上一轮 failed 的第 10 条一起补发（既有行为），两条都成功
    stats = agent.drain(MagicMock(), CFG)
    assert stats["sent"] == 2
    assert agent._consecutive_send_failures == 0
    assert _status_of(agent.rlog) == "sent"


def test_brain_failure_still_blocks_input(agent):
    agent._brain.chat.return_value = {"ok": False, "detail": "HTTP 503"}
    stats = agent.drain(MagicMock(), CFG)
    assert stats["blocked"] == 1
    agent.core_send.send.assert_not_called()


def test_retry_held_requeues_unknown_records(tmp_path):
    spec = importlib.util.spec_from_file_location(
        "isolated_reply_store2",
        agent_loader.AGENT_DIR / "reply_store.py",
    )
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply_log.db"
    records.init()
    records.record_incoming({
        "id": 10, "conv_id": "S:customer", "conv_name": "Customer",
        "text": "salary?", "type": 2, "time": 100,
    })
    records.mark_unknown("10", "已发送但回读失败", scene="kb", reply_text="hi")
    assert records.pending(include_failed=True) == []
    assert records.retry_held() == 1
    rows = records.pending(include_failed=True)
    assert len(rows) == 1 and rows[0]["status"] == "pending"

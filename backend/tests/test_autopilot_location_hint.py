"""客户发定位（企微 type=48）不能被当成空系统事件丢掉。

store 只对文本类型（2/573）提取正文，定位消息的 in_text 恒为空。此前这类
消息在 drain 里被判成「空系统事件」，既不推进节点也不回话，运营侧只看到
「消息没有文本（type=48）」（2026-11-20 线上反馈）。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = load_autopilot()
    spec = importlib.util.spec_from_file_location(
        "hint_reply_store", Path(module.__file__).with_name("reply_store.py")
    )
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    records.DB_PATH = tmp_path / "reply.db"
    records.init()
    monkeypatch.setattr(module, "rlog", records)
    return module


def inbound(mid=1, text="", kind=48):
    return {
        "id": str(mid),
        "conv_id": "S:customer",
        "conv_name": "Customer",
        "text": text,
        "type": kind,
        "sender_id": "customer",
        "time": 100,
    }


def test_location_message_turns_into_a_readable_hint(agent):
    hint = agent._inbound_hint({"in_text": "", "in_type": 48})
    assert hint, "定位消息必须有提示语，否则会被当成空系统事件跳过"
    assert "定位" in hint


def test_text_message_keeps_its_own_text(agent):
    assert agent._inbound_hint({"in_text": "  你好  ", "in_type": 2}) == "你好"


@pytest.mark.parametrize("kind", [1011, 1002, 0, None, "not-a-number"])
def test_system_and_unknown_types_stay_empty(agent, kind):
    # 加好友/撤回这类系统提示不能当成人话，否则 Agent 会开始回复系统消息。
    assert agent._inbound_hint({"in_text": "", "in_type": kind}) == ""


def test_image_type_keeps_the_old_skip_behaviour(agent):
    # 本次只放开定位；图片仍按空事件处理，避免一次性改变所有非文本消息。
    assert agent._inbound_hint({"in_text": "", "in_type": 3}) == ""


def test_location_is_recorded_and_yields_a_hint_end_to_end(agent):
    store = MagicMock()
    store.recent.return_value = [inbound()]
    # scan() 末尾会走 scan_unread()；这里不给未读游标数据库，让它直接返回 0。
    store._conn.return_value = None
    assert agent.scan(store, {"target": "all"}) == 1

    row = agent.rlog.pending()[0]
    assert (row["message_id"], row["in_type"], row["in_text"]) == ("1", 48, "")
    assert agent._inbound_hint(row)

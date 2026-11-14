"""回声防御 + 方向判定：不依赖企微库、不依赖 pywin32，纯逻辑单测。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
sys.path.insert(0, str(AGENT_DIR))

import echo_guard  # noqa: E402
from wecom_io_core import identity  # noqa: E402

CONV = "S:1688858186855249_7881299918302353"


def msg(mid: str, direction: str, content: str, ts: float, conv: str = CONV) -> dict:
    return {
        "external_conversation_id": conv,
        "external_msgid": mid,
        "direction": direction,
        "content": content,
        "sent_at": ts,
    }


# ── 回声判定 ────────────────────────────────────────────────────────────────
def test_exact_duplicate_outbound_is_dropped():
    batch = [msg("180", "inbound", "深圳的", 1000.0), msg("180", "outbound", "深圳的", 1002.0)]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert [m["direction"] for m in kept] == ["inbound"]
    assert len(dropped) == 1
    assert dropped[0][0]["external_msgid"] == "180"
    assert dropped[0][2] == 1.0


def test_similar_outbound_is_dropped():
    batch = [
        msg("190", "inbound", "工资多少呀，包吃住吗", 2000.0),
        msg("191", "outbound", "工资多少呀 包吃住吗", 2010.0),
    ]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert len(kept) == 1 and len(dropped) == 1
    assert dropped[0][2] >= echo_guard.ECHO_SIMILARITY


def test_normal_outbound_is_kept():
    batch = [
        msg("180", "inbound", "深圳的", 1000.0),
        msg("181", "outbound", "深圳这边有电子厂在招普工，20 块一小时，包吃住，你什么时候方便过来面试？", 1003.0),
    ]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert len(kept) == 2 and not dropped


def test_outbound_outside_window_is_kept():
    batch = [
        msg("180", "inbound", "你好", 1000.0),
        msg("200", "outbound", "你好", 1000.0 + echo_guard.ECHO_WINDOW + 1),
    ]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert len(kept) == 2 and not dropped


def test_echo_matched_from_history_pool():
    pool = [msg("174", "inbound", "工资多少", 3000.0)]
    batch = [msg("175", "outbound", "工资多少", 3005.0)]
    kept, dropped = echo_guard.filter_echo_messages(batch, pool=pool)
    assert not kept
    assert dropped[0][1]["external_msgid"] == "174"


def test_same_text_in_other_conversation_is_kept():
    other = "S:1688858186855249_7881301272040343"
    batch = [
        msg("10", "inbound", "广州", 4000.0),
        msg("11", "outbound", "广州", 4001.0, conv=other),
    ]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert len(kept) == 2 and not dropped


def test_empty_outbound_is_kept():
    batch = [msg("180", "inbound", "你好", 5000.0), msg("181", "outbound", "", 5001.0)]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert len(kept) == 2 and not dropped


def test_iso_sent_at_is_understood():
    batch = [
        msg("180", "inbound", "广州", "2026-11-12T16:27:54+00:00"),
        msg("181", "outbound", "广州", "2026-11-12T16:28:10+00:00"),
    ]
    kept, dropped = echo_guard.filter_echo_messages(batch)
    assert len(dropped) == 1


def test_similarity_threshold():
    assert echo_guard.similarity("广州", "广州") == 1.0
    assert echo_guard.similarity("广州", "") == 0.0
    assert echo_guard.similarity("工资多少", "工资多少呀") > 0.8


# ── 方向判定 ────────────────────────────────────────────────────────────────
def test_self_id_majority_beats_data_dir():
    convs = ["S:111_222", "S:111_333", "S:444_111"]
    assert identity.resolve_self_id(convs, "999") == ("111", "session-majority")


def test_self_id_keeps_data_dir_when_consistent():
    convs = ["S:111_222", "S:111_333"]
    assert identity.resolve_self_id(convs, "111")[0] == "111"


def test_self_id_single_conversation_is_not_enough_to_override():
    assert identity.resolve_self_id(["S:111_222"], "999")[0] == "999"


def test_direction_of_single_chat_uses_counterpart():
    # 自己在前、对方在后
    assert identity.direction_of("788", "168", "S:168_788") == "inbound"
    assert identity.direction_of("168", "168", "S:168_788") == "outbound"
    # 线上真实存在的反向写法：对方在前、自己在后
    reversed_conv = "S:1688852792312821_1688858186855249"
    assert identity.direction_of("1688852792312821", "1688858186855249", reversed_conv) == "inbound"
    assert identity.direction_of("1688858186855249", "1688858186855249", reversed_conv) == "outbound"


def test_direction_of_unknown_sender_is_inbound():
    assert identity.direction_of("", "168", "S:168_788") == "inbound"
    assert identity.direction_of("0", "168", "R:123") == "inbound"


def test_counterpart_of_group_conversation_is_empty():
    assert identity.counterpart_of("R:1073645123456", "168") == ""
    assert identity.counterpart_of("S:168_788", "") == ""

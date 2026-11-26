"""面试地址必须带定位：brain.chat 要把服务端的 location_card 透传给客户端。

2026-11-26 事故：客户在企微里问「我要导航」，服务端已经算好面试点坐标并放进了
`location_card`，但 `Brain.chat()` 的两条成功返回都没带这个键。客户端
`autopilot.py` 里 `res.get("location_card") or None` 永远是 None，于是位置卡
一次都没发出去，日志里连一行 `[位置卡]` 都看不到——客户只拿到一段文字地址。
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

from tests.agent_loader import AGENT_DIR

if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import brain as brain_module  # noqa: E402

CARD = {
    "lng": 113.39114,
    "lat": 23.117692,
    "address": "冠宇商务中心2楼224室。乘广州地铁4号线或5号线到车陂南站，C出口直行约80米。",
    "name": "冠宇商务中心2楼224室",
}


def _brain(response: dict) -> brain_module.Brain:
    instance = brain_module.Brain("http://127.0.0.1:4222", "pc-win-01", "token")
    instance._post = MagicMock(return_value=response)  # type: ignore[method-assign]
    return instance


def test_plain_reply_carries_location_card():
    res = _brain({
        "ok": True,
        "trace_id": "trace-1",
        "reply": {"messages": [{"type": "text", "content": "面试地点是冠宇商务中心2楼224室。"}]},
        "location_card": CARD,
        "model": "deepseek-flash",
        "latency_ms": 1200,
    }).chat("我要导航", "1")

    assert res["ok"] is True
    assert res["location_card"] == CARD


def test_ordered_plan_reply_carries_location_card():
    res = _brain({
        "ok": True,
        "trace_id": "trace-2",
        "provider": "dify",
        "reply": {
            "messages": [
                {"type": "text", "content": "面试地点是冠宇商务中心2楼224室。"},
                {"type": "image", "name": "面试地点.png"},
            ],
            "delays_before_ms": [0, 2000],
        },
        "location_card": CARD,
        "model": "dify",
    }).chat("面试地点在哪", "1")

    assert res["ok"] is True
    assert res["location_card"] == CARD


def test_reply_without_card_stays_none():
    """没坐标（岗位没配面试点）时不能凭空造一张卡。"""
    res = _brain({
        "ok": True,
        "trace_id": "trace-3",
        "reply": {"messages": [{"type": "text", "content": "稍等，我确认一下。"}]},
        "model": "deepseek-flash",
        "latency_ms": 900,
    }).chat("地址呢", "1")

    assert res["ok"] is True
    assert res["location_card"] is None

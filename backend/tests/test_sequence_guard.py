"""会话定位守卫：同名才拦，emoji/改昵称不再误拦（2026-11-25）。

背景：Garbo_C 的显示名是「🦄Garbo_C🦄」，列表名和联系人表只要差一个字符，
旧守卫（要求同名集合恰好等于对方）就判「不能唯一搜索」并停止介绍，
客户既收不到回复也不进人工队列。现在只在**真的同名撞车**时拦。
"""
from __future__ import annotations

import types

from tests.agent_loader import load_autopilot


class FakeStore:
    def __init__(self, self_id: str, contacts: dict[str, str]):
        self._self_id = self_id
        self._contacts = contacts

    def self_id(self) -> str:
        return self._self_id

    def contacts(self) -> dict[str, str]:
        return self._contacts


def _guard(monkeypatch, contacts: dict[str, str], name: str, other: str = "2000") -> str:
    agent = load_autopilot()
    monkeypatch.setattr(agent, "remote_cfg", types.SimpleNamespace(
        takeover_sessions=lambda: [], abandoned_sessions=lambda: [],
    ))
    monkeypatch.setattr(agent, "_brain", types.SimpleNamespace(
        reply_provider="agent", reply_mode_generation=None,
    ))
    return agent._sequence_block_reason(
        "S:1000_" + other, {}, agent._reply_source_identity(), FakeStore("1000", contacts), name,
    )


def test_emoji_name_no_longer_blocks(monkeypatch):
    # 联系人表里的名字与列表名差一个 emoji 变体，旧逻辑会直接拦住
    assert _guard(monkeypatch, {"2000": "Garbo_C"}, "🦄Garbo_C🦄") == ""


def test_renamed_contact_no_longer_blocks(monkeypatch):
    # 客户改了昵称：名字对不上，但会话 ID 的对方仍在联系人表里
    assert _guard(monkeypatch, {"2000": "老王"}, "新昵称") == ""


def test_same_name_collision_still_blocks(monkeypatch):
    # 真歧义：两个同名联系人，且当前会话的对方不在其中
    blocked = _guard(monkeypatch, {"3000": "小王", "3001": "小王"}, "小王", other="2000")
    assert blocked == "同名联系人不止一个，停止介绍并待人工核对"


def test_same_name_blocks_even_when_counterpart_is_one_of_them(monkeypatch):
    # 同名两人：即使对方就是其中之一，搜索框也分不清点哪个 → 仍然停下等人工
    blocked = _guard(monkeypatch, {"3000": "小王", "3001": "小王"}, "小王", other="3000")
    assert blocked == "同名联系人不止一个，停止介绍并待人工核对"

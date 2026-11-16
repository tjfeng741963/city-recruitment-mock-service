"""单轮单源 + 话术一次性 + 对话即上下文（2026-11-14 重构冻结契约）。

原则 1：每轮回复只有一个来源——运营话术 → 岗位事实卡 → 知识库 → 智能体
        → 都没答上才「确认一下」，绝不拼接。
原则 2：greet / send_info / booked 整个会话只发一次（scripted_sent 记账）；
        ask_interview 首次用话术，之后换说法追问。
原则 3：话术发完即移交智能体；决策 Prompt = 事实卡 + 缺失清单 + 最近历史。
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from app.services.flow_engine import (
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_SEND_INFO,
    TZ,
    new_state,
    set_position_scripts,
    set_remote_jobs,
    step,
)
from app.services.flow_llm import a_step, build_decision_messages
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=TZ)

# 带 position_id 的岗位（话术按岗位记账依赖它）
JOB = {
    "position_id": 3,
    "employer_id": 7,
    "factory_name": "观澜精密厂",
    "job_title": "观澜精密厂 质检",
    "wage_text": "23 元/小时",
    "hours_text": "两班倒，月休 4 天",
    "age_text": "18-40 岁",
    "welfare_text": "包吃包住",
    "place": "观澜大道 88 号",
}

SEND_INFO_SCRIPT = {
    "position_id": 3,
    "stage": "send_info",
    "title": "观澜质检岗介绍",
    "content": "运营专属台词：观澜精密厂在招质检，23 元/小时【图片:厂区大门.jpg】",
}
ASK_SCRIPT = {
    "position_id": 3,
    "stage": "ask_interview",
    "content": "明天上午能过来看看吗？",
}


class ScriptedProvider:
    def __init__(self, *replies: str | Exception) -> None:
        self.replies = list(replies)
        self.calls: list[list] = []

    async def complete(self, messages, **kwargs):  # noqa: ANN001, ANN003
        self.calls.append(messages)
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def _jobs():
    set_remote_jobs({**JOBS_BY_CITY, "深圳": [JOB]})
    yield
    set_remote_jobs({})
    set_position_scripts([])


# ── 原则 1：单轮单源 ─────────────────────────────────────────────


def test_send_info_script_is_the_only_part() -> None:
    """send_info 话术命中 → parts 只有话术段，不再拼一句邀约。"""
    set_position_scripts([SEND_INFO_SCRIPT])
    state = new_state()
    result = step(state, "深圳", now=NOW)

    assert len(result.parts) == 1
    assert "运营专属台词" in result.parts[0]
    assert "【图片:厂区大门.jpg】" in result.parts[0]  # 媒体标记原样保留
    assert "能不能过来面试" not in result.reply
    assert result.stage == STAGE_ASK_INTERVIEW
    # 发卡即钉岗位 + 记账
    assert state["slots"]["position_id"] == 3
    assert state["slots"]["scripted_sent"]["send_info:3"] is True


def test_wage_question_answers_from_snapshot_not_other_factory() -> None:
    """问「工资多少」答的是快照工价，绝不串到别家厂数字（KB 优先级之下）。"""
    state = new_state()
    step(state, "深圳", now=NOW)  # 发卡 → pin_position 写 job_snapshot
    answered = step(
        state,
        "工资多少",
        now=NOW,
        kb_answer="别家厂：转正 175/班，包住。",
    )

    assert "23 元/小时" in answered.reply
    assert "175" not in answered.reply  # 串厂数字被事实卡优先级拦下
    assert len(answered.parts) == 1  # 答完就停，不拼邀约


# ── 原则 2：话术一次性 ───────────────────────────────────────────


def test_send_info_script_not_resent_for_same_position() -> None:
    """同一岗位只发一次：重进 send_info（scripted_sent 生效）→ 落默认卡片。"""
    set_position_scripts([SEND_INFO_SCRIPT])
    state = new_state()
    step(state, "深圳", now=NOW)

    # 模拟会话重复进入 send_info（客户换需求重发）
    state["stage"] = STAGE_SEND_INFO
    state["slots"]["interview_offer_sent"] = False
    again = step(state, "深圳", now=NOW)

    assert "运营专属台词" not in again.reply  # 话术不再命中
    assert "厂名：" in again.parts[0]  # 代码拼的默认卡片接管
    assert len(again.parts) == 3


def test_ask_interview_script_sent_once_then_rephrased() -> None:
    """ask_interview 话术只出现一次；答非所问后追问换了说法、不含原话术全文。"""
    set_position_scripts([ASK_SCRIPT])
    state = new_state()
    card = step(state, "深圳", now=NOW)
    assert "明天上午能过来看看吗？" in card.reply  # 首次邀约用话术

    retry = step(state, "哦", now=NOW)
    assert retry.stage == STAGE_ASK_INTERVIEW
    assert "明天上午能过来看看吗？" not in retry.reply  # 不重复原话术
    assert "过来" in retry.reply  # 但仍在邀约（换了说法）


# ── 原则 3：决策 Prompt 与护栏 ───────────────────────────────────


def test_decision_prompt_carries_fact_card_and_missing_list() -> None:
    """决策 Prompt：事实卡给数字、缺失清单标出当前第一项缺失。"""
    state = new_state()
    step(state, "深圳", now=NOW)
    state["history"] = [
        {"role": "customer", "text": "深圳"},
        {"role": "agent", "text": "观澜精密厂……"},
    ]
    messages = build_decision_messages(state, "我在忙", now=NOW)

    system = messages[0].content
    assert "工价：23 元/小时" in system  # 事实卡
    assert "数字唯一合法来源" in system
    assert "当前只推进这一项" in system  # 缺失清单
    assert "观澜精密厂……" in system  # 最近对话历史
    user = messages[-1].content
    assert "我在忙" in user


@pytest.mark.asyncio
async def test_decision_capture_city_sends_code_built_card() -> None:
    """新契约 capture：模型抽到城市 → 代码发卡（话术/卡片是运营口径的来源）。"""
    provider = ScriptedProvider(
        json.dumps(
            {"reply": "好的，看看这个岗位", "capture": {"city": "东莞"}},
            ensure_ascii=False,
        )
    )
    state = new_state()
    result = await a_step(state, "投东莞的", provider, now=NOW)

    assert result.stage == STAGE_ASK_INTERVIEW
    assert "厂名：长安五金厂" in result.parts[0]  # 代码拼卡，模型措辞不采用
    assert state["slots"]["city"] == "东莞"


@pytest.mark.asyncio
async def test_fabricated_wage_blocked_by_fact_guard() -> None:
    """模型编造工价：事实护栏拦下整段回复，退确定性兜底，不空回复。"""
    state = new_state()
    step(state, "深圳", now=NOW)  # 事实卡就位（23 元/小时）
    provider = ScriptedProvider(
        json.dumps(
            {"reply": "跟你说实话吧，这个岗时薪30，干满还有奖励。", "capture": {}},
            ensure_ascii=False,
        )
    )
    result = await a_step(state, "我考虑一下", provider, now=NOW)

    assert result.reply  # 不空回复
    assert "30" not in result.reply  # 编造数字整段丢弃
    assert result.stage == STAGE_ASK_INTERVIEW


@pytest.mark.asyncio
async def test_bad_phone_in_capture_never_enters_slots() -> None:
    """姓名电话捕获由代码校验：坏格式电话丢弃，不入 slots。"""
    state = new_state()
    state["stage"] = STAGE_COLLECT
    state["slots"].update(
        {"city": "深圳", "job_index": 0, "interview_offer_sent": True, "interview_agreed": True}
    )
    provider = ScriptedProvider(
        json.dumps(
            {"reply": "好的，登记一下。", "capture": {"name": "李四", "phone": "12345"}},
            ensure_ascii=False,
        )
    )
    result = await a_step(state, "李四 12345", provider, now=NOW)

    assert result.slots.get("name") == "李四"  # 合法姓名照收
    assert result.slots.get("phone") in (None, "")  # 坏电话丢弃
    assert result.slots.get("booked") is None  # 电话没拿到不许约成


@pytest.mark.asyncio
async def test_llm_down_falls_back_deterministically() -> None:
    """模型不可用：确定性状态机兜底，不空回复。"""
    provider = ScriptedProvider(RuntimeError("upstream 502"))
    state = new_state()
    state["stage"] = STAGE_ASK_INTERVIEW
    state["slots"].update({"city": "东莞", "job_index": 0, "interview_offer_sent": True})

    result = await a_step(state, "可以", provider, now=NOW)
    assert result.reply
    assert result.stage == STAGE_COLLECT

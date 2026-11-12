"""LLM 驱动层的测试：模型说了算，但三条红线不能被它踩。

1. 工作信息只能由代码从岗位数据拼（模型复述就有编工价的可能）
2. 约面试的时间由代码算，姓名手机不齐不许约
3. 模型挂了，客户也必须有话说；插问一律走知识库占位，不让模型自由发挥
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from app.services.flow_engine import (
    ACTION_BOOK,
    ACTION_GAVE_UP,
    INTERVIEW_WINDOW,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    TZ,
    new_state,
    set_remote_jobs,
)
from app.services.flow_llm import a_step, build_messages
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 8, 14, 0, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _remote_jobs():
    """引擎只认注入的远端岗位：测试统一注入岗位夹具。"""
    set_remote_jobs(JOBS_BY_CITY)
    yield
    set_remote_jobs({})


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


def _state_after_info() -> dict:
    """信息已发、正在等客户表态。"""
    state = new_state()
    state["stage"] = STAGE_ASK_INTERVIEW
    state["slots"].update({"city": "东莞", "job_index": 0, "interview_offer_sent": True})
    state["history"] = [
        {"role": "customer", "text": "东莞的 有什么岗位吗"},
        {"role": "agent", "text": "厂名：长安五金厂……"},
    ]
    return state


@pytest.mark.asyncio
async def test_city_turn_sends_code_built_info_parts() -> None:
    """说了城市：工作信息由代码拼成多段，模型的措辞在这轮不采用。"""
    provider = ScriptedProvider(
        json.dumps(
            {"reply": "东莞这边有厂在招，你要不要来？", "stage": "send_info", "slots": {"city": "东莞"}},
            ensure_ascii=False,
        )
    )
    state = new_state()
    result = await a_step(state, "东莞", provider, now=NOW)

    assert result.stage == STAGE_ASK_INTERVIEW
    assert len(result.parts) >= 2
    assert result.reply == "\n".join(result.parts)
    assert "厂名：长安五金厂" in result.parts[0]
    assert "19 元/小时" in result.parts[0]
    assert INTERVIEW_WINDOW in result.parts[1]
    assert "要不要来" not in result.reply


@pytest.mark.asyncio
async def test_model_reply_is_used_and_slots_applied() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "能来的话我这边给你留名额，你大概几点到？",
                "stage": "ask_interview",
                "slots": {"city": "东莞"},
                "action": None,
                "finished": False,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "我看看时间", provider, now=NOW)

    assert "留名额" in result.reply
    assert result.stage == STAGE_ASK_INTERVIEW
    assert result.slots["city"] == "东莞"


@pytest.mark.asyncio
async def test_fabricated_pay_falls_back() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "长安五金厂 30 元/小时，包吃包住，你来不来？",
                "stage": "ask_interview",
                "slots": {"city": "东莞"},
                "finished": False,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "工价多少", provider, now=NOW)
    assert "30 元" not in result.reply


@pytest.mark.asyncio
async def test_booking_requires_name_and_phone() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "好嘞，那就这么定了。",
                "stage": "done",
                "slots": {"city": "东莞"},
                "action": ACTION_BOOK,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    state["slots"]["interview_agreed"] = True
    state["stage"] = STAGE_COLLECT
    result = await a_step(state, "可以", provider, now=NOW)

    # 姓名手机没齐，不许约成
    assert result.stage == STAGE_COLLECT
    assert result.slots.get("booked") is None
    assert "姓名" in result.reply and "手机" in result.reply


@pytest.mark.asyncio
async def test_booking_time_comes_from_code() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "好嘞，明天见。",
                "stage": "done",
                "slots": {"city": "东莞"},
                "profile": {"name": "张三", "phone": "13800138000"},
                "action": ACTION_BOOK,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    state["slots"]["interview_agreed"] = True
    state["stage"] = STAGE_COLLECT
    result = await a_step(state, "张三 13800138000", provider, now=NOW)

    assert result.finished is True
    assert result.stage == STAGE_DONE
    assert result.slots["interview_at"] == "2026-11-09T09:00:00+08:00"
    assert result.slots["interview_place"] == "长安镇乌沙社区"
    assert result.slots["interview_window"] == INTERVIEW_WINDOW


@pytest.mark.asyncio
async def test_gave_up_action_ends_flow() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "行，那你想来再说。",
                "stage": "done",
                "action": ACTION_GAVE_UP,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "这两天来不了", provider, now=NOW)

    assert result.stage == STAGE_DONE and result.finished is True
    assert result.action == ACTION_GAVE_UP
    assert result.slots["recruit_status"] == "disqualified"


@pytest.mark.asyncio
async def test_model_failure_still_replies() -> None:
    provider = ScriptedProvider(RuntimeError("upstream 502"))
    state = _state_after_info()
    result = await a_step(state, "可以", provider, now=NOW)
    assert result.reply
    assert result.stage == STAGE_COLLECT


@pytest.mark.asyncio
async def test_kb_question_skips_model() -> None:
    """插问不走模型：命中就回知识库原话，避免模型编「体检费全报」。"""
    provider = ScriptedProvider("不该被用到的回复")
    state = _state_after_info()
    result = await a_step(
        state, "体检要花钱吗", provider, now=NOW, kb_answer="体检费先自己出，满一个月报销。"
    )

    assert provider.calls == []
    assert result.parts[0] == "体检费先自己出，满一个月报销。"
    assert result.stage == STAGE_ASK_INTERVIEW


@pytest.mark.asyncio
async def test_kb_miss_reports_unknown_question_without_model() -> None:
    provider = ScriptedProvider("不该被用到的回复")
    state = _state_after_info()
    result = await a_step(state, "宿舍有没有空调", provider, now=NOW)

    assert provider.calls == []
    assert result.unknown_question == "宿舍有没有空调"
    assert "这个我确认一下，稍后回你" in result.reply


def test_surface_only_carries_recent_context() -> None:
    state = _state_after_info()
    state["history"] = [
        {"role": "customer", "text": f"历史{i}"} for i in range(30)
    ] + [{"role": "customer", "text": "最新一句"}]
    messages = build_messages(state, "最新一句", now=NOW)
    user = messages[-1].content
    assert "最新一句" in user
    assert "历史0" not in user
    assert "19 元/小时" in messages[0].content  # 岗位数据在系统提示里


@pytest.mark.asyncio
async def test_done_never_calls_model() -> None:
    """约好之后客户再发消息：不调模型、不改状态、不回话。"""
    provider = ScriptedProvider("不该被用到的回复")
    state = new_state()
    state["stage"] = STAGE_DONE
    state["slots"] = {"city": "广州", "booked": True}

    result = await a_step(state, "我到了找谁", provider, now=NOW)
    # 新契约（2026-11-12）：已约客户再来消息不再静默——回确认信息，但绝不调模型
    assert "约好面试" in result.reply and result.reply != ""
    assert result.finished is True
    assert result.stage == STAGE_DONE
    assert provider.calls == []

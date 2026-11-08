"""LLM 驱动层的测试：模型说了算，但三条红线不能被它踩。

1. 不许编工价（回复里的「N 元」必须在岗位数据里）
2. 约面试的时间地点由代码算，不信模型嘴上的
3. 模型挂了，客户也必须有话说
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from app.services.flow_engine import (
    ACTION_BOOK,
    STAGE_ASK_GENDER,
    STAGE_CONFIRM,
    TZ,
    new_state,
)
from app.services.flow_llm import a_step, build_messages

NOW = datetime(2026, 11, 8, 14, 0, tzinfo=TZ)


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


def _state_after_city() -> dict:
    state = new_state()
    state["stage"] = STAGE_ASK_GENDER
    state["slots"].update({"city": "东莞", "job_index": 0})
    state["history"] = [
        {"role": "customer", "text": "东莞的 有什么岗位吗"},
        {"role": "agent", "text": "东莞这边有长安五金厂在招，19 元/小时。"},
    ]
    return state


@pytest.mark.asyncio
async def test_model_reply_is_used_and_slots_applied() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "长安五金厂在做，19 元/小时，包住饭补 300。你是男生女生？",
                "stage": "ask_gender",
                "slots": {"city": "东莞", "gender": ""},
                "action": None,
                "finished": False,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_city()
    result = await a_step(state, "还有其他的吗 我是男生", provider, now=NOW)

    assert "长安五金厂" in result.reply
    assert result.stage == STAGE_ASK_GENDER
    assert result.slots["city"] == "东莞"


@pytest.mark.asyncio
async def test_fabricated_pay_falls_back() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "长安五金厂 30 元/小时，包吃包住，你来不来？",
                "stage": "ask_gender",
                "slots": {"city": "东莞"},
                "finished": False,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_city()
    result = await a_step(state, "工价多少", provider, now=NOW)
    assert "30 元" not in result.reply


@pytest.mark.asyncio
async def test_booking_time_comes_from_code() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "好嘞，那就明天下午三点，长安镇乌沙社区见。",
                "stage": "confirm",
                "slots": {"city": "东莞", "gender": "男", "record": "无"},
                "action": ACTION_BOOK,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_city()
    state["stage"] = STAGE_CONFIRM
    state["slots"].update({"gender": "男", "record": "无"})
    result = await a_step(state, "可以", provider, now=NOW)

    assert result.finished is True
    assert result.slots["interview_at"] == "2026-11-09T13:00:00+08:00"
    assert result.slots["interview_place"] == "长安镇乌沙社区"


@pytest.mark.asyncio
async def test_model_failure_still_replies() -> None:
    provider = ScriptedProvider(RuntimeError("upstream 502"))
    state = _state_after_city()
    result = await a_step(state, "男", provider, now=NOW)
    assert result.reply
    assert "犯罪记录" in result.reply


def test_surface_only_carries_recent_context() -> None:
    state = _state_after_city()
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
    from app.services.flow_engine import STAGE_DONE

    provider = ScriptedProvider("不该被用到的回复")
    state = new_state()
    state["stage"] = STAGE_DONE
    state["slots"] = {"city": "广州", "gender": "男", "record": "无", "booked": True}

    result = await a_step(state, "我到了找谁", provider, now=NOW)
    assert result.reply == ""
    assert result.finished is True
    assert result.stage == STAGE_DONE
    assert provider.calls == []

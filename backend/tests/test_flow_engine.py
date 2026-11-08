"""招聘对话流程测试：六步走完，落到约面试。

验收点：
- 每一步问的东西不重复、不跳步
- 客户中途插问（地铁/工资）能答，且不打断流程
- 约面试默认次日 13:00
- done 之后不再自动回复
"""

from __future__ import annotations

import json
from datetime import datetime

from app.models_flow import FlowEvent
from app.services.flow_engine import (
    STAGE_ASK_CITY,
    STAGE_ASK_GENDER,
    STAGE_ASK_RECORD,
    STAGE_CONFIRM,
    STAGE_DONE,
    TZ,
    new_state,
    next_noon,
    step,
)
from app.services.flow_session import EVENT_INBOUND, EVENT_REPLY, EVENT_STAGE, project

NOW = datetime(2026, 11, 8, 13, 30, tzinfo=TZ)


def _run(turns: list[str]):
    state = new_state()
    results = [step(state, text, now=NOW) for text in turns]
    return state, results


def test_full_flow_reaches_interview() -> None:
    state, results = _run(["在吗", "广州", "女", "没有", "可以"])

    assert results[0].stage == STAGE_ASK_CITY
    assert "哪个城市" in results[0].reply

    assert results[1].stage == STAGE_ASK_GENDER
    assert "利口福" in results[1].reply and "16 元/小时" in results[1].reply
    assert "男生还是女生" in results[1].reply

    assert results[2].stage == STAGE_ASK_RECORD
    assert "犯罪记录" in results[2].reply

    assert results[3].stage == STAGE_CONFIRM
    assert results[3].slots["interview_at"].startswith("2026-11-09T13:00")
    assert "方便吗" in results[3].reply

    assert results[4].stage == STAGE_DONE
    assert results[4].finished is True
    assert results[4].action == "book_interview"
    assert "祝你面试顺利" in results[4].reply
    assert state["slots"]["gender"] == "女"
    assert state["slots"]["record"] == "无"


def test_done_goes_silent() -> None:
    state, _ = _run(["广州", "男", "没有", "可以"])
    after = step(state, "我明天几点到？", now=NOW)
    assert after.stage == STAGE_DONE
    assert after.finished is True
    assert after.reply == ""


def test_faq_does_not_break_stage() -> None:
    state, _ = _run(["广州"])
    # 这一轮在问性别，客户却问地铁
    answer = step(state, "坐地铁怎么去？", now=NOW)
    assert "番禺南村员岗地铁站附近" in answer.reply
    assert answer.stage == STAGE_ASK_GENDER
    # 追问还在，客户接着答性别即可
    nxt = step(state, "男的", now=NOW)
    assert nxt.stage == STAGE_ASK_RECORD


def test_city_from_earlier_turn_is_kept() -> None:
    state, _ = _run(["我在番禺", "嗯"])
    assert state["slots"]["city"] == "广州"


def test_record_yes_hands_off_instead_of_booking() -> None:
    state, results = _run(["广州", "男", "有案底"])
    assert state["slots"]["record"] == "有"
    assert results[-1].action == "handoff"
    assert state["stage"] == STAGE_DONE
    assert "interview_at" not in state["slots"]


def test_disagree_postpones() -> None:
    state, _ = _run(["广州", "女", "没有"])
    again = step(state, "明天不行，改天吧", now=NOW)
    assert again.stage == STAGE_CONFIRM
    assert "哪天方便" in again.reply


def test_next_noon_is_tomorrow_13() -> None:
    when = next_noon(NOW)
    assert when.day == 9 and when.hour == 13 and when.minute == 0


def test_projection_rebuilds_state() -> None:
    """覆盖写会丢历史；投影必须能从事件流里还原出同样的状态。"""
    events = [
        FlowEvent(session_key="c1", seq=1, type=EVENT_INBOUND,
                  body=json.dumps({"text": "广州"})),
        FlowEvent(session_key="c1", seq=2, type=EVENT_STAGE,
                  body=json.dumps({"from": STAGE_ASK_CITY, "to": STAGE_ASK_GENDER})),
        FlowEvent(session_key="c1", seq=3, type="slot_set",
                  body=json.dumps({"key": "city", "value": "广州"})),
        FlowEvent(session_key="c1", seq=4, type=EVENT_REPLY,
                  body=json.dumps({"text": "我们是男生还是女生？"})),
    ]
    state = project(events)
    assert state["stage"] == STAGE_ASK_GENDER
    assert state["slots"]["city"] == "广州"
    assert state["turns"] == 1
    assert [h["role"] for h in state["history"]] == ["customer", "agent"]

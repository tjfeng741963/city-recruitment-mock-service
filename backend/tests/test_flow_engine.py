"""对话流程 v2：ask_city → send_info → ask_interview → collect → done。

验收点：
- 五个阶段按顺序推进，不重复、不跳步
- send_info 一轮发多段（parts ≥ 2），reply 就是 parts 拼起来的
- 拒绝面试直接结束（gave_up），只给姓名/只给手机都不前进
- 知识库命中就答、没命中兜底并交回原话（记 unknown_questions）
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from app.models_flow import FlowEvent
from app.services.flow_engine import (
    ACTION_BOOK,
    ACTION_GAVE_UP,
    INTERVIEW_WINDOW,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    TZ,
    extract_name,
    extract_phone,
    new_state,
    next_interview,
    set_remote_jobs,
    step,
)
from app.services.flow_session import EVENT_INBOUND, EVENT_REPLY, EVENT_STAGE, project
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 8, 13, 30, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _remote_jobs():
    """引擎只认注入的远端岗位：测试统一注入岗位夹具。"""
    set_remote_jobs(JOBS_BY_CITY)
    yield
    set_remote_jobs({})


def _run(turns: list[str], kb: str | None = None):
    state = new_state()
    results = [step(state, text, now=NOW, kb_answer=kb) for text in turns]
    return state, results


def test_full_flow_reaches_interview() -> None:
    state, results = _run(["你好", "广州", "可以", "张三 13800138000"])

    assert results[0].stage == STAGE_ASK_CITY
    assert "哪个城市" in results[0].reply

    # 说了城市就发信息，一轮发完，自动进邀约
    assert results[1].stage == STAGE_ASK_INTERVIEW
    assert "利口福食品厂" in results[1].reply
    assert "16 元/小时" in results[1].reply
    assert "能不能过来面试" in results[1].reply

    # 答应之后才要姓名手机，而且一次问两个
    assert results[2].stage == STAGE_COLLECT
    assert "姓名" in results[2].reply and "手机" in results[2].reply

    assert results[3].stage == STAGE_DONE
    assert results[3].finished is True
    assert results[3].action == ACTION_BOOK
    assert "期待你来面试，到了联系我" in results[3].reply

    slots = state["slots"]
    assert slots["name"] == "张三" and slots["phone"] == "13800138000"
    assert slots["interview_at"].startswith("2026-11-09T09:00")
    assert slots["interview_place"] == "番禺南村员岗地铁站附近"


def test_send_info_returns_multiple_parts() -> None:
    _, results = _run(["东莞"])
    info = results[0]

    assert info.stage == STAGE_ASK_INTERVIEW
    assert len(info.parts) >= 2
    assert info.reply == "\n".join(info.parts)
    # 段1：厂名 / 工价 / 班次 / 年龄 / 吃住
    assert "厂名：" in info.parts[0] and "长安五金厂" in info.parts[0]
    for label in ("工价：", "班次：", "年龄：", "吃住："):
        assert label in info.parts[0]
    # 段2：面试地点 + 时间窗口
    assert "面试地点：长安镇乌沙社区" in info.parts[1]
    assert INTERVIEW_WINDOW in info.parts[1]
    # 段3：邀约问句（客户端逐条发，客户才会被问到）
    assert "能不能过来面试" in info.parts[-1]
    assert info.attachments == []


def test_done_goes_silent() -> None:
    state, _ = _run(["广州", "可以", "张三 13800138000"])
    after = step(state, "我明天几点到？", now=NOW)
    assert after.stage == STAGE_DONE
    assert after.finished is True
    assert after.reply == "" and after.parts == []


def test_refuse_interview_ends_flow() -> None:
    state, results = _run(["广州", "这两天不行，来不了"])
    refusal = results[-1]

    assert refusal.stage == STAGE_DONE
    assert refusal.finished is True
    assert refusal.action == ACTION_GAVE_UP
    assert state["slots"]["recruit_status"] == "disqualified"
    assert "name" not in state["slots"]

    after = step(state, "那我再想想", now=NOW)
    assert after.reply == ""


def test_only_name_does_not_advance() -> None:
    state, _ = _run(["广州", "可以"])
    assert state["stage"] == STAGE_COLLECT

    only_name = step(state, "我叫王五", now=NOW)
    assert only_name.stage == STAGE_COLLECT
    assert "手机" in only_name.reply
    assert state["slots"]["name"] == "王五"
    assert not state["slots"].get("phone")

    only_phone = step(state, "13512345678", now=NOW)
    assert only_phone.stage == STAGE_DONE
    assert only_phone.action == ACTION_BOOK


def test_phone_first_then_name() -> None:
    state, _ = _run(["深圳", "可以"])
    first = step(state, "13512345678", now=NOW)
    assert first.stage == STAGE_COLLECT
    assert "姓名" in first.reply
    second = step(state, "我叫赵六", now=NOW)
    assert second.stage == STAGE_DONE
    assert state["slots"] == {**state["slots"], "name": "赵六", "phone": "13512345678"}


def test_kb_hit_answers_and_keeps_stage() -> None:
    state, _ = _run(["广州"])
    answered = step(state, "体检要花钱吗", now=NOW, kb_answer="体检费自己先出，满一个月厂里报销。")

    assert answered.stage == STAGE_ASK_INTERVIEW
    assert answered.parts[0] == "体检费自己先出，满一个月厂里报销。"
    assert "能不能过来面试" in answered.parts[-1]
    assert answered.unknown_question == ""
    # 答完还在邀约，客户接着答应就行
    assert step(state, "那可以", now=NOW).stage == STAGE_COLLECT


def test_kb_miss_falls_back_and_reports_question() -> None:
    state, _ = _run(["广州"])
    missed = step(state, "宿舍有没有空调", now=NOW)

    assert missed.stage == STAGE_ASK_INTERVIEW
    assert "这个我确认一下，稍后回你" in missed.reply
    assert missed.unknown_question == "宿舍有没有空调"
    assert "能不能过来面试" in missed.reply


def test_vague_reply_just_repeats_question() -> None:
    _, results = _run(["广州", "……"])
    vague = results[-1]
    assert vague.stage == STAGE_ASK_INTERVIEW
    assert vague.unknown_question == ""


def test_province_city_district_are_extracted() -> None:
    state, _ = _run(["广东省广州市白云区"])
    slots = state["slots"]
    assert slots["province"] == "广东省"
    assert slots["city"] == "广州"
    assert slots["district"] == "白云区"


def test_city_from_earlier_turn_is_kept() -> None:
    state, _ = _run(["我在番禺"])
    assert state["slots"]["city"] == "广州"


def test_next_interview_is_tomorrow_nine() -> None:
    when = next_interview(NOW)
    assert when.day == 9 and when.hour == 9 and when.minute == 0


def test_extractors() -> None:
    assert extract_phone("我电话 138-0013-8000") == "13800138000"
    assert extract_phone("微信同号") == ""
    assert extract_name("我叫张三，电话13800138000") == "张三"
    assert extract_name("广州") == ""
    # collect 阶段才敢把光秃秃的两三个字当名字
    assert extract_name("张三 13800138000", strict=True) == "张三"
    assert extract_name("13800138000", strict=True) == ""


def test_projection_rebuilds_state() -> None:
    """覆盖写会丢历史；投影必须能从事件流里还原出同样的状态。"""
    events = [
        FlowEvent(session_key="c1", seq=1, type=EVENT_INBOUND,
                  body=json.dumps({"text": "广州"})),
        FlowEvent(session_key="c1", seq=2, type=EVENT_STAGE,
                  body=json.dumps({"from": STAGE_ASK_CITY, "to": STAGE_ASK_INTERVIEW})),
        FlowEvent(session_key="c1", seq=3, type="slot_set",
                  body=json.dumps({"key": "city", "value": "广州"})),
        FlowEvent(session_key="c1", seq=4, type=EVENT_REPLY,
                  body=json.dumps({"text": "面试地点……", "parts": ["面试地点……"]})),
    ]
    state = project(events)
    assert state["stage"] == STAGE_ASK_INTERVIEW
    assert state["slots"]["city"] == "广州"
    assert state["turns"] == 1
    assert [h["role"] for h in state["history"]] == ["customer", "agent"]

"""2026-11-15 知识库问答 + 约后流程回归（真实聊天记录复盘后补齐）。

覆盖：
1. 真实客户高频问句要按岗位事实答，不能掉成「确认一下 + 再邀约」
2. 吃住字段被线路占用时回落 dorm_text，不冒充吃住
3. 客户自报年龄超上限要直接指出，不装傻
4. 同一问题连问三次不能逐字复读
5. 已约客户口语改期（能改到下午吗 / 明天有事能改后天吗 / 改天行不行 / 晚点到）
6. 已约客户补发姓名电话要回「已更新」，不是再邀约
7. 约完问「面试在哪儿」要答地点
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.services import flow_engine as engine, flow_llm

NOW = datetime(2026, 11, 15, 8, tzinfo=engine.TZ)

JOB = {
    "position_id": 16,
    "employer_id": 11,
    "city": "广东城际",
    "factory_name": "广东城际地铁安检",
    "job_title": "安检员",
    "place": "陈村基地",
    "wage_text": "150/班，连上两个班 300/天",
    "hours_text": "8小时/班，两班倒",
    "rest_text": "月休4天",
    "age_text": "18-45岁",
    "welfare_text": "安排线路：广东城际全线路",
    "dorm_text": "4-6人间，空调热水齐全，水电平摊",
    "line_text": "广东城际全线路",
    "medical_text": "入职体检自费80元，满一个月报销",
    "insurance_text": "试用期商业保险40元/月，转正买社保",
    "advance_text": "月结，每月15号发，可预支",
    "tattoo_policy": "小面积不查，花臂不行",
    "height_text": "女155以上，男165以上",
    "cert_text": "不需要证书",
    "interview_time": "14:00-16:00",
}


@pytest.fixture(autouse=True)
def jobs():
    engine.set_remote_cities([{"city_name": "广东城际"}])
    engine.set_remote_jobs({"广东城际": [dict(JOB)]})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_remote_cities([])
    engine.set_position_scripts([])


async def turn(state, text, model=False):
    if model:
        return await flow_llm.a_step(state, text, None, now=NOW)
    return engine.step(state, text, now=NOW)


async def asked_state(question: str, model: bool = False) -> str:
    """发完岗位卡之后问一句，返回回复。"""
    state = engine.new_state()
    await turn(state, "广东城际", model)
    return (await turn(state, question, model)).reply


# ── 1. 真实高频问句必须答到点上 ──────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize(
    "question,expected",
    [
        ("包吃住吗", "住宿：4-6人间"),
        ("宿舍几人间有空调吗", "住宿：4-6人间"),
        ("什么时候面试", "面试时间：14:00-16:00"),
        ("一天上几个小时", "班次：8小时/班"),
        ("一个月休几天", "月休：月休4天"),
        ("多大年龄能做", "年龄要求：18-45岁"),
        # 体检/社保属于政策口径，按岗位配好的 FAQ 答；没配就确认一下，不拿岗位字段冒充
        ("有社保吗", ""),
        ("体检费谁出", ""),
        ("有日结吗", "发薪/预支：月结"),
        ("纹身能不能进", "纹身要求：小面积不查"),
        ("身高有要求吗", "身高要求：女155以上"),
        ("工资怎么算", "工价：150/班"),
        ("要押金吗", ""),
    ],
)
async def test_real_questions_answered_from_job(question, expected, model):
    reply = await asked_state(question, model)
    if expected:
        assert expected in reply, f"{question} → {reply}"
        assert "确认一下" not in reply
    else:
        # 岗位里没有押金字段：允许说确认一下，但不能答成工价/邀约
        assert "工价：" not in reply


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_age_over_limit_is_flagged(model):
    reply = await asked_state("我52了还能去吗", model)
    assert "超了" in reply and "18-45" in reply


# ── 2. 同一问题连问三次不能复读 ──────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_unknown_question_not_repeated_verbatim(model):
    state = engine.new_state()
    await turn(state, "广东城际", model)
    replies = [(await turn(state, "要押金吗", model)).reply for _ in range(3)]
    assert len(set(replies)) == 3, replies


# ── 3. 已约客户改期 ──────────────────────────────────────────────────
async def _booked(model: bool = False):
    state = engine.new_state()
    await turn(state, "广东城际", model)
    await turn(state, "可以，明天下午过去面试", model)
    booked = await turn(state, "我叫陈志强 13800138000", model)
    assert booked.stage == "done" and booked.slots.get("booked")
    return state


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize(
    "text,expect_day,expect_window",
    [
        ("能改到下午吗", 16, "下午14:00-16:00"),
        ("我明天有事，能改后天吗", 17, "下午14:00-16:00"),
        ("改到后天吧", 17, "下午14:00-16:00"),
        ("面试改到后天下午", 17, "下午14:00-16:00"),
        ("能提前一点吗", 16, "下午14:00-16:00"),
    ],
)
async def test_reschedule_spoken_forms(text, expect_day, expect_window, model):
    state = await _booked(model)
    result = await turn(state, text, model)
    assert result.stage == "done"
    assert result.slots.get("recruit_status") != "disqualified"
    at = datetime.fromisoformat(result.slots["interview_at"])
    assert at.day == expect_day, f"{text} → {result.reply}"
    assert result.slots["interview_window"] == expect_window


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_vague_reschedule_asks_instead_of_disqualifying(model):
    state = await _booked(model)
    result = await turn(state, "改天行不行", model)
    assert result.stage == "done"
    assert result.slots.get("recruit_status") != "disqualified"
    assert result.slots.get("booked") is True
    assert "哪天" in result.reply


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_late_arrival_is_not_reschedule(model):
    state = await _booked(model)
    before = state["slots"]["interview_at"]
    result = await turn(state, "我晚点到", model)
    assert result.slots["interview_at"] == before
    assert result.slots.get("recruit_status") != "disqualified"
    assert "路上注意安全" in result.reply


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_vague_reschedule_before_booking_not_disqualified(model):
    state = engine.new_state()
    await turn(state, "广东城际", model)
    result = await turn(state, "能改天吗", model)
    assert result.slots.get("recruit_status") != "disqualified"
    assert "哪天" in result.reply


# ── 4. 已约后补资料 / 问地点 ─────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_booked_customer_contact_update_is_acknowledged(model):
    state = await _booked(model)
    result = await turn(state, "电话改成 13900139000", model)
    assert result.slots["phone"] == "13900139000"
    assert "更新好了" in result.reply
    assert "这两天能不能过来面试" not in result.reply


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_booked_customer_asks_place(model):
    state = await _booked(model)
    result = await turn(state, "面试到底在哪儿啊", model)
    assert "陈村基地" in result.reply
    assert "不打扰" not in result.reply

"""隔离压测确认的 8 个流程缺陷，逐场景锁死（修复前全部失败）。

1. P0-1 时段死锁不可恢复：period 与公布时段冲突后，说对时段/确认都解不了锁
2. P0-2 口语反悔误判 disqualified：拒绝词混着意向信号被当成放弃 + done 黑洞
3. P1-3 name 槽被非姓名文本污染：「确认」「下午吧」进了 name
4. P1-4 已定时段不可改口：新时段词必须覆盖旧 period
5. P2-5 登记确认缺工厂名：地方+工厂+姓名+电话+面试时间 五要素
6. P2-6 回复与槽位矛盾：说了后天回复却写明天
7. P2-7 换岗后流程不推进：对新岗位表态同意要能进 collect
8. P3-8 报错时间：客户说的时间必须渲染成岗位公布的时段
"""
from datetime import datetime

import pytest

from app.services import flow_engine as engine, flow_llm
from app.services.profile_push import build_profile

NOW = datetime(2026, 11, 15, 8, tzinfo=engine.TZ)
JOB_MORNING = {"position_id": 17, "employer_id": 9, "factory_name": "广东城际地铁安检",
               "city": "广州", "place": "竹料基地", "wage_text": "130/班次",
               "interview_time": "上午9:00-12:00"}
JOB_BOTH = {"position_id": 17, "employer_id": 9, "factory_name": "广东城际地铁安检",
            "city": "广州", "place": "竹料基地", "wage_text": "130/班次",
            "interview_time": "上午9:00-12:00\n下午14:30-17:00"}
JOB_A = {**JOB_BOTH, "position_id": 101, "employer_id": 11, "factory_name": "甲厂"}
JOB_B = {**JOB_BOTH, "position_id": 202, "employer_id": 22, "factory_name": "穗厂"}


@pytest.fixture(autouse=True)
def jobs():
    engine.set_remote_jobs({"广州": [dict(JOB_BOTH)]})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_position_scripts([])


async def turn(state, text, model=False):
    return (await flow_llm.a_step(state, text, None, now=NOW) if model
            else engine.step(state, text, now=NOW))


# ── [P0-1] 时段死锁不可恢复 ─────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize("text", ["那就上午吧", "好"])
async def test_period_conflict_recovers_via_new_period_or_confirm(text, model):
    engine.set_remote_jobs({"广州": [dict(JOB_MORNING)]})
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以，我明天下午去竹料基地面试", model)
    stuck = await turn(state, "我叫张三，手机号是13800138000", model)
    assert stuck.stage == "collect" and not stuck.slots.get("booked")
    # 提示语必须列出可选时段，不能只说「哪个时段方便」
    assert "上午09:00-12:00" in stuck.reply
    booked = await turn(state, text, model)
    assert booked.stage == "done" and booked.action == "book_interview"
    assert booked.slots["interview_period"] == "上午"
    assert booked.slots["interview_window"] == "上午09:00-12:00"
    assert "上午09:00-12:00" in booked.reply


# ── [P0-2] 口语反悔误判 disqualified ───────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_refusal_with_intent_is_not_disqualified(model):
    engine.set_remote_jobs({"广州": [dict(JOB_BOTH)]})
    # 「算了 就这个吧 怎么面试」→ 收登记，不是放弃
    state = engine.new_state()
    await turn(state, "广州", model)
    result = await turn(state, "算了 就这个吧 怎么面试", model)
    assert result.stage == "collect" and "姓名" in result.reply
    assert result.slots.get("recruit_status") != "disqualified" and not result.action
    booked = await turn(state, "我叫张三，手机号是13800138000", model)
    assert booked.stage == "done" and booked.action == "book_interview"

    # 「先不去了 不过想了解下工资」→ 答工资，不判拒
    state = engine.new_state()
    await turn(state, "广州", model)
    result = await turn(state, "先不去了 不过想了解下工资", model)
    assert result.stage != "done" and not result.action
    assert "130/班次" in result.reply
    assert result.slots.get("recruit_status") != "disqualified"

    # 「算了 帮我登记一下 明天去」→ 进 collect 收资料
    state = engine.new_state()
    await turn(state, "广州", model)
    result = await turn(state, "算了 帮我登记一下 明天去", model)
    assert result.stage == "collect" and result.slots.get("recruit_status") != "disqualified"
    assert result.slots["interview_day_offset"] == 1


# ── [P0-2b] done 黑洞复活 ──────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize("text", ["行 帮我登记一下 张三 13800138000", "张三 13800138000"])
async def test_done_customer_revives_and_books(text, model):
    state = engine.new_state()
    await turn(state, "广州", model)
    declined = await turn(state, "那我去不了面试", model)
    assert declined.stage == "done" and declined.slots["recruit_status"] == "disqualified"
    # 纯确认仍是礼貌收尾，不复活
    ack = await turn(state, "收到", model)
    assert ack.stage == "done" and not ack.action
    revived = await turn(state, text, model)
    assert revived.stage == "done" and revived.action == "book_interview"
    assert revived.slots["name"] == "张三" and revived.slots["phone"] == "13800138000"
    assert revived.slots.get("recruit_status") != "disqualified"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_done_revival_with_missing_phone_returns_to_collect(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "那我去不了面试", model)
    revived = await turn(state, "又想了 想报名 张三", model)
    assert revived.stage == "collect" and revived.slots["name"] == "张三"
    assert revived.slots.get("recruit_status") != "disqualified"
    assert "手机" in revived.reply


# ── [P1-3] name 槽守卫 ─────────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_name_slot_rejects_confirmation_and_period_words(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以，明天上午过去面试", model)
    assert state["stage"] == "collect"
    await turn(state, "确认", model)
    assert not state["slots"].get("name")
    await turn(state, "下午吧", model)
    assert not state["slots"].get("name")
    assert state["slots"]["interview_period"] == "下午"
    # 显式姓名仍然收得到
    booked = await turn(state, "我叫张三，手机号是13800138000", model)
    assert booked.slots["name"] == "张三" and booked.stage == "done"


# ── [P1-4] 已定时段可改口 ──────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_new_period_word_overrides_previous_choice(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以，明天上午过去面试", model)
    assert state["slots"]["interview_period"] == "上午"
    await turn(state, "那就下午两点吧", model)
    assert state["slots"]["interview_period"] == "下午"
    booked = await turn(state, "我叫张三，手机号是13800138000", model)
    assert booked.stage == "done" and booked.slots["interview_window"] == "下午14:30-17:00"


# ── [P2-5] 登记确认五要素（地方+工厂+姓名+电话+面试时间）────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_booking_confirmation_includes_factory_name(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以", model)
    booked = await turn(state, "我叫张三，手机号是13800138000", model)
    assert booked.stage == "done"
    for piece in ("张三", "13800138000", "竹料基地", "广东城际地铁安检",
                  "上午9:00-12:00"):
        assert piece in booked.reply, piece
    profile = build_profile(booked.slots, booked.stage, booked.action)
    assert "广东城际地铁安检" in profile["registration_text"]


# ── [P2-6] 回复与槽位矛盾 ──────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_reply_day_and_period_aligned_with_slots(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以，后天上午过去面试", model)
    assert state["slots"]["interview_day_offset"] == 2
    assert state["slots"]["interview_period"] == "上午"
    state["stage"] = "collect"
    result = flow_llm.apply_decision(
        state, {"reply": "明天上午过去面试", "capture": {}}, text="好", now=NOW)
    assert "明天" not in result.reply and "后天" in result.reply
    assert "上午" in result.reply


# ── [P2-7] 换岗后流程不推进 ────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_agreement_after_job_switch_advances_flow(model):
    engine.set_remote_jobs({"广州": [dict(JOB_A), dict(JOB_B)]})
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以", model)
    assert state["slots"]["interview_agreed"] is True
    # 换岗：switch 落地路径必须重置旧岗的同意
    switched = flow_llm.apply_decision(
        state, {"reply": "好嘞，给你换个厂看看", "switch": True},
        text="不想干这个了 换一个", now=NOW)
    assert switched.slots["position_id"] == 202
    assert not switched.slots.get("interview_agreed")
    # 对新岗位表态同意 → 正常进 collect
    agreed = await turn(state, "行 这个可以 明天下午面试", model)
    assert agreed.stage == "collect" and agreed.slots["interview_period"] == "下午"
    assert agreed.slots["position_id"] == 202


# ── [P3-8] 报错时间 ────────────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_confirmed_time_renders_published_window(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以", model)
    result = await turn(state, "下午两点", model)
    assert result.slots["interview_period"] == "下午"
    booked = await turn(state, "我叫张三，手机号是13800138000", model)
    assert booked.stage == "done" and booked.slots["interview_window"] == "下午14:30-17:00"
    assert booked.slots["interview_at"] == "2026-11-16T14:30:00+08:00"
    assert "14:30-17:00" in booked.reply

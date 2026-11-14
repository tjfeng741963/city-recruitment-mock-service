"""客户选定的场次须跨资料收集保留，不能默认为上午或被审核换掉。"""
import copy
import uuid
from datetime import datetime

import pytest

from app.services import flow_engine as engine, flow_llm
from app.services.profile_push import build_profile

NOW = datetime(2026, 11, 15, 8, tzinfo=engine.TZ)
JOB = {"position_id": 17, "employer_id": 9, "factory_name": "广东城际地铁安检",
       "city": "广州", "place": "竹料基地", "wage_text": "130/班次",
       "interview_time": "竹料基地接收：\n周一至周五（可住宿）\n上午9:00-12:00\n下午14:30-17:00"}


@pytest.fixture(autouse=True)
def jobs():
    engine.set_remote_jobs({"广州": [dict(JOB)]})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_position_scripts([])


async def turn(state, text, model=False):
    return (await flow_llm.a_step(state, text, None, now=NOW) if model
            else engine.step(state, text, now=NOW))


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize("period,hour,minute", [("下午", 14, 30), ("上午", 9, 0)])
async def test_period_survives_collection_and_is_pushed_to_admin(model, period, hour, minute):
    state = engine.new_state()
    await turn(state, "广州", model)
    agreed = await turn(state, f"可以，我明天{period}去竹料基地面试", model)
    assert agreed.stage == "collect" and agreed.slots["interview_period"] == period
    booked = await turn(state, "我叫张三，手机号是13800138000", model)
    assert booked.stage == "done" and booked.action == "book_interview"
    at = datetime.fromisoformat(booked.slots["interview_at"])
    assert (at.day, at.hour, at.minute) == (16, hour, minute)
    assert booked.slots["name"] == "张三" and period in booked.slots["interview_window"]
    opposite = "上午09:00-12:00" if period == "下午" else "下午14:30-17:00"
    assert opposite not in booked.reply and booked.source == "fact"
    profile = build_profile(booked.slots, booked.stage, booked.action)
    assert profile["interview_time"] == booked.slots["interview_window"]
    assert profile["interview_date"] == "2026-11-16"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_unavailable_period_does_not_book_and_short_reply_is_not_a_name(model):
    engine.set_remote_jobs({"广州": [{**JOB, "interview_time": "上午9:00-12:00"}]})
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以，我明天下午去竹料基地面试", model)
    unavailable = await turn(state, "我叫张三，手机号是13800138000", model)
    assert unavailable.stage == "collect" and not unavailable.action
    assert not unavailable.slots.get("booked") and "无法确认下午场" in unavailable.reply
    booked = await turn(state, "上午", model)
    assert booked.stage == "done" and booked.slots["name"] == "张三"
    assert booked.slots["interview_window"] == "上午09:00-12:00"


@pytest.mark.parametrize("window,expected", [
    ("9:00-12:00/14:30-17:00", (14, 30)),
    ("下午2点到5点", (14, 0)),
    ("周一至周五 14：30～17：00", (14, 30)),
    ("下午25:00-26:00", None),
    ("下午14:75-17:00", None),
    ("下午17:00-14:30", None),
    ("时间另行通知", None),
])
def test_only_selects_valid_published_ranges(window, expected):
    selected = engine._preferred_interview_window({"interview_time": window}, "下午")
    assert (selected[1:] if selected else None) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_explicit_correction_updates_existing_booking_and_repeat_has_no_action(model):
    state = engine.new_state()
    await turn(state, "广州", model)
    await turn(state, "可以", model)
    await turn(state, "我叫张三，手机号是13800138000", model)
    corrected = await turn(state, "面试时间改为明天下午", model)
    assert corrected.slots["interview_at"] == "2026-11-16T14:30:00+08:00"
    assert corrected.slots["interview_window"] == "下午14:30-17:00"
    assert corrected.action == "book_interview" and corrected.slots["position_id"] == 17
    repeated = await turn(state, "面试时间改为明天下午", model)
    assert repeated.action is None and repeated.slots["name"] == "张三"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize("text", ["下午还能面试吗", "如果有空就改到下午", "后天下午要上班", "我叫张三，手机号是13800138000", "面试时间改为明天晚上"])
async def test_questions_conditions_duplicate_details_and_unavailable_change_keep_booking(text, model):
    state = engine.new_state()
    await turn(state, "广州", True)
    await turn(state, "可以，我明天下午去竹料基地面试", True)
    await turn(state, "我叫张三，手机号是13800138000", True)
    before = copy.deepcopy(state["slots"])
    result = await turn(state, text, model)
    assert state["slots"] == before and result.stage == "done" and not result.action


@pytest.mark.asyncio
async def test_today_period_is_not_shifted_to_tomorrow():
    engine.set_remote_jobs({"广州": [{**JOB, "interview_time": "每天上午9:00-12:00，下午14:30-17:00"}]})
    state = engine.new_state()
    await turn(state, "广州", True)
    await turn(state, "可以，我今天下午去竹料基地面试", True)
    result = await turn(state, "我叫张三，手机号是13800138000", True)
    assert result.slots["interview_at"] == "2026-11-15T14:30:00+08:00"


@pytest.mark.parametrize("apply", [flow_llm.apply_decision, flow_llm.apply_result])
def test_model_output_cannot_replace_selected_period(apply):
    state = engine.new_state()
    engine.step(state, "广州", now=NOW)
    engine.step(state, "可以，我明天下午去竹料基地面试", now=NOW)
    result = apply(state, {"stage": "done", "action": "book_interview", "reply": "明天上午见",
                           "profile": {"name": "张三", "phone": "13800138000"}},
                   text="我叫张三，手机号是13800138000", now=NOW)
    assert result.slots["interview_at"] == "2026-11-16T14:30:00+08:00"
    assert "明天上午见" not in result.reply and "下午14:30-17:00" in result.reply


def test_graph_does_not_finish_unavailable_period():
    engine.set_remote_jobs({"广州": [{**JOB, "interview_time": "上午9:00-12:00"}]})
    state = engine.new_state()
    engine.step(state, "广州", now=NOW)
    engine.step(state, "可以，我明天下午去竹料基地面试", now=NOW)
    graph = {"nodes": [{"node_key": "collect"}, {"node_key": "done", "body": "登记完成"}],
             "edges": [{"from_node": "collect", "to_node": "done", "condition_type": "always"}]}
    result = engine.step(state, "我叫张三，手机号是13800138000", now=NOW, graph=graph)
    assert result.stage == state["stage"] == "collect" and not result.action
    assert "登记完成" not in result.reply


def test_selected_period_keeps_booked_script_and_its_media():
    engine.set_position_scripts([{"position_id": 17, "stage": "booked", "content": "带身份证原件【图片:路线.jpg】"}])
    state = engine.new_state()
    engine.step(state, "广州", now=NOW)
    engine.step(state, "可以，我明天下午去竹料基地面试", now=NOW)
    result = engine.step(state, "我叫张三，手机号是13800138000", now=NOW)
    assert "下午14:30-17:00" in result.reply
    assert "带身份证原件【图片:路线.jpg】" in result.reply and result.source == "script"
    assert result.slots["scripted_sent"]["booked"] is True


@pytest.mark.asyncio
async def test_http_booking_and_correction_persist_selected_window(admin_client, monkeypatch):
    pushes = []

    async def lookup(city, **kwargs):
        return [dict(JOB)] if city == "广州" else []

    async def empty(*args, **kwargs):
        return []

    async def no_faq(*args, **kwargs):
        return None

    async def meta(device):
        return {"vertical_code": "subway", "vertical_id": 2, "city": "广州"}

    async def push(*args):
        pushes.append(args[-1])

    monkeypatch.setattr("app.api_flow.lookup_jobs", lookup)
    monkeypatch.setattr("app.api_flow.fetch_device_meta", meta)
    for name in ("lookup_cities", "fetch_position_scripts", "fetch_scripts"):
        monkeypatch.setattr("app.api_flow." + name, empty)
    monkeypatch.setattr("app.api_flow.kb_faq.lookup", no_faq)
    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", no_faq)
    monkeypatch.setattr("app.api_flow.profile_push.push", push)
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    key = "period-" + uuid.uuid4().hex[:12]
    base = {"session_key": key, "device_code": "pc-win-01"}
    for entry, text in (("greet", "广州"), ("answer", "可以，我明天下午去竹料基地面试"), ("answer", "我叫张三，手机号是13800138000")):
        response = await admin_client.post("/api/v1/flow/" + entry, json={**base, "text": text})
        assert response.status_code == 200
    slots = response.json()["slots"]
    assert slots["interview_period"] == "下午" and slots["interview_window"] == "下午14:30-17:00"
    before = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert before["slots"]["interview_window"] == "下午14:30-17:00"
    assert pushes[-1]["interview_time"] == "下午14:30-17:00"
    repeated = await admin_client.post("/api/v1/flow/answer", json={**base, "text": "我叫张三，手机号是13800138000"})
    assert not repeated.json()["action"]
    correction = await admin_client.post("/api/v1/flow/answer", json={**base, "text": "面试时间改为明天上午"})
    assert correction.json()["slots"]["interview_window"] == "上午09:00-12:00"
    assert pushes[-1]["interview_time"] == "上午09:00-12:00"

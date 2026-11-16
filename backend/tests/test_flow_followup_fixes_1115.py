"""2026-11-15 复测挖出的 5 个残留问题，逐个锁死（修复前全部失败）。

1. done 后客户还在问事（「面试到底在哪儿啊」）→ 确定性兜底不能返回空回复
2. 时段冲突连问 3 次不能逐字复读同一句（线上实测连发 4 次）
3. 客户没挑场次时 interview_at 必须落在岗位公布的第一场，不能留 09:00
4. 岗位把「安排线路」写进 welfare_text 时，问吃住不能答成「吃住：安排线路：…」
5. 一个工厂多个面试基地且没配 greet 话术时，先问基地再发卡（不直接甩 jobs[0]）
"""

from __future__ import annotations

import uuid
from datetime import datetime

import pytest
from httpx import AsyncClient

from app.services import device_scripts, flow_engine as engine, flow_llm, job_lookup

NOW = datetime(2026, 11, 15, 8, tzinfo=engine.TZ)

JOB_HERE = {
    "position_id": 16,
    "employer_id": 11,
    "city": "广东城际",
    "factory_name": "广东城际地铁安检",
    "job_title": "安检员",
    "place": "陈村基地",
    "wage_text": "陈村安保220/天",
    "welfare_text": "安排线路：广东城际全线路",
    "interview_time": "14:00-16:00",
}
JOB_OTHER = {
    **JOB_HERE,
    "position_id": 17,
    "place": "竹料基地",
    "wage_text": "竹料安保210/天",
}


@pytest.fixture(autouse=True)
def jobs():
    engine.set_remote_cities([{"city_name": "广东城际"}])
    engine.set_remote_jobs({"广东城际": [dict(JOB_HERE), dict(JOB_OTHER)]})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_remote_cities([])
    engine.set_position_scripts([])


async def turn(state, text, model=False):
    if model:
        return await flow_llm.a_step(state, text, None, now=NOW)
    return engine.step(state, text, now=NOW)


async def _booked_state(model: bool = False):
    state = engine.new_state()
    await turn(state, "广东城际", model)
    await turn(state, "可以，明天上午过去面试", model)
    booked = await turn(state, "我叫陈志强 13800138000", model)
    assert booked.stage != "done" or booked.slots.get("interview_period") in {"上午", "下午"}
    return state


# ── 1. done 后问地点不能空回复 ───────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_done_stage_answers_where_question(model):
    state = await _booked_state(model)
    booked = await turn(state, "那就下午两点吧", model)
    assert booked.stage == "done" and booked.slots.get("booked")
    asked = await turn(state, "面试到底在哪儿啊", model)
    assert asked.reply.strip(), "已约客户问地点不能回空"
    assert "陈村基地" in asked.reply
    assert "不打扰" not in asked.reply


# ── 2. 时段冲突不能逐字复读 ─────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_period_conflict_repeats_are_not_identical(model):
    state = engine.new_state()
    await turn(state, "广东城际", model)
    await turn(state, "可以，明天上午过去面试", model)
    first = await turn(state, "我叫陈志强 13800138000", model)
    assert first.stage == "collect" and not first.slots.get("booked")
    assert "下午14:00-16:00" in first.reply
    replies = [first.reply]
    for _ in range(2):
        replies.append((await turn(state, "上午", model)).reply)
    assert len(set(replies)) == 3, f"同一句复读：{replies}"
    # 第三次之后接受唯一在场，不能永远卡住
    done = await turn(state, "可以", model)
    assert done.stage == "done" and done.slots.get("interview_window") == "下午14:00-16:00"


# ── 3. 没挑场次时时刻要落在公布场次 ─────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("model", [False, True])
async def test_no_period_uses_published_start_hour(model):
    state = engine.new_state()
    await turn(state, "广东城际", model)
    await turn(state, "可以", model)
    booked = await turn(state, "我叫陈志强 13800138000", model)
    assert booked.stage == "done"
    at = datetime.fromisoformat(booked.slots["interview_at"])
    assert (at.hour, at.minute) == (14, 0), "没挑场次却约在 09:00，和公布的 14:00-16:00 对不上"


# ── 4. welfare 字段填的是线路时不冒充吃住 ───────────────────────────
def test_welfare_field_holding_line_is_not_answered_as_meal():
    slots = {"city": "广东城际", "job_index": 0, "job_snapshot": dict(JOB_HERE)}
    assert engine._job_fact_answer(slots, "包吃住吗") == ""
    assert engine._job_fact_answer(slots, "有宿舍吗") == ""
    # 线路问题仍然要能答
    line_job = {**JOB_HERE, "line_text": "广东城际全线路"}
    slots["job_snapshot"] = line_job
    assert engine._job_fact_answer(slots, "安排哪条线路") == "安排线路：广东城际全线路"


def test_card_does_not_duplicate_label():
    lines = engine._job_card_lines(dict(JOB_HERE))
    assert "吃住：安排线路：广东城际全线路" not in lines
    assert "安排线路：广东城际全线路" in lines


# ── 5. 多基地无 greet 话术先问地点 ─────────────────────────────────
pytestmark_api = pytest.mark.asyncio


@pytest.fixture
def api_jobs(monkeypatch):  # noqa: ANN001
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")

    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
        return [dict(JOB_HERE), dict(JOB_OTHER)] if city else []

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    yield
    job_lookup.clear_cache()
    device_scripts.clear_cache()


def _stub_meta(monkeypatch, **meta) -> None:  # noqa: ANN001
    base = dict(device_scripts.EMPTY_META)
    base.update(meta)

    async def fake_meta(device_code: str) -> dict:
        return dict(base)

    monkeypatch.setattr("app.api_flow.fetch_device_meta", fake_meta)


@pytest.mark.asyncio
async def test_multi_base_without_greet_asks_place_first(admin_client: AsyncClient, api_jobs, monkeypatch) -> None:  # noqa: ANN001
    _stub_meta(monkeypatch, vertical_code="subway", vertical_id=2, city="广东城际")
    key = f"greet-place-{uuid.uuid4().hex[:8]}"
    resp = await admin_client.post(
        "/api/v1/flow/greet", json={"session_key": key, "device_code": "pc-subway-09"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stage"] == "ask_city"
    assert "陈村基地" in body["reply"] and "竹料基地" in body["reply"]
    assert "哪个基地" in body["reply"]
    # 没发卡：不能出现工价/面试时间
    assert "220/天" not in body["reply"]

    follow = await admin_client.post(
        "/api/v1/flow/answer",
        json={"session_key": key, "text": "陈村基地", "device_code": "pc-subway-09"},
    )
    assert follow.status_code == 200, follow.text
    answered = follow.json()
    assert "陈村" in answered["reply"] and "220/天" in answered["reply"]
    assert "210/天" not in answered["reply"]

"""明确换城市在模型缺席时也应重发新岗位，不继承旧岗同意。"""
from datetime import datetime

import pytest

from app.services.flow_engine import TZ, new_state, pin_position, set_position_scripts, set_remote_jobs, step
from app.services.flow_llm import a_step

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=TZ)
OLD = {"position_id": 101, "employer_id": 11, "factory_name": "甲厂", "wage_text": "23元/小时"}
NEW = {"position_id": 202, "employer_id": 22, "factory_name": "穗厂", "wage_text": "24元/小时"}


@pytest.fixture(autouse=True)
def jobs():
    set_remote_jobs({"深圳": [OLD], "广州": [NEW]})
    set_position_scripts([])
    yield
    set_remote_jobs({})
    set_position_scripts([])


def current(stage):
    state = new_state()
    state["stage"] = stage
    state["slots"].update({"city": "深圳", "interview_offer_sent": True, "interview_agreed": True, "name": "张三", "phone": "13800138000"})
    pin_position(state["slots"], OLD)
    return state


class NeverCalled:
    async def complete(self, *args, **kwargs):
        raise AssertionError("Explicit city change must not need a model")


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["engine", "no-model", "model"])
@pytest.mark.parametrize("stage", ["ask_interview", "collect"])
async def test_city_change_replaces_position_and_requires_new_agreement(mode, stage):
    state = current(stage)
    result = step(state, "广州", now=NOW) if mode == "engine" else await a_step(state, "广州", None if mode == "no-model" else NeverCalled(), now=NOW)
    assert result.stage == "ask_interview" and not result.action
    assert result.slots["position_id"] == 202 and result.slots["employer_id"] == 22
    assert result.slots["city"] == "广州" and "24元/小时" in result.reply
    assert not result.slots.get("interview_agreed") and not result.slots.get("booked")
    assert result.slots["name"] == "张三" and result.slots["phone"] == "13800138000"


@pytest.mark.asyncio
async def test_no_jobs_in_new_city_does_not_keep_old_factory():
    set_remote_jobs({"深圳": [OLD]})
    result = await a_step(current("collect"), "广州", None, now=NOW)
    assert result.stage == "ask_city"
    assert not result.slots.get("position_id") and not result.slots.get("job_snapshot")
    assert not result.slots.get("interview_agreed")


@pytest.mark.parametrize("text", ["我朋友在广州", "不去广州", "广州不考虑"])
def test_other_person_or_rejected_city_is_not_a_switch(text):
    result = step(current("ask_interview"), text, now=NOW)
    assert result.slots["city"] == "深圳" and result.slots["position_id"] == 101

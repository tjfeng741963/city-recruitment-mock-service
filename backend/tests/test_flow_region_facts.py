"""线上回归：招聘区域先发卡，重复工资咨询不能被审核改成邀约。"""
import pytest

from app.services import flow_llm
from app.services.flow_engine import (
    new_state, set_position_scripts, set_remote_cities, set_remote_jobs,
)

REGION = "广东城际"
JOBS = [
    {"position_id": 16, "employer_id": 11, "city": REGION,
     "factory_name": "广东城际地铁安检", "job_title": "安检员",
     "wage_text": "陈村安保220/天，番禺安检260/天", "place": "陈村基地"},
    {"position_id": 17, "employer_id": 11, "city": REGION,
     "factory_name": "广东城际地铁安检", "job_title": "安检员",
     "wage_text": "竹料安保210/天", "place": "竹料基地"},
]


@pytest.fixture(autouse=True)
def region_data():
    set_remote_cities([{"city_name": REGION}])
    set_remote_jobs({REGION: JOBS, "广州": JOBS})
    set_position_scripts([])
    yield
    set_remote_cities([])
    set_remote_jobs({})
    set_position_scripts([])


class MisleadingModel:
    def __init__(self):
        self.calls = 0

    async def complete(self, *args, **kwargs):
        self.calls += 1
        return '{"reply":"你哪天能来面试？","capture":{}}'


@pytest.mark.asyncio
@pytest.mark.parametrize("city", [REGION, "广州"])
@pytest.mark.parametrize("prefix", ["", "我想去"])
async def test_region_and_city_recommend_both_bases_without_model(city, prefix):
    provider = MisleadingModel()
    state = new_state()
    first = await flow_llm.a_step(state, prefix + city, provider)
    assert first.stage == "ask_interview"
    assert first.slots["city"] == city
    assert first.slots["position_id"] == 16
    assert "陈村基地" in first.reply
    assert "260/天" in first.reply
    other = await flow_llm.a_step(state, "还有别的基地吗", provider)
    assert other.slots["position_id"] == 17
    assert "竹料基地" in other.reply
    assert provider.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["我朋友在广东城际", "广东城际不考虑"])
async def test_other_person_or_rejected_region_keeps_clarification_path(text):
    provider = MisleadingModel()
    result = await flow_llm.a_step(new_state(), text, provider)
    assert provider.calls == 1
    assert result.stage == "ask_city"
    assert not result.slots.get("position_id")


@pytest.mark.asyncio
@pytest.mark.parametrize("city", [REGION, "广州"])
async def test_wage_repetition_survives_reviewer_without_invitation(monkeypatch, city):
    provider = MisleadingModel()
    state = new_state()
    card = await flow_llm.a_step(state, city, None)

    def unwanted_reviewer():
        raise AssertionError("岗位事实不应进入模型审核改写")

    monkeypatch.setattr(flow_llm, "build_reviewer", unwanted_reviewer)
    history = [{"role": "assistant", "content": card.reply}]
    for _ in range(2):
        draft = await flow_llm.a_step(state, "工资多少", provider)
        final = await flow_llm.review_loop(state, "工资多少", provider, draft, history)
        assert final.reply == "工价：" + JOBS[0]["wage_text"]
        assert final.stage == "ask_interview" and not final.action
        assert final.slots["position_id"] == 16
        assert not final.slots.get("interview_agreed")
        history.append({"role": "assistant", "content": final.reply})
    assert provider.calls == 0

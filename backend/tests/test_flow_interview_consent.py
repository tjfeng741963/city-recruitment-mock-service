"""真实长句同意面试必须收集资料，不能被面试材料 FAQ 或审核改写截走。"""
import uuid

import pytest

from app.services import flow_engine as engine, flow_llm

JOB = {"position_id": 17, "employer_id": 9, "factory_name": "广东城际地铁安检",
       "wage_text": "安保130/班次", "place": "竹料基地"}
MATERIALS = "面试请带上身份证原件，复印件2张，一寸照片2张"


@pytest.fixture(autouse=True)
def jobs():
    engine.set_remote_jobs({"广州": [JOB]})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_position_scripts([])


def carded(stage="ask_interview"):
    state = engine.new_state()
    engine.step(state, "广州")
    state["stage"] = stage
    return state


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["send_info", "ask_interview"])
@pytest.mark.parametrize("text,offset", [
    ("可以，我明天下午去竹料基地面试", 1),
    ("我后天下午可以去竹料基地面试", 2),
    ("好的，我准备明天上午过去参加面试。", 1),
])
async def test_long_self_commitment_collects_even_when_materials_match(stage, text, offset):
    for model_path in (False, True):
        state = carded(stage)
        result = (await flow_llm.a_step(state, text, None, kb_answer=MATERIALS)
                  if model_path else engine.step(state, text, kb_answer=MATERIALS))
        assert result.stage == "collect" and result.slots["interview_agreed"] is True
        assert "姓名" in result.reply and "手机" in result.reply
        assert result.slots["position_id"] == 17
        assert result.slots["interview_day_offset"] == offset
        assert not result.action and not result.slots.get("booked")
        assert MATERIALS not in result.reply


@pytest.mark.asyncio
@pytest.mark.parametrize("text", [
    "我朋友明天下午去竹料基地面试", "如果有空我明天下午去竹料基地面试",
    "我可能明天下午去竹料基地面试", "我明天下午去竹料基地面试可以吗",
    "可以去竹料基地面试的话需要带什么", "你好", "收到", "我先考虑一下明天下午去不去面试",
    "如果有空我去", "我可能去面试", "可以的话我再去",
])
async def test_other_person_condition_or_question_is_not_consent(text):
    state = carded()
    result = await flow_llm.a_step(state, text, None, kb_answer=MATERIALS)
    assert not result.slots.get("interview_agreed")
    assert result.stage != "collect" and not result.action


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["greet", "answer"])
async def test_http_consent_beats_materials_and_keeps_collection_prompt(admin_client, monkeypatch, entry):
    pushes = []

    async def lookup(city, **kwargs):
        return [dict(JOB)] if city == "广州" else []

    async def meta(device):
        return {"vertical_code": "subway", "vertical_id": 2, "city": "广州", "job_scope": "subway"}

    async def empty(*args, **kwargs):
        return []

    async def no_faq(*args, **kwargs):
        return None

    async def legacy(*args, **kwargs):
        return {"id": "interview-materials", "body": MATERIALS}

    async def push(*args):
        pushes.append(args[-1])

    class MisleadingProvider:
        async def complete(self, *args, **kwargs):
            raise AssertionError("明确同意及缺失字段提示不能由模型改写")

    def misleading_reviewer():
        raise AssertionError("必填资料提示不能被审核替换为材料 FAQ")

    monkeypatch.setattr("app.api_flow.lookup_jobs", lookup)
    monkeypatch.setattr("app.api_flow.fetch_device_meta", meta)
    for name in ("lookup_cities", "fetch_position_scripts", "fetch_scripts"):
        monkeypatch.setattr("app.api_flow." + name, empty)
    monkeypatch.setattr("app.api_flow.kb_faq.lookup", no_faq)
    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", legacy)
    monkeypatch.setattr("app.api_flow.profile_push.push", push)
    monkeypatch.setattr("app.api_flow.build_provider", MisleadingProvider)
    monkeypatch.setattr(flow_llm, "build_reviewer", misleading_reviewer)
    key = "consent-" + uuid.uuid4().hex[:12]
    first = await admin_client.post("/api/v1/flow/" + entry, json={
        "session_key": key, "device_code": "pc-win-01", "text": "广州",
    })
    assert first.status_code == 200
    response = await admin_client.post("/api/v1/flow/answer", json={
        "session_key": key, "device_code": "pc-win-01",
        "text": "可以，我明天下午去竹料基地面试",
    })
    assert response.status_code == 200
    body = response.json()
    assert body["stage"] == "collect" and body["slots"]["interview_agreed"] is True
    assert "姓名" in body["reply"] and "手机" in body["reply"]
    assert MATERIALS not in body["reply"] and not body["action"]
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["stage"] == "collect" and state["slots"]["position_id"] == 17
    assert state["history"][-1]["text"] == body["reply"]
    assert any(p.get("stage") == "collect" for p in pushes)
    assert not any(p.get("stage") == "booked" for p in pushes)

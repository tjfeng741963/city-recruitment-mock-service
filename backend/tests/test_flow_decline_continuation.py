"""拒绝必须覆盖首轮发卡入口，结束也不能误称已经预约。"""
import copy
import uuid

import pytest

from app.services import flow_engine as engine, flow_llm

JOB = {"position_id": 17, "employer_id": 9, "factory_name": "广东城际地铁安检", "place": "竹料基地"}
MATERIALS = "面试请带上身份证原件，复印件2张，一寸照片2张"


@pytest.fixture(autouse=True)
def jobs():
    engine.set_remote_jobs({"广州": [dict(JOB)]})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_position_scripts([])


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["send_info", "ask_interview", "collect"])
@pytest.mark.parametrize("model", [False, True])
async def test_explicit_refusal_beats_faq_at_every_unbooked_stage(stage, model):
    state = engine.new_state()
    engine.step(state, "广州")
    state["stage"] = stage
    if stage == "collect":
        state["slots"]["interview_agreed"] = True
    result = (await flow_llm.a_step(state, "那我去不了面试", None, kb_answer=MATERIALS)
              if model else engine.step(state, "那我去不了面试", kb_answer=MATERIALS))
    assert result.stage == state["stage"] == "done"
    assert result.action == "gave_up" and "不打扰" in result.reply
    assert not result.slots["booked"] and result.slots["interview_agreed"] is False
    assert result.slots["recruit_status"] == "disqualified" and result.source == "fact"
    assert MATERIALS not in result.reply


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["收到", "谢谢", "好的"])
@pytest.mark.parametrize("kb", [None, MATERIALS])
async def test_acknowledgment_after_refusal_never_claims_booking(text, kb):
    state = engine.new_state()
    engine.step(state, "广州")
    await flow_llm.a_step(state, "那我去不了面试", None)
    before = copy.deepcopy(state["slots"])

    class ForbiddenProvider:
        async def complete(self, *args, **kwargs):
            raise AssertionError("拒绝后的普通确认无需模型重新决定意向")

    result = await flow_llm.a_step(state, text, ForbiddenProvider(), kb_answer=kb)
    assert result.stage == "done" and not result.action
    assert state["slots"] == before and result.reply == "好的，有需要再联系我。"
    assert "约好" not in result.reply and MATERIALS not in result.reply


@pytest.mark.asyncio
async def test_real_booked_customer_keeps_booking_confirmation():
    state = engine.new_state()
    engine.step(state, "广州")
    engine.step(state, "可以")
    engine.step(state, "我叫张三，手机号是13800138000")
    result = await flow_llm.a_step(state, "收到", None)
    assert "已经约好" in result.reply and result.slots["booked"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["greet", "answer"])
async def test_http_decline_then_ack_persists_only_one_gave_up_action(admin_client, monkeypatch, entry):
    pushes = []

    async def lookup(city, **kwargs):
        return [dict(JOB)] if city == "广州" else []

    async def empty(*args, **kwargs):
        return []

    async def no_faq(*args, **kwargs):
        return None

    async def legacy(*args, **kwargs):
        return {"id": "materials", "body": MATERIALS}

    async def push(*args):
        pushes.append(args[-1])

    async def meta(device):
        return {"city": "广州", "vertical_id": 2, "vertical_code": "subway",
                "factory_name": JOB["factory_name"], "job_scope": "subway"}

    def forbidden_reviewer():
        raise AssertionError("拒绝及结束确认不能被审核改成邀约")

    monkeypatch.setattr("app.api_flow.lookup_jobs", lookup)
    monkeypatch.setattr("app.api_flow.fetch_device_meta", meta)
    for name in ("lookup_cities", "fetch_position_scripts", "fetch_scripts"):
        monkeypatch.setattr("app.api_flow." + name, empty)
    monkeypatch.setattr("app.api_flow.kb_faq.lookup", no_faq)
    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", legacy)
    monkeypatch.setattr("app.api_flow.profile_push.push", push)
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setattr(flow_llm, "build_reviewer", forbidden_reviewer)
    key = "decline-" + uuid.uuid4().hex[:12]
    base = {"session_key": key, "device_code": "pc-win-01"}
    first = await admin_client.post("/api/v1/flow/" + entry, json={**base, "text": "广州"})
    assert first.status_code == 200
    if entry == "greet":
        assert not first.json()["skipped"] and first.json()["stage"] == "send_info"
    first_state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert first_state["slots"]["interview_offer_sent"] is True
    declined = await admin_client.post("/api/v1/flow/answer", json={**base, "text": "那我去不了面试"})
    assert declined.json()["action"] == "gave_up" and declined.json()["stage"] == "done"
    ack = await admin_client.post("/api/v1/flow/answer", json={**base, "text": "收到"})
    assert ack.status_code == 200 and ack.json()["stage"] == "done"
    assert "不打扰" in ack.json()["reply"] and "约好" not in ack.json()["reply"]
    assert not ack.json()["action"]
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert [action["name"] for action in state["actions"]] == ["gave_up"]
    assert state["slots"]["interview_agreed"] is False and not state["slots"]["booked"]
    assert not any(p.get("stage") == "booked" for p in pushes)

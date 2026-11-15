"""Booked clients' questions must survive the complete HTTP/reviewer path."""
import json
import uuid

import pytest
from sqlalchemy import delete

from app.db import SessionLocal
from app.models_kb import KbFaq, Vertical
from app.services import flow_session as store


FIRST = {"position_id": 16, "employer_id": 9, "vertical_code": "booked-test",
         "factory_name": "陈村测试基地", "place": "陈村测试地点", "wage_text": "陈村220/天"}
SELECTED = {"position_id": 17, "employer_id": 9, "vertical_code": "booked-test",
            "factory_name": "竹料测试基地", "place": "竹料测试地点", "wage_text": "竹料250/天",
            "cert_text": "竹料身份证原件及照片2张", "insurance_text": "竹料社保按本岗约定",
            "medical_text": "竹料体检按本岗要求"}


@pytest.fixture
async def setup_flow(monkeypatch):
    data = {"jobs": [dict(FIRST), dict(SELECTED)], "review_calls": 0, "model_calls": 0,
            "push_calls": [], "unknown": [], "faq_ids": []}

    async def jobs(*args, **kwargs):
        return list(data["jobs"])

    async def meta(*args, **kwargs):
        return {"vertical_code": "booked-test", "job_scope": "all", "position_id": 16}

    async def empty(*args, **kwargs):
        return []

    async def no_legacy(*args, **kwargs):
        return None

    async def push(*args, **kwargs):
        data["push_calls"].append((args, kwargs))

    async def unknown(text, **kwargs):
        data["unknown"].append(text)

    class Rewriter:
        async def complete(self, *args, **kwargs):
            data["model_calls"] += 1
            return "明天下午到竹料面试，带身份证原件和照片，到了联系我。"

    class Reviewer:
        async def review(self, *args, **kwargs):
            data["review_calls"] += 1
            return {"verdict": "revise" if data["review_calls"] == 1 else "pass",
                    "reason": "重复", "suggestion": "提醒面试"}

    monkeypatch.setattr("app.api_flow.lookup_jobs", jobs)
    monkeypatch.setattr("app.api_flow.fetch_device_meta", meta)
    for name in ("lookup_cities", "fetch_position_scripts", "fetch_scripts"):
        monkeypatch.setattr("app.api_flow." + name, empty)
    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", no_legacy)
    monkeypatch.setattr("app.api_flow.profile_push.push", push)
    monkeypatch.setattr("app.api_flow.unknown_questions.record", unknown)
    monkeypatch.setattr("app.api_flow.build_provider", lambda: Rewriter())
    monkeypatch.setattr("app.services.flow_llm.build_reviewer", lambda: Reviewer())
    async with SessionLocal() as session:
        vertical = Vertical(tenant_id=1, code="booked-test", name="已预约回归")
        session.add(vertical)
        await session.commit()
        data["vertical_id"] = vertical.id
        # Competing shared wage FAQ must not steal a named expense question,
        # even when that question has no FAQ of its own or its field is empty.
        session.add(KbFaq(tenant_id=1, vertical_id=vertical.id, scope_level="global",
                          question="工资多少", answer="{wage}",
                          keywords=json.dumps(["工资", "多少钱", "多少钱一个月", "多少钱一天"]), priority=200))
        await session.commit()
    yield data
    async with SessionLocal() as session:
        await session.execute(delete(KbFaq).where(KbFaq.vertical_id == data["vertical_id"]))
        await session.execute(delete(Vertical).where(Vertical.id == data["vertical_id"]))
        await session.commit()


async def seed(data, question, answer, *, stage="done", snapshot=None, faq=True, booked=True):
    key = "booked-question-" + uuid.uuid4().hex
    slots = {"city": "广州", "job_index": 0, "position_id": 17, "employer_id": 9,
             "job_snapshot": dict(SELECTED) if snapshot is None else snapshot,
             "interview_offer_sent": True, "interview_agreed": booked, "booked": booked,
             "interview_at": "2026-11-16T14:30:00+08:00", "interview_window": "14:30-17:00",
             "interview_place": "竹料测试地点", "name": "测试人", "phone": "13800000000",
             "scripted_sent": {"booked:17": True}}
    async with SessionLocal() as session:
        if faq:
            session.add(KbFaq(tenant_id=1, vertical_id=data["vertical_id"], scope_level="global",
                              question=question, answer=answer, keywords=json.dumps([question]), priority=100))
            await session.commit()
        await store.append_events(session, key, [
            (store.EVENT_STAGE, {"to": stage}), *store.diff_slots({}, slots),
            (store.EVENT_PROFILE, store.profile_of(slots)),
            (store.EVENT_REPLY, {"text": "之前已完成的面试登记"}),
        ])
    return key, slots


async def ask(client, key, question):
    response = await client.post("/api/v1/flow/answer", json={
        "session_key": key, "device_code": "booked-regression", "text": question})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("stage", ["done", "ask_interview"])
@pytest.mark.parametrize("faq", [True, False])
async def test_booked_wage_uses_pinned_facts_without_review_or_rebooking(admin_client, setup_flow, stage, faq):
    snapshot = {**SELECTED, "wage_text": "原已选竹料248/天"}
    key, slots = await seed(setup_flow, "工资多少", "{wage}", stage=stage, snapshot=snapshot, faq=faq)
    for _ in range(2):
        body = await ask(admin_client, key, "工资多少")
        assert body["reply"] == "工价：原已选竹料248/天"
        assert body["parts"] == [body["reply"]]
        assert body["stage"] == "done" and body["finished"] and body["action"] is None
        assert body["slots"] == slots
    assert setup_flow["review_calls"] == setup_flow["model_calls"] == 0
    assert not setup_flow["push_calls"]
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["history"][0]["text"] == "之前已完成的面试登记"
    assert state["turns"] == 2 and not state["actions"]


@pytest.mark.parametrize("question,template,expected", [
    ("面试要带什么", "{cert}", SELECTED["cert_text"]),
    ("买社保吗", "{insurance}", SELECTED["insurance_text"]),
    ("要体检吗", "{medical}", SELECTED["medical_text"]),
])
async def test_booked_faq_is_not_rewritten_into_interview_reminder(admin_client, setup_flow, question, template, expected):
    key, slots = await seed(setup_flow, question, template)
    body = await ask(admin_client, key, question)
    assert body["reply"] == expected
    assert body["slots"] == slots and body["action"] is None
    assert setup_flow["review_calls"] == setup_flow["model_calls"] == 0


async def test_booked_missing_fact_records_question_without_borrowing_or_reminding(admin_client, setup_flow):
    snapshot = {**SELECTED, "wage_text": ""}
    setup_flow["jobs"] = [dict(FIRST), snapshot]
    key, slots = await seed(setup_flow, "工资多少", "{wage}", snapshot=snapshot)
    body = await ask(admin_client, key, "工资多少")
    assert body["reply"] == "这个我确认一下，稍后回你"
    assert body["slots"] == slots and body["action"] is None
    assert setup_flow["unknown"] == ["工资多少"]
    assert setup_flow["review_calls"] == setup_flow["model_calls"] == 0


async def test_unbooked_faq_also_retains_selected_job_answer(admin_client, setup_flow):
    key, _ = await seed(setup_flow, "要体检吗", "{medical}", stage="ask_interview", booked=False)
    body = await ask(admin_client, key, "要体检吗")
    assert body["reply"] == SELECTED["medical_text"]
    assert body["stage"] == "ask_interview" and body["action"] is None
    assert setup_flow["review_calls"] == setup_flow["model_calls"] == 0


@pytest.mark.parametrize("question", ["体检多少钱，能报销吗？", "体检费从工资里扣吗？"])
@pytest.mark.parametrize("faq", [True, False])
async def test_missing_medical_cost_does_not_answer_wages_or_other_base(admin_client, setup_flow, question, faq):
    snapshot = {**SELECTED, "medical_text": ""}
    setup_flow["jobs"] = [{**FIRST, "medical_text": "另一基地体检190元可报销"}, snapshot]
    key, slots = await seed(setup_flow, question, "{medical}", snapshot=snapshot, faq=faq)
    body = await ask(admin_client, key, question)
    assert body["reply"] == "这个我确认一下，稍后回你"
    assert body["stage"] == "done" and body["slots"] == slots and body["action"] is None
    assert setup_flow["unknown"] == [question]
    assert setup_flow["review_calls"] == setup_flow["model_calls"] == 0
    assert not setup_flow["push_calls"]


@pytest.mark.parametrize("booked", [True, False])
async def test_medical_cost_uses_selected_job_faq_before_generic_money_match(admin_client, setup_flow, booked):
    question = "体检多少钱，能报销吗？"
    selected = {**SELECTED, "medical_text": "本测试岗位体检82元，按本岗规定不报销"}
    setup_flow["jobs"] = [{**FIRST, "medical_text": "另一基地体检190元可报销"}, selected]
    key, slots = await seed(setup_flow, question, "{medical}", stage="done" if booked else "ask_interview",
                            snapshot=selected, booked=booked)
    body = await ask(admin_client, key, question)
    assert body["reply"] == selected["medical_text"]
    assert body["stage"] == ("done" if booked else "ask_interview")
    assert body["slots"] == slots and body["action"] is None
    assert setup_flow["review_calls"] == setup_flow["model_calls"] == 0


@pytest.mark.parametrize("question", [
    "宿舍多少钱一个月？", "社保一个月扣多少钱？", "工衣多少钱？",
    "培训费从工资扣吗？", "去面试的路费能报销吗？", "入职要交多少钱？",
])
async def test_other_expenses_are_not_wage_questions(admin_client, setup_flow, question):
    snapshot = {**SELECTED, "welfare_text": "本岗包住", "hours_text": "本岗八小时"}
    key, slots = await seed(setup_flow, question, "", snapshot=snapshot, faq=False)
    body = await ask(admin_client, key, question)
    assert body["reply"] == "这个我确认一下，稍后回你"
    assert body["slots"] == slots and body["action"] is None
    assert setup_flow["unknown"] == [question]


@pytest.mark.parametrize("question", ["多少钱？", "一天多少钱？"])
async def test_money_without_an_expense_subject_still_answers_selected_wages(admin_client, setup_flow, question):
    key, slots = await seed(setup_flow, question, "", faq=False)
    body = await ask(admin_client, key, question)
    assert body["reply"] == "工价：" + SELECTED["wage_text"]
    assert body["slots"] == slots and body["action"] is None


async def test_direct_kb_still_filters_media_before_bypassing_model(monkeypatch):
    from app.services.flow_engine import FlowResult
    from app.services.flow_llm import review_loop

    def forbidden_review():
        raise AssertionError("知识库正文无需模型改写")

    monkeypatch.setattr("app.services.flow_llm.build_reviewer", forbidden_review)
    result = FlowResult(reply="本岗资料【图片:本岗.jpg】【视频:别岗.mp4】",
                        stage="done", source="kb")
    final = await review_loop({}, "资料呢", None, result, allowed_media=["【图片:本岗.jpg】"])
    assert final.reply == "本岗资料【图片:本岗.jpg】"

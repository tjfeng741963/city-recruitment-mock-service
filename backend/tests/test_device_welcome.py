"""Per-account recruitment introductions preserve scope and do not pick a base for the customer."""
import uuid
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.asyncio
PARTS = ["本号的岗位介绍", "工作内容：安检\n工作时间：轮班", "岗位福利：包住\n面试要求：按岗位要求准备", "你在哪个基地方便？"]


@pytest.fixture
def setup_intro(monkeypatch):
    meta = {"vertical_code": "subway", "vertical_id": 2, "city": "广州", "factory_name": "测试工厂", "job_scope": "subway"}
    jobs = [{"position_id": 7 + i, "employer_id": 9, "location_id": 31 + i,
             "factory_name": "测试工厂", "city": "广州", "job_title": "安检",
             "hours_text": "轮班", "welfare_text": "包住", "place": place,
             "wage_text": wage, "interview_time": "下午14:00-16:00"}
            for i, (place, wage) in enumerate([("甲基地", "210/天"), ("乙基地", "220/天")])]
    scripts = [{"stage": "greet", "city": "", "content": "\n---\n".join(PARTS)}]
    monkeypatch.setattr("app.api_flow.fetch_device_meta", AsyncMock(side_effect=lambda _: dict(meta)))
    monkeypatch.setattr("app.api_flow.lookup_jobs", AsyncMock(side_effect=lambda *a, **kw: list(jobs)))
    monkeypatch.setattr("app.api_flow.lookup_cities", AsyncMock(return_value=[]))
    monkeypatch.setattr("app.api_flow.fetch_scripts", AsyncMock(side_effect=lambda _: list(scripts)))
    monkeypatch.setattr("app.api_flow.fetch_position_scripts", AsyncMock(return_value=[
        {"position_id": 0, "stage": "greet", "content": "通用招呼不能覆盖本号介绍"},
        {"position_id": 7, "stage": "greet", "content": "旧岗位首句也不能覆盖本号介绍"},
    ]))
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    return meta, jobs, scripts


async def start(client):
    key = "device-intro-" + uuid.uuid4().hex[:12]
    response = await client.post("/api/v1/flow/greet", json={"session_key": key, "device_code": "intro-a"})
    assert response.status_code == 200, response.text
    return key, response.json()


async def answer(client, key, text):
    response = await client.post("/api/v1/flow/answer", json={"session_key": key, "device_code": "intro-a", "text": text})
    assert response.status_code == 200, response.text
    return response.json()


async def test_device_intro_wins_and_only_shared_facts_are_saved(admin_client, setup_intro):
    key, body = await start(admin_client)
    assert body["parts"] == PARTS and body["stage"] == "ask_city"
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["turns"] == 0
    slots = state["slots"]
    assert slots["device_intro_sent"] and slots["scripted_sent"]["greet"]
    assert slots["position_id"] == 0 and slots["location_id"] == 0 and slots["employer_id"] == 9
    assert slots["job_snapshot"]["welfare_text"] == "包住"
    assert "wage_text" not in slots["job_snapshot"] and "place" not in slots["job_snapshot"]
    assert not slots["interview_offer_sent"]


async def test_multi_base_questions_use_common_facts_and_do_not_borrow_first_wage(admin_client, setup_intro):
    key, _ = await start(admin_client)
    welfare = await answer(admin_client, key, "包吃住吗")
    assert "包住" in welfare["reply"] and welfare["stage"] == "ask_city"
    wage = await answer(admin_client, key, "工资多少")
    assert "210/天" not in wage["reply"] and "220/天" not in wage["reply"]
    assert "甲基地" in wage["reply"] and "乙基地" in wage["reply"]
    assert wage["slots"]["position_id"] == 0
    assert not wage["action"]


async def test_city_only_does_not_select_first_base_or_repeat_intro(admin_client, setup_intro):
    key, _ = await start(admin_client)
    body = await answer(admin_client, key, "广州")
    assert body["stage"] == "ask_city" and body["slots"]["position_id"] == 0
    assert "甲基地" in body["reply"] and "乙基地" in body["reply"]
    assert PARTS[0] not in body["reply"] and "210/天" not in body["reply"]


async def test_explicit_base_selection_pins_its_facts_and_continues_without_repeating_intro(admin_client, setup_intro):
    key, _ = await start(admin_client)
    selection = await answer(admin_client, key, "我去乙基地")
    assert selection["slots"]["position_id"] == 8 and selection["slots"]["location_id"] == 32
    assert selection["stage"] == "ask_interview" and "乙基地" in selection["reply"]
    assert PARTS[0] not in selection["reply"]
    for _ in range(2):
        body = await answer(admin_client, key, "工资多少")
        assert body["reply"] == "工价：220/天" and "210/天" not in body["reply"]
        assert not body["action"]


async def test_single_job_intro_pins_snapshot_for_immediate_questions(admin_client, setup_intro):
    setup_intro[1].pop()
    key, greeting = await start(admin_client)
    assert greeting["stage"] == "send_info"
    body = await answer(admin_client, key, "工资多少")
    assert body["reply"] == "工价：210/天" and body["slots"]["position_id"] == 7
    assert PARTS[0] not in body["reply"]


async def test_base_selection_keeps_customer_provided_contact_without_implicitly_booking(admin_client, setup_intro):
    key, _ = await start(admin_client)
    body = await answer(admin_client, key, "我叫张三，13800138000，去乙基地")
    assert body["slots"]["position_id"] == 8
    assert body["slots"]["name"] == "张三" and body["slots"]["phone"] == "13800138000"
    assert not body["action"] and not body["slots"].get("booked")


@pytest.mark.parametrize("missing", ["jobs", "city", "vertical"])
async def test_fixed_intro_does_not_require_job_data_or_customer_question(admin_client, setup_intro, missing):
    meta, jobs, _ = setup_intro
    if missing == "jobs":
        jobs.clear()
    elif missing == "city":
        meta["city"] = ""
    else:
        meta["vertical_code"] = ""
    _, body = await start(admin_client)
    assert body["parts"] == PARTS and not body["skipped"]


async def test_questions_use_employer_scoped_kb_before_base_selection(admin_client, setup_intro, monkeypatch):
    lookup = AsyncMock(return_value=None)
    monkeypatch.setattr("app.api_flow.kb_faq.lookup", lookup)
    key, _ = await start(admin_client)
    await answer(admin_client, key, "要培训吗")
    assert lookup.call_args.kwargs["employer_id"] == 9
    assert lookup.call_args.kwargs["position_id"] is None
    assert lookup.call_args.kwargs["location_id"] is None


async def test_actual_employer_faq_still_answers_after_intro_without_borrowing_other_factory(admin_client, setup_intro):
    from sqlalchemy import delete
    from app.db import SessionLocal
    from app.models_kb import KbFaq

    async with SessionLocal() as session:
        own = KbFaq(scope_level="employer", scope_employer_id=9, question="测试专用培训怎么安排",
                    keywords='["测试专用培训"]', answer="本厂培训先熟悉岗位操作。", priority=9999)
        other = KbFaq(scope_level="employer", scope_employer_id=10, question="测试专用培训怎么安排",
                      keywords='["测试专用培训"]', answer="另一厂的培训口径不能发送。", priority=99999)
        session.add_all([own, other])
        await session.commit()
        ids = [own.id, other.id]
    try:
        key, _ = await start(admin_client)
        body = await answer(admin_client, key, "测试专用培训怎么安排")
        assert body["reply"] == "本厂培训先熟悉岗位操作。"
        assert body["stage"] == "ask_city" and not body["action"]
    finally:
        async with SessionLocal() as session:
            await session.execute(delete(KbFaq).where(KbFaq.id.in_(ids)))
            await session.commit()

"""真实客户端 greet → answer：岗位身份和事实必须跨 HTTP 请求保留。"""
import uuid

import pytest

from app.db import SessionLocal
from app.services import flow_session as store

pytestmark = pytest.mark.asyncio

JOBS = [
    {"position_id": 16, "employer_id": 9, "location_id": 31,
     "factory_name": "广东城际地铁安检", "wage_text": "陈村安保220/天",
     "place": "陈村基地"},
    {"position_id": 17, "employer_id": 9, "location_id": 32,
     "factory_name": "广东城际地铁安检", "wage_text": "竹料安保210/天",
     "place": "竹料基地"},
]


@pytest.fixture(autouse=True)
def remote_data(monkeypatch):
    async def jobs(city, **kwargs):
        assert kwargs.get("device_code") == "pc-win-01"
        return [dict(job) for job in JOBS] if city == "广州" else []

    async def meta(device_code):
        return {"vertical_code": "subway", "vertical_id": 2, "city": "广州",
                "factory_name": "广东城际地铁安检", "job_scope": "subway"}

    async def empty(*args, **kwargs):
        return []

    monkeypatch.setattr("app.api_flow.lookup_jobs", jobs)
    monkeypatch.setattr("app.api_flow.fetch_device_meta", meta)
    for name in ("lookup_cities", "fetch_position_scripts", "fetch_scripts"):
        monkeypatch.setattr("app.api_flow." + name, empty)
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)


async def answer(client, key, text="工资多少"):
    response = await client.post("/api/v1/flow/answer", json={
        "session_key": key, "device_code": "pc-win-01", "text": text,
    })
    assert response.status_code == 200, response.text
    return response.json()


async def seed_legacy(key, position_id, snapshot=None):
    slots = {"city": "广州", "job_index": 0, "position_id": position_id,
             "interview_offer_sent": True}
    if snapshot is not None:
        slots["job_snapshot"] = snapshot
    async with SessionLocal() as session:
        await store.append_events(session, key, [
            (store.EVENT_STAGE, {"to": "send_info"}),
            *store.diff_slots({}, slots),
            (store.EVENT_REPLY, {"text": "已发送的历史岗位卡"}),
        ])


async def test_greet_persists_facts_for_repeated_wage_questions(admin_client):
    key = "greet-context-" + uuid.uuid4().hex[:12]
    greeting = await admin_client.post("/api/v1/flow/greet", json={
        "session_key": key, "device_code": "pc-win-01",
    })
    assert greeting.status_code == 200 and not greeting.json()["skipped"]
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["slots"]["job_snapshot"]["wage_text"] == JOBS[0]["wage_text"]
    assert state["slots"]["employer_id"] == 9
    assert state["slots"]["location_id"] == 31
    for _ in range(2):
        body = await answer(admin_client, key)
        assert body["reply"] == "工价：" + JOBS[0]["wage_text"]
        assert body["slots"]["position_id"] == 16
        assert not body["action"] and not body["slots"].get("interview_agreed")


async def test_legacy_greet_recovers_by_id_and_keeps_history(admin_client):
    key = "legacy-greet-" + uuid.uuid4().hex[:12]
    await seed_legacy(key, 17)  # 列表首项和旧 job_index 均指向 16，不能误恢复。
    for _ in range(2):
        body = await answer(admin_client, key)
        assert body["reply"] == "工价：" + JOBS[1]["wage_text"]
        assert body["slots"]["location_id"] == 32
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["history"][0]["text"] == "已发送的历史岗位卡"
    assert state["slots"]["job_snapshot"]["place"] == "竹料基地"


async def test_existing_snapshot_is_not_replaced_by_current_catalog(admin_client):
    key = "snapshot-kept-" + uuid.uuid4().hex[:12]
    await seed_legacy(key, 16, {**JOBS[0], "wage_text": "此前已发的工价218/天"})
    body = await answer(admin_client, key)
    assert body["reply"] == "工价：此前已发的工价218/天"


async def test_unavailable_legacy_position_does_not_borrow_first_job(admin_client):
    key = "missing-position-" + uuid.uuid4().hex[:12]
    await seed_legacy(key, 999)
    body = await answer(admin_client, key)
    assert body["slots"]["position_id"] == 999
    assert not body["slots"].get("job_snapshot")
    assert all(job["wage_text"] not in body["reply"] for job in JOBS)

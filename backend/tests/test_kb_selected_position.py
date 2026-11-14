"""会话已选岗位决定知识库口径，设备默认值和列表重排不能替换它。"""
from __future__ import annotations

import uuid

import pytest

from app.services import device_scripts, job_lookup, kb_faq, reviewer
from app.db import SessionLocal
from app.services import flow_session as store
from app.services.flow_engine import pin_position, set_position_scripts, set_remote_jobs


FIRST = {"position_id": 101, "employer_id": 11, "factory_name": "甲厂", "job_title": "甲厂 普工", "wage_text": "23 元/小时", "medical_text": "甲厂体检规则", "vertical_code": "factory"}
SECOND = {"position_id": 202, "employer_id": 22, "factory_name": "乙厂", "job_title": "乙厂 普工", "wage_text": "24 元/小时", "medical_text": "乙厂体检规则", "vertical_code": "factory"}


@pytest.fixture
def isolated(monkeypatch):
    data = {"jobs": [dict(FIRST)], "meta": {}, "faq_calls": [], "legacy_calls": []}

    async def jobs(*args, **kwargs):
        return list(data["jobs"])

    async def meta(*args, **kwargs):
        return dict(data["meta"])

    async def faq(*args, **kwargs):
        data["faq_calls"].append(kwargs)
        return kb_faq.FaqHit(99010, "体检", "{medical}", [], "global", "global")

    async def legacy(*args, **kwargs):
        data["legacy_calls"].append(kwargs)
        return None

    async def noop(*args, **kwargs):
        return None

    async def cities(*args, **kwargs):
        return ["深圳", "广州"]

    async def scripts(*args, **kwargs):
        return []

    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-selected-position")
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setattr(reviewer, "build_provider", lambda: None)
    monkeypatch.setattr("app.api_flow.fetch_device_meta", meta)
    monkeypatch.setattr("app.api_flow.fetch_scripts", scripts)
    monkeypatch.setattr("app.api_flow.fetch_position_scripts", scripts)
    monkeypatch.setattr("app.api_flow.lookup_cities", cities)
    monkeypatch.setattr("app.api_flow.profile_push.push", noop)
    monkeypatch.setattr("app.api_flow.unknown_questions.record", noop)
    monkeypatch.setattr(job_lookup, "_fetch_items", jobs)
    monkeypatch.setattr(kb_faq, "lookup", faq)
    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", legacy)
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])
    yield data
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])


async def say(client, key, text):
    response = await client.post("/api/v1/flow/answer", json={"session_key": key, "text": text, "device_code": "pc-kb-test"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reply"] == "\n".join(body["parts"])
    return body


@pytest.mark.asyncio
@pytest.mark.parametrize("available", [[SECOND, FIRST], [SECOND], []])
async def test_faq_uses_selected_job_or_own_snapshot(admin_client, isolated, available):
    key = f"kb-pin-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")
    isolated["jobs"] = [dict(job) for job in available]
    job_lookup.clear_cache()
    # 模拟另一个请求留下的上下文；当前请求必须重新加载自己的岗位。
    set_remote_jobs({"深圳": [dict(SECOND)]})
    body = await say(admin_client, key, "要体检吗")
    assert body["reply"] == "甲厂体检规则"
    assert isolated["faq_calls"][-1]["position_id"] == 101
    assert isolated["faq_calls"][-1]["employer_id"] == 11


@pytest.mark.asyncio
async def test_faq_reads_current_job_fields_before_lookup(admin_client, isolated):
    key = f"kb-fresh-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")
    isolated["jobs"] = [{**FIRST, "medical_text": "甲厂更新后的体检规则"}]
    job_lookup.clear_cache()
    set_remote_jobs({})
    body = await say(admin_client, key, "要体检吗")
    assert body["reply"] == "甲厂更新后的体检规则"


@pytest.mark.asyncio
async def test_selected_job_beats_device_default_employer_city_and_location(admin_client, isolated):
    key = f"kb-device-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")
    isolated["meta"] = {"city": "广州", "factory_name": "乙厂", "employer_id": 22, "position_id": 202, "location_id": 222}
    isolated["jobs"] = [{**FIRST, "medical_text": ""}]
    job_lookup.clear_cache()
    await say(admin_client, key, "要体检吗")
    faq_call = isolated["faq_calls"][-1]
    assert faq_call["employer_id"] == 11
    assert faq_call["position_id"] == 101
    assert not faq_call["location_id"]
    legacy_call = isolated["legacy_calls"][-1]
    assert legacy_call["factory"] == "甲厂"
    assert legacy_call["city"] == "深圳"


@pytest.mark.asyncio
async def test_switch_to_job_without_employer_does_not_reuse_device_default(admin_client, isolated):
    key = f"kb-switch-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")
    isolated["jobs"] = [dict(FIRST), {**SECOND, "employer_id": 0}]
    isolated["meta"] = {"employer_id": 11, "factory_name": "甲厂"}
    job_lookup.clear_cache()
    switched = await say(admin_client, key, "还有其他岗位吗")
    assert switched["slots"]["position_id"] == 202
    assert not switched["slots"].get("employer_id")
    body = await say(admin_client, key, "要体检吗")
    assert body["reply"] == "乙厂体检规则"
    assert not isolated["faq_calls"][-1]["employer_id"]
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert not state["slots"].get("employer_id")


@pytest.mark.parametrize("bad_id", [None, 0, True, "invalid"])
def test_pinning_new_job_clears_stale_identity_and_snapshot(bad_id):
    slots = {"position_id": 101, "employer_id": 11, "location_id": 111, "job_snapshot": dict(FIRST)}
    pin_position(slots, {"position_id": bad_id, "employer_id": bad_id, "factory_name": "新厂"})
    assert not slots.get("position_id")
    assert not slots.get("employer_id")
    assert not slots.get("location_id")
    assert slots["job_snapshot"] == {"factory_name": "新厂"}


def test_pinning_empty_job_clears_previous_facts():
    slots = {"position_id": 101, "employer_id": 11, "job_snapshot": dict(FIRST)}
    pin_position(slots, {})
    assert not slots.get("position_id") and not slots.get("employer_id")
    assert not slots.get("job_snapshot")


async def seed_slots(key, slots):
    async with SessionLocal() as session:
        await store.append_events(session, key, [
            (store.EVENT_STAGE, {"to": "ask_interview"}),
            *[(store.EVENT_SLOT, {"key": field, "value": value}) for field, value in slots.items()],
        ])


@pytest.mark.asyncio
async def test_old_snapshot_missing_policy_does_not_borrow_another_job(admin_client, isolated):
    key = f"kb-old-{uuid.uuid4().hex[:8]}"
    await seed_slots(key, {"city": "深圳", "position_id": 101, "employer_id": 11, "job_snapshot": {"factory_name": "甲厂"}})
    isolated["jobs"] = [dict(SECOND)]
    body = await say(admin_client, key, "要体检吗")
    assert "乙厂体检规则" not in body["reply"]
    assert isolated["legacy_calls"][-1]["factory"] == "甲厂"


@pytest.mark.asyncio
async def test_unselected_session_uses_explicit_device_position(admin_client, isolated):
    key = f"kb-explicit-{uuid.uuid4().hex[:8]}"
    await seed_slots(key, {"city": "深圳"})
    isolated["meta"] = {"position_id": 202}
    isolated["jobs"] = [dict(FIRST), dict(SECOND)]
    body = await say(admin_client, key, "要体检吗")
    assert body["reply"] == "乙厂体检规则"
    assert isolated["faq_calls"][-1]["employer_id"] == 22


@pytest.mark.asyncio
async def test_ambiguous_session_does_not_use_first_job_policy(admin_client, isolated):
    key = f"kb-ambiguous-{uuid.uuid4().hex[:8]}"
    await seed_slots(key, {"city": "深圳"})
    isolated["jobs"] = [dict(FIRST), dict(SECOND)]
    body = await say(admin_client, key, "要体检吗")
    assert "甲厂体检规则" not in body["reply"] and "乙厂体检规则" not in body["reply"]
    assert not isolated["faq_calls"][-1]["employer_id"]
    assert not isolated["legacy_calls"][-1]["factory"]
    assert isolated["legacy_calls"][-1]["require_factory"] is True

"""Publication must affect real FAQ retrieval without modifying legacy or unrelated rows."""
import asyncio
import json
import uuid

import pytest
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import User
from app.models_kb import KbEntry, KbFaq, Vertical
from app.models_kb_publish import KbPublication, KbPublishedFaq, KbPublishState
from app.security import create_access_token
from app.services import kb_faq

BASE = "/api/v1/kb/publish"


@pytest.fixture(autouse=True)
async def isolated_publications(client, monkeypatch):
    monkeypatch.setattr("app.instance.current", lambda: {"install_id": "verified-brain"})
    yield
    async with SessionLocal() as session:
        ids = (await session.execute(select(KbPublishedFaq.faq_id))).scalars().all()
        await session.execute(delete(KbPublishedFaq))
        await session.execute(delete(KbPublication))
        if ids:
            await session.execute(delete(KbFaq).where(KbFaq.id.in_(ids)))
        state = await session.get(KbPublishState, 1)
        state.generation = 0
        await session.commit()


def item(source_id=7001, **changes):
    return {"source_id": source_id, "vertical_code": "publish-subway", "scope_level": "global",
            "question": "工资多少", "answer": "{wage}", "keywords": ["工资"], **changes}


async def plan(client, items=None, **kwargs):
    response = await client.post(BASE + "/preview", json={"items": items if items is not None else [item()], **kwargs})
    assert response.status_code == 200, response.text
    return response.json()


async def commit(client, preview, **kwargs):
    return await client.post(BASE + "/apply", json={
        "items": preview["items"], "publication_id": uuid.uuid4().hex,
        "expected_target": preview["target_id"], "expected_revision": preview["target_revision"],
        "expected_generation": preview["target_generation"], "payload_digest": preview["payload_digest"], **kwargs,
    })


async def test_create_update_disable_and_rollback_preserve_unmanaged_and_legacy(admin_client):
    async with SessionLocal() as session:
        unmanaged = KbFaq(tenant_id=1, question="保留的独立问答", answer="你好")
        legacy = KbEntry(tenant_id=1, kind="script", title="保留的旧库", body="未改动")
        session.add_all([unmanaged, legacy])
        await session.commit()
        unmanaged_id, legacy_id = unmanaged.id, legacy.id
    try:
        preview = await plan(admin_client, [item(), item(7002, question="培训吗", answer="旧的默认承诺", status="disabled")])
        assert len(preview["changes"]) == 2
        first = await commit(admin_client, preview)
        assert first.status_code == 200, first.text
        publication_id = first.json()["publication_id"]
        repeated = await commit(admin_client, preview, publication_id=publication_id)
        assert repeated.status_code == 200 and repeated.json()["replayed"]
        conflict = await commit(admin_client, await plan(admin_client, [item(answer="{welfare}")]), publication_id=publication_id)
        assert conflict.status_code == 409
        updated = await commit(admin_client, await plan(admin_client, [item(answer="工资：{wage_text}")]))
        assert updated.status_code == 200, updated.text
        async with SessionLocal() as session:
            hit = await kb_faq.lookup(session, "工资多少", vertical_code="publish-subway", position_id=999)
            assert hit and hit.answer == "工资：{wage_text}"
            assert kb_faq.render(hit.answer, job={"wage_text": "陈村220/天"}) == "工资：陈村220/天"
            assert kb_faq.render(hit.answer, job={"wage_text": "竹料210/天"}) == "工资：竹料210/天"
            assert kb_faq.render(hit.answer, job={}) == ""
            assert await kb_faq.lookup(session, "工资多少", vertical_code="factory") is None
        disabled = await commit(admin_client, await plan(admin_client, []))
        assert disabled.status_code == 200
        async with SessionLocal() as session:
            assert await kb_faq.lookup(session, "工资多少", vertical_code="publish-subway") is None
        # Restore the pre-disable snapshot through the same validation and CAS path.
        rollback_of = disabled.json()["publication_id"]
        rollback = await plan(admin_client, [], rollback_of=rollback_of)
        restored = await commit(admin_client, rollback, items=[], rollback_of=rollback_of)
        assert restored.status_code == 200, restored.text
        async with SessionLocal() as session:
            assert await kb_faq.lookup(session, "工资多少", vertical_code="publish-subway")
            assert (await session.get(KbFaq, unmanaged_id)).answer == "你好"
            assert (await session.get(KbEntry, legacy_id)).body == "未改动"
        assert len((await admin_client.get(BASE + "/history")).json()["items"]) == 4
    finally:
        async with SessionLocal() as session:
            await session.execute(delete(KbFaq).where(KbFaq.id == unmanaged_id))
            await session.execute(delete(KbEntry).where(KbEntry.id == legacy_id))
            await session.commit()


@pytest.mark.parametrize("change", [
    {"answer": "22元/小时"}, {"answer": "{wage|随便填}"}, {"answer": "{training}"},
    {"answer": "{wage"}, {"answer": "{wage}", "media": ["别厂工资.jpg"]},
    {"scope_level": "employer", "scope_employer_id": 9}, {"vertical_id": 2},
    {"scope_level": "vertical", "vertical_code": None}, {"source_id": True},
    {"question": "面试要带什么", "answer": "带身份证就行"},
])
async def test_invalid_batch_is_atomic_even_with_valid_first_row(admin_client, change):
    response = await admin_client.post(BASE + "/preview", json={"items": [item(), {**item(7002), **change}]})
    assert response.status_code == 422, response.text
    async with SessionLocal() as session:
        assert not (await session.execute(select(KbPublishedFaq))).scalars().all()


async def test_target_drift_and_unreviewed_payload_cannot_commit(admin_client):
    preview = await plan(admin_client)
    for change in [{"expected_target": "wrong-brain"}, {"expected_revision": "stale"},
                   {"expected_generation": -1}, {"items": [item(answer="{welfare}")]}]:
        response = await commit(admin_client, preview, **change)
        assert response.status_code == 409, response.text
    async with SessionLocal() as session:
        assert (await session.get(KbPublishState, 1)).generation == preview["target_generation"]
        assert not (await session.execute(select(KbPublishedFaq))).scalars().all()


async def test_external_target_edit_and_category_disable_invalidate_preview(admin_client):
    initial = await commit(admin_client, await plan(admin_client))
    assert initial.status_code == 200
    preview = await plan(admin_client, [item(answer="{welfare}")])
    async with SessionLocal() as session:
        link = await session.get(KbPublishedFaq, 7001)
        row = await session.get(KbFaq, link.faq_id)
        row.answer = "{shift}"
        await session.commit()
    assert (await commit(admin_client, preview)).status_code == 409
    preview = await plan(admin_client)
    async with SessionLocal() as session:
        vertical = (await session.execute(select(Vertical).where(Vertical.code == "publish-subway"))).scalar_one()
        vertical.status = "disabled"
        await session.commit()
    assert (await commit(admin_client, preview)).status_code == 409
    async with SessionLocal() as session:
        vertical = (await session.execute(select(Vertical).where(Vertical.code == "publish-subway"))).scalar_one()
        vertical.status = "enabled"
        await session.commit()


async def test_simultaneous_previews_only_one_writer_wins(admin_client):
    preview = await plan(admin_client)
    results = await asyncio.gather(commit(admin_client, preview), commit(admin_client, preview))
    assert sorted(response.status_code for response in results) == [200, 409]
    async with SessionLocal() as session:
        assert len((await session.execute(select(KbPublishedFaq))).scalars().all()) == 1


async def test_publish_auth_rejects_recruiter_and_accepts_configured_service(admin_client, monkeypatch):
    async with SessionLocal() as session:
        user = User(username="publisher-" + uuid.uuid4().hex, password_hash="unused", role="recruiter")
        session.add(user)
        await session.commit()
        token = create_access_token(str(user.id))[0]
    try:
        response = await admin_client.post(BASE + "/preview", json={"items": []}, headers={"Authorization": "Bearer " + token})
        assert response.status_code == 403
        admin_client.headers.clear()
        assert (await admin_client.post(BASE + "/preview", json={"items": []})).status_code == 401
        monkeypatch.setenv("FLOW_PROFILE_TOKEN", "configured-profile-key")
        assert (await admin_client.post(BASE + "/preview", json={"items": []}, headers={"X-Profile-Token": "wrong"})).status_code == 401
        allowed = await admin_client.post(BASE + "/preview", json={"items": []}, headers={"X-Profile-Token": "configured-profile-key"})
        assert allowed.status_code == 200, allowed.text
    finally:
        async with SessionLocal() as session:
            await session.execute(delete(User).where(User.id == user.id))
            await session.commit()

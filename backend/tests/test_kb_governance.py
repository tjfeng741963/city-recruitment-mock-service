"""写入和只读审计不能重新引入无工厂归属的招聘政策。"""
from __future__ import annotations

import json
from pathlib import Path
import uuid

import pytest
from sqlalchemy import delete

from app.db import SessionLocal
from app.models import User
from app.models_kb import KbEntry, KbFaq, KbFragment
from app.security import create_access_token
from app.services.kb_faq import _PLACEHOLDER_KEYS
from app.services.kb_policy import shared_answer_allowed


CASES = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/kb-policy.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["question"] + "/" + case["answer"])
def test_shared_policy_contract_matches_node(case):
    assert shared_answer_allowed(case["question"], case["answer"],
                                 keywords=case.get("keywords", []), media=case.get("media", []),
                                 fact_fields={*_PLACEHOLDER_KEYS, *_PLACEHOLDER_KEYS.values()}) is case["allowed"]


@pytest.mark.parametrize("changes", [
    {"body": "本厂25元/小时"},
    {"body": "具体看安排", "fragments": [{"content": "体检免费"}]},
    {"title": "工资多少", "body": "{wage|25元/小时}"},
    {"title": "工资多少", "body": "{wage}"},
    {"factory_name": "  ", "body": "住宿免费"},
])
async def test_legacy_unscoped_policy_cannot_be_created(admin_client, changes):
    payload = {"kind": "script", "title": "咨询", "body": "你好", **changes}
    result = await admin_client.post("/api/v1/kb/entries", json=payload)
    assert result.status_code == 422, result.text


async def test_legacy_scope_removal_and_partial_content_cannot_bypass_guard(admin_client):
    payload = {"kind": "script", "title": "体检安排", "factory_name": "核对甲厂", "body": "本厂体检自理",
               "fragments": [{"content": "请联系甲厂驻厂"}]}
    created = await admin_client.post("/api/v1/kb/entries", json=payload)
    assert created.status_code == 201, created.text
    entry_id = created.json()["id"]
    try:
        assert created.json()["factory_name"] == "核对甲厂"
        changed = await admin_client.put(f"/api/v1/kb/entries/{entry_id}", json={**payload, "factory_name": None})
        assert changed.status_code == 422, changed.text
        original = (await admin_client.get(f"/api/v1/kb/entries/{entry_id}")).json()
        assert original["factory_name"] == "核对甲厂"
        assert original["body"] == "本厂体检自理"
        fragments = (await admin_client.get(f"/api/v1/kb/entries/{entry_id}/fragments")).json()
        assert [row["content"] for row in fragments] == ["请联系甲厂驻厂"]
    finally:
        await admin_client.delete(f"/api/v1/kb/entries/{entry_id}")


async def test_old_bad_rows_can_be_disabled_but_not_reenabled(admin_client):
    async with SessionLocal() as session:
        row = KbEntry(tenant_id=1, kind="script", title="工资核对", body="请看附件")
        session.add(row)
        await session.flush()
        session.add(KbFragment(entry_id=row.id, position=0, kind="text", content="25元/小时"))
        await session.commit()
        entry_id = row.id
    try:
        disabled = await admin_client.patch(f"/api/v1/kb/entries/{entry_id}/status", json={"status": "disabled"})
        assert disabled.status_code == 200, disabled.text
        enabled = await admin_client.patch(f"/api/v1/kb/entries/{entry_id}/status", json={"status": "enabled"})
        assert enabled.status_code == 422, enabled.text
        assert (await admin_client.get(f"/api/v1/kb/entries/{entry_id}")).json()["status"] == "disabled"
    finally:
        await admin_client.delete(f"/api/v1/kb/entries/{entry_id}")


async def test_audit_is_readonly_admin_only_and_tenant_scoped(admin_client):
    async with SessionLocal() as session:
        bad = KbFaq(tenant_id=1, scope_level="global", question="工资审计", answer="25元/小时")
        alien = KbFaq(tenant_id=2, scope_level="global", question="外租户", answer="99元/小时")
        legacy = KbEntry(tenant_id=1, kind="script", title="纹身审计", body="都可以直接入职")
        ordinary = KbEntry(tenant_id=1, kind="script", title="问候", body="你好")
        user = User(username="kb-audit-" + uuid.uuid4().hex, password_hash="unused", role="recruiter")
        session.add_all([bad, alien, legacy, ordinary, user])
        await session.commit()
        bad_id, alien_id, legacy_id, ordinary_id, user_id = bad.id, alien.id, legacy.id, ordinary.id, user.id
        await session.refresh(bad)
        await session.refresh(legacy)
        before = (bad.answer, bad.updated_at, legacy.body, legacy.updated_at)
    try:
        result = await admin_client.get("/api/v1/kb/governance/audit")
        assert result.status_code == 200, result.text
        inventory = result.json()
        faq_ids = {row["id"] for row in inventory["items"] if row["table"] == "kb_faq"}
        legacy_ids = {row["id"] for row in inventory["items"] if row["table"] == "kb_entry"}
        assert bad_id in faq_ids and alien_id not in faq_ids
        assert legacy_id in legacy_ids and ordinary_id not in legacy_ids
        assert alien_id not in {row["id"] for row in inventory["faq_inventory"]}
        token, _ = create_access_token(str(user_id))
        forbidden = await admin_client.get("/api/v1/kb/governance/audit", headers={"Authorization": "Bearer " + token})
        assert forbidden.status_code == 403
        async with SessionLocal() as session:
            bad = await session.get(KbFaq, bad_id)
            legacy = await session.get(KbEntry, legacy_id)
            assert (bad.answer, bad.updated_at, legacy.body, legacy.updated_at) == before
    finally:
        async with SessionLocal() as session:
            await session.execute(delete(KbFaq).where(KbFaq.id.in_([bad_id, alien_id])))
            await session.execute(delete(KbEntry).where(KbEntry.id.in_([legacy_id, ordinary_id])))
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()

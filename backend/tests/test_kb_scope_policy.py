"""宽作用域不能替任何一家工厂承诺工价、体检和录用政策。"""
from __future__ import annotations

import itertools
import json
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import delete

from app.db import SessionLocal, init_db
from app.models_kb import KbEntry, KbFaq, Vertical
from app.services import kb_faq, kb_placeholder
from app.services.kb_policy import shared_answer_allowed

IDS = itertools.count(800000)


@pytest.mark.parametrize("question,answer,allowed", [
    ("有刺青行不行", "可以，直接来", False),
    ("想了解一下", "免费提供住宿", False),
    ("月薪怎么算", "转正五千起", False),
    ("收多少钱", "不用交钱", False),
    ("要体检吗", "{medical}", True),
    ("体检和纹身要求", "{medical}。{tattoo_policy}", True),
    ("体检要求", "{medical|我确认一下}", False),
    ("体检要求", "{{medical}}", False),
    ("有视频吗", "车间实拍供你参考【视频:车间.mp4】", True),
    ("你好", "你好呀，想了解哪个城市？", True),
])
def test_shared_content_contract(question, answer, allowed):
    assert shared_answer_allowed(question, answer, fact_fields={"medical", "tattoo_policy"}) is allowed


@pytest_asyncio.fixture
async def policy_db():
    await init_db()
    async with SessionLocal() as session:
        vertical = Vertical(id=next(IDS), tenant_id=1, code=f"policy-{uuid.uuid4().hex[:8]}", name="隔离验收")
        session.add(vertical)
        await session.commit()
        made = []

        async def add(answer, *, scope="global", employer=None, priority=0, media=None):
            row = KbFaq(id=next(IDS), tenant_id=1, vertical_id=vertical.id, scope_level=scope,
                        scope_employer_id=employer, scope_location_id=77 if scope == "city" else None,
                        scope_position_id=88 if scope == "position" else None,
                        question="体检纹身工资", keywords=json.dumps(["体检", "纹身", "工资"], ensure_ascii=False),
                        answer=answer, media=json.dumps(media or [], ensure_ascii=False), priority=priority)
            session.add(row)
            await session.commit()
            made.append(row.id)
            return row

        yield session, vertical.code, add
        await session.execute(delete(KbFaq).where(KbFaq.id.in_(made)))
        await session.execute(delete(Vertical).where(Vertical.id == vertical.id))
        await session.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["global", "vertical", "city"])
@pytest.mark.parametrize("answer", ["体检免费，纹身都可以进", "转正后175元/班", "宿舍四人间，满月报销体检费"])
async def test_shared_scope_rejects_fixed_employer_policy(policy_db, scope, answer):
    session, code, add = policy_db
    await add(answer, scope=scope)
    assert await kb_faq.lookup(session, "体检和工资是什么要求", vertical_code=code, employer_id=11, location_id=77) is None


@pytest.mark.asyncio
async def test_shared_bad_row_does_not_hide_safe_fact_template(policy_db):
    session, code, add = policy_db
    await add("体检免费", priority=100)
    safe = await add("{medical}", priority=1)
    hit = await kb_faq.lookup(session, "体检怎么安排", vertical_code=code, employer_id=11)
    assert hit and hit.id == safe.id
    assert kb_faq.render(hit.answer, job={"medical_text": "本岗需自理体检"}) == "本岗需自理体检"
    assert kb_faq.render(hit.answer, job={}) == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["{medical|体检免费}", "{medical}，纹身都能进", "{medical}，另收200元", "{unknown_policy}"])
async def test_shared_template_cannot_hide_fixed_promises(policy_db, answer):
    session, code, add = policy_db
    await add(answer)
    assert await kb_faq.lookup(session, "体检怎么安排", vertical_code=code) is None


@pytest.mark.asyncio
async def test_shared_policy_media_cannot_supply_another_factory_poster(policy_db):
    session, code, add = policy_db
    await add("{medical}", media=["【图片:其他工厂体检免费.jpg】"])
    assert await kb_faq.lookup(session, "体检怎么安排", vertical_code=code) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["employer", "position"])
async def test_specific_scope_keeps_operator_answer(policy_db, scope):
    session, code, add = policy_db
    own = await add("体检免费，纹身需要现场确认", scope=scope, employer=11)
    hit = await kb_faq.lookup(session, "体检怎么安排", vertical_code=code, employer_id=11, position_id=88)
    assert hit and hit.id == own.id
    other = await kb_faq.lookup(session, "体检怎么安排", vertical_code=code, employer_id=22, position_id=99)
    assert other is None


@pytest.mark.asyncio
async def test_seed_wage_template_still_renders_current_position(policy_db):
    session, code, add = policy_db
    await add("这边工价是{wage}")
    hit = await kb_faq.lookup(session, "工资多少", vertical_code=code)
    assert hit and kb_faq.render(hit.answer, job={"wage_text": "23元/小时"}) == "这边工价是23元/小时"


@pytest.mark.asyncio
async def test_legacy_fallback_cannot_reintroduce_unscoped_policy(policy_db):
    session, _, _ = policy_db
    marker = uuid.uuid4().hex[:8]
    rows = [KbEntry(id=next(IDS), tenant_id=1, kind="script", title=f"体检报销{marker}", body="体检免费", factory_name=name, search_text="体检") for name in (None, "甲厂")]
    session.add_all(rows)
    await session.commit()
    try:
        assert await kb_placeholder.lookup_entry(session, f"体检报销{marker}吗", factory="乙厂", require_factory=True) is None
        own = await kb_placeholder.lookup_entry(session, f"体检报销{marker}吗", factory="甲厂", require_factory=True)
        assert own and own["body"] == "体检免费"
    finally:
        await session.execute(delete(KbEntry).where(KbEntry.id.in_([row.id for row in rows])))
        await session.commit()

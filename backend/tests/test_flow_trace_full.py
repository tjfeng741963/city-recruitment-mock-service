"""灰度诊断三项补充的验证：device_code、知识库候选、审核前原稿。

这三项是 2026-11-16 灰度前一天补的，分别回答三个问题：

- device_code：这句话是哪台机器/哪个企微号说的
- kb_candidates：库里明明有这条，为什么没选它
- draft_before_review：模型本来想说什么，最后被改成了什么

只断言「字段存在且形状正确」，不锁具体文案——文案会随运营调整。
"""

from __future__ import annotations

import json
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models_flow import FlowEvent
from app.models_kb import KbFaq
from app.services import job_lookup
from tests.fixture_jobs import JOBS_BY_CITY

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _no_llm_and_remote_jobs(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")

    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
        return JOBS_BY_CITY.get(city, [])

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    job_lookup.clear_cache()
    yield
    job_lookup.clear_cache()


@pytest.fixture
async def kb_entries():
    """种两条同关键词的通用问答，用来验证「候选与打分」被记下来。

    ``vertical_id=None`` 是关键：表示「所有品类通用」，不依赖设备绑定的品类。

    条目内容选了「上班时间」而不是吃住/工资：后两者属于招聘政策敏感内容，
    通用共享问答不允许承载（kb_policy.shared_answer_allowed 会拦掉），
    种进去也命中不了，测试就成了假阳性。
    两条同层同关键词，正好验证 candidates 里既有被选中的、也有落选的。
    """
    async with SessionLocal() as session:
        rows = [
            KbFaq(
                tenant_id=1,
                vertical_id=None,
                scope_level="global",
                question="上班时间几点",
                answer="每天八点到六点，中间休息一小时。",
                keywords=json.dumps(["上班时间", "几点上班", "做几个小时"], ensure_ascii=False),
                priority=100,
            ),
            KbFaq(
                tenant_id=1,
                vertical_id=None,
                scope_level="global",
                question="一天干多久",
                answer="按厂里排班，正常八小时。",
                keywords=json.dumps(["几点上班"], ensure_ascii=False),
                priority=10,
            ),
        ]
        session.add_all(rows)
        await session.commit()
        ids = [row.id for row in rows]
    yield ids
    async with SessionLocal() as session:
        await session.execute(delete(KbFaq).where(KbFaq.id.in_(ids)))
        await session.commit()


async def _say(client: AsyncClient, key: str, text: str, **extra) -> dict:
    resp = await client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": text, **extra}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _traces(key: str) -> list[dict]:
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(FlowEvent)
                .where(FlowEvent.session_key == key, FlowEvent.type == "reply")
                .order_by(FlowEvent.seq)
            )
        ).scalars().all()
    return [json.loads(row.body or "{}").get("trace") or {} for row in rows]


async def test_device_code_is_recorded(admin_client: AsyncClient) -> None:
    """trace 里必须能看出这句话是哪台设备说的。

    多台设备同时跑时，没有 device_code 就无法归属，
    「只有这台机器答错」这类问题根本没法按设备排查。
    """
    key = f"dev-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好", device_code="pc-win-01")

    traces = await _traces(key)
    assert traces, "没有产生回复"
    assert traces[0]["device_code"] == "pc-win-01", traces[0]


async def test_kb_lookup_records_candidates(kb_entries: list[int]) -> None:
    """`kb_faq.lookup` 命中时必须带回同层候选与打分。

    只记最终命中的 id 不够：灰度里最常见的问题是「库里明明有更合适的，
    为什么没选它」——那就必须能看到当时还有哪些候选、各自多少分。

    这一层直接调 lookup，不经过流程：流程在 ask_interview 阶段可能优先用
    岗位事实回答（那是正确行为），拿流程结果断言会变成假失败。
    """
    from app.services import kb_faq

    async with SessionLocal() as session:
        hit = await kb_faq.lookup(session, "上班时间几点", vertical_code="factory")

    assert hit is not None, "种了条目却查不到，检查 kb_policy 是否把它拦了"
    assert hit.candidates, f"命中了却没有候选记录：{hit}"
    for candidate in hit.candidates:
        assert {"id", "score", "question", "picked"} <= set(candidate), candidate
    assert any(candidate["picked"] for candidate in hit.candidates), "候选里没有标出被选中的那条"
    # 被选中的那条必须是得分最高的（同分才比 priority）
    picked = next(candidate for candidate in hit.candidates if candidate["picked"])
    assert picked["score"] == max(candidate["score"] for candidate in hit.candidates), hit.candidates


async def test_kb_candidates_reach_trace(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """候选集必须一路写进 trace，供灰度复盘。

    打桩 `app.api_flow.kb_faq.lookup` 返回一个带候选的命中，验证
    「lookup -> trace」这段接线；真实性由上一个用例保证。
    """
    from app.services import kb_faq

    async def fake_lookup(*_args: object, **_kwargs: object) -> kb_faq.FaqHit:
        return kb_faq.FaqHit(
            id=99001,
            question="上班时间几点",
            answer="每天八点到六点。",
            media=[],
            scope_level="global",
            tier="global",
            candidates=[
                {"id": 99001, "score": 8, "question": "上班时间几点", "picked": True},
                {"id": 99002, "score": 3, "question": "一天干多久", "picked": False},
            ],
        )

    monkeypatch.setattr("app.api_flow.kb_faq.lookup", fake_lookup)

    key = f"kbc-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "东莞")
    await _say(admin_client, key, "上班时间几点")

    traces = await _traces(key)
    hits = [trace for trace in traces if trace.get("kb_hit_id")]
    assert hits, f"打桩命中没有写进 trace：{[t.get('source') for t in traces]}"

    trace = hits[-1]
    # 这一轮回复来自岗位事实卡（source=fact），知识库命中被有意重置，
    # 但「查到过什么」仍须留下：kb_used=False + kb_hit_id 有值。
    assert trace["kb_hit_id"] == "faq:99001", trace
    assert trace["kb_tier"] == "global", trace
    assert trace["kb_used"] is False, trace
    assert trace["kb_entry_id"] == "", trace
    candidates = trace.get("kb_candidates")
    assert isinstance(candidates, list) and len(candidates) == 2, candidates
    assert any(candidate["picked"] for candidate in candidates), candidates


async def test_draft_before_review_is_recorded(admin_client: AsyncClient) -> None:
    """审核前的原稿要留一份。

    灰度里最想知道「模型本来想说什么、最后被改成了什么」。
    只记最终文本，等于把审核这一环变成黑盒。
    """
    key = f"draft-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")

    traces = await _traces(key)
    assert traces, "没有产生回复"
    draft = traces[0].get("draft_before_review")
    assert isinstance(draft, str) and draft, f"审核前原稿没记下来：{traces[0]}"

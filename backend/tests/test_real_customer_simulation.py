"""用客户真实资料跑一遍完整对话，检查客户到底收到什么。

数据来源：仓库里的 `data/app.sqlite`（4222 那侧的库，由 src/db/migrations +
src/db/backfill 写入的客户真实资料）。这里把它**只读**读出来，灌进测试库，
然后完全按客户的真实话术去问——目的是暴露"答非所问"和"空回复"。

为什么要用真实数据而不是夹具：夹具里每个字段都是我手写的，天然自洽；
真实数据里岗位只填了 wage_text / age_text，体检、纹身这些事实挂在
employer 作用域的硬编码答案里，只有用真数据才能发现"哪里答不上来"。

跑法：
    uv run pytest tests/test_real_customer_simulation.py -q -s
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.db import SessionLocal
from app.services import device_scripts, job_lookup
from app.services.kb_faq import lookup, render

# 仓库根目录的 4222 侧数据库
REAL_DB = Path(__file__).resolve().parents[2] / "data" / "app.sqlite"

pytestmark = pytest.mark.asyncio


def _read(table: str) -> list[dict]:
    conn = sqlite3.connect(f"file:{REAL_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(f'SELECT * FROM "{table}"').fetchall()]
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


async def _seed_employer_faq() -> dict[str, int]:
    """把客户真实的厂房级问答灌进测试库，返回 {employer_code: python_id}。

    幂等：同一轮里多个用例都会调它，已存在的品类/招工方直接复用，
    否则第二次插入会撞 UNIQUE(tenant_id, code)。
    """
    from sqlalchemy import select

    from app.models_kb import Employer, KbFaq, Vertical

    employers = _read("employer")
    verticals = _read("vertical")
    faqs = [r for r in _read("kb_faq") if r.get("scope_position_id") is None]

    async with SessionLocal() as session:
        vid_map: dict[int, int] = {}
        for row in verticals:
            existing = (
                await session.execute(
                    select(Vertical).where(
                        Vertical.tenant_id == 1, Vertical.code == row["code"]
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                vid_map[row["id"]] = existing.id
                continue
            v = Vertical(
                tenant_id=1, code=row["code"], name=row["name"],
                config_json=row.get("config_json") or "{}",
            )
            session.add(v)
            await session.flush()
            vid_map[row["id"]] = v.id

        emp_map: dict[int, int] = {}
        for row in employers:
            existing = (
                await session.execute(
                    select(Employer).where(
                        Employer.tenant_id == 1,
                        Employer.employer_code == row["employer_code"],
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                emp_map[row["id"]] = existing.id
                continue
            e = Employer(
                tenant_id=1, vertical_id=vid_map.get(row["vertical_id"], 0),
                employer_code=row["employer_code"],
                display_name=row["display_name"], short_name=row.get("short_name") or "",
            )
            session.add(e)
            await session.flush()
            emp_map[row["id"]] = e.id

        for row in faqs:
            if row.get("scope_employer_id") is None:
                continue
            session.add(
                KbFaq(
                    tenant_id=1,
                    vertical_id=vid_map.get(row.get("vertical_id") or 0),
                    scope_level=row["scope_level"],
                    scope_employer_id=emp_map.get(row["scope_employer_id"]),
                    question=row["question"], keywords=row.get("keywords") or "[]",
                    answer=row["answer"], media=row.get("media") or "[]",
                    priority=int(row.get("priority") or 0), status="enabled",
                )
            )
        await session.commit()

    return {row["employer_code"]: emp_map[row["id"]] for row in employers}


@pytest.fixture(autouse=True)
def _no_network(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")
    device_scripts.clear_cache()
    job_lookup.clear_cache()
    yield
    device_scripts.clear_cache()
    job_lookup.clear_cache()


async def test_real_factory_questions_get_real_answers(client) -> None:  # noqa: ANN001
    """客户按真实话术问每家厂，体检/纹身/吃住必须答出来，且不能串厂。"""
    emp_ids = await _seed_employer_faq()
    assert emp_ids, "没读到招工方数据"

    # 客户真实资料里的关键事实：华荻查纹身、利口福要健康证、松下不查纹身
    cases = [
        ("GZ-PY-004", "有纹身能进吗", "华荻要查纹身"),
        ("GZ-PY-004", "要不要体检", "需要体检"),
        ("GZ-PY-001", "有纹身能进吗", "不查纹身"),
        ("GZ-PY-003", "要不要体检", "健康证"),
        ("GZ-PY-005", "要不要体检", "体检费公司出钱"),
    ]
    async with SessionLocal() as session:
        default_job = {"wage_text": "24-26 元/小时", "welfare_text": "包吃包住"}
        for code, question, expected in cases:
            hit = await lookup(
                session, question, vertical_code="factory", employer_id=emp_ids[code]
            )
            assert hit is not None, f"{code} 问「{question}」没有命中"
            answer = render(hit.answer, job=default_job)
            assert expected in answer, (
                f"{code} 问「{question}」答成了「{answer}」，期望包含「{expected}」"
            )
            print(f"[{code}] {question} -> {answer}")


async def test_global_template_must_not_render_empty(client) -> None:  # noqa: ANN001
    """没有绑招工方时落 global 层。这类模板若渲染成空串，客户就等于没收到回答。

    022 的通用模板用了 {medical} {tattoo_policy} 等占位符，而客户真实的岗位
    数据里只有 wage_text / age_text——真实场景下这些占位符填不上。
    这里把"答不上来"显式测出来，作为待补清单。
    """
    from app.models_kb import KbFaq, Vertical

    async with SessionLocal() as session:
        v = Vertical(tenant_id=1, code="factory-sim", name="工厂")
        session.add(v)
        await session.flush()
        session.add_all([
            KbFaq(
                tenant_id=1, vertical_id=v.id, scope_level="global",
                question="要体检吗", keywords='["体检"]',
                answer="{medical}", priority=8, status="enabled",
            ),
            KbFaq(
                tenant_id=1, vertical_id=v.id, scope_level="global",
                question="工资多少", keywords='["工资"]',
                answer="这边工价是{wage}", priority=10, status="enabled",
            ),
        ])
        await session.commit()

        # 客户真实岗位就长这样：只有 wage_text 和 age_text
        real_job = {"wage_text": "24-26 元/小时", "age_text": "18-40岁"}

        wage_hit = await lookup(session, "工资多少", vertical_code="factory-sim")
        assert wage_hit is not None
        assert render(wage_hit.answer, job=real_job) == "这边工价是24-26 元/小时"

        medical_hit = await lookup(session, "要体检吗", vertical_code="factory-sim")
        assert medical_hit is not None
        medical_answer = render(medical_hit.answer, job=real_job)
        # 当前实现：占位符填不上 → 整句丢弃 → 空串。这就是客户收到空回复的原因。
        print(f"[global] 要体检吗 -> {medical_answer!r}")
        assert medical_answer == "", (
            "如果这里不再是空串，说明已经补了兜底文案，请更新本用例"
        )


async def test_customer_can_finish_flow_over_http(admin_client: AsyncClient) -> None:
    """走一遍真实 HTTP 流程：进线 → 问工资 → 问纹身 → 答应 → 报姓名电话。"""
    emp_ids = await _seed_employer_faq()

    async def stub_meta(device_code: str) -> dict:
        meta = dict(device_scripts.EMPTY_META)
        meta.update({
            "vertical_code": "factory", "vertical_id": 1,
            "city": "广州", "employer_id": emp_ids["GZ-PY-004"],
            "factory_name": "广州华荻科技有限公司",
        })
        return meta

    async def fake_jobs(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
        return [{
            "factory_name": "广州华荻科技有限公司", "job_title": "普工",
            "wage_text": "24-26 元/小时", "age_text": "18-40岁",
            "place": "番禺区石楼", "interview_time": "每天12:00-12:30",
        }]

    import app.api_flow as api_flow

    mp = pytest.MonkeyPatch()
    mp.setattr(api_flow, "fetch_device_meta", stub_meta)
    mp.setattr(job_lookup, "_fetch_items", fake_jobs)
    job_lookup.clear_cache()
    try:
        key = "sim-customer-001"
        r1 = await admin_client.post(
            "/api/v1/flow/answer",
            json={"session_key": key, "text": "广州", "device_code": "dev-sim"},
        )
        assert r1.status_code == 200, r1.text
        body = r1.json()
        print("\n[客户] 广州")
        print("[客服]", body["reply"].replace("\n", " / "))
        assert "24-26" in body["reply"], "岗位卡必须带真实工价"
        assert body["stage"] == "ask_interview"

        r2 = await admin_client.post(
            "/api/v1/flow/answer",
            json={"session_key": key, "text": "有纹身能进吗", "device_code": "dev-sim"},
        )
        body2 = r2.json()
        print("[客户] 有纹身能进吗")
        print("[客服]", body2["reply"].replace("\n", " / "))
        assert "华荻" in body2["reply"], "纹身问题必须答本厂政策，不能空也不能串厂"

        r3 = await admin_client.post(
            "/api/v1/flow/answer",
            json={"session_key": key, "text": "可以", "device_code": "dev-sim"},
        )
        body3 = r3.json()
        print("[客户] 可以")
        print("[客服]", body3["reply"].replace("\n", " / "))
        assert body3["stage"] == "collect"

        r4 = await admin_client.post(
            "/api/v1/flow/answer",
            json={"session_key": key, "text": "张三 13800138000", "device_code": "dev-sim"},
        )
        body4 = r4.json()
        print("[客户] 张三 13800138000")
        print("[客服]", body4["reply"].replace("\n", " / "))
        assert body4["stage"] == "done"
        assert body4["action"] == "book_interview"
    finally:
        mp.undo()
        job_lookup.clear_cache()

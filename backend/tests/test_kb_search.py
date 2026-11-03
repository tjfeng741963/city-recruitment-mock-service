"""三层检索漏斗的验收用例。

核心命题（docs/知识库与后端技术选型-决策文档.md 5.3）：
"我 52 了还能去吗"必须被 SQL 层确定性排除，不能靠语义相似度。
这里每一条用例都在验证这个命题。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.db import SessionLocal, init_db
from app.models_kb import KbEntry, Tenant
from app.services.kb_search import SearchQuery, extract_age_from_query, search


@pytest.fixture
async def seeded_kb(client) -> None:  # noqa: ARG001  client 负责建表与种子租户
    """造几条有代表性的数据：两条岗位、一条话术、一条已过期、一条已停用。"""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        # 同一测试会话共用一个 sqlite 文件，每个用例前先清空，避免主键冲突
        await session.execute(delete(KbEntry))
        await session.commit()
        session.add_all(
            [
                KbEntry(
                    id=1,
                    tenant_id=1,
                    kind="job",
                    title="广州万美表带厂",
                    city="广州",
                    age_min=18,
                    age_max=45,
                    body="18-45岁 22-25元/小时 包吃住",
                    search_text="广州万美表带厂 18-45岁 22-25元/小时 包吃住",
                    status="enabled",
                    valid_until=now + timedelta(days=30),
                ),
                KbEntry(
                    id=2,
                    tenant_id=1,
                    kind="job",
                    title="广州放宽到55的电子厂",
                    city="广州",
                    age_min=18,
                    age_max=55,
                    body="18-55岁 20元/小时",
                    search_text="广州电子厂 18-55岁 20元/小时",
                    status="enabled",
                ),
                KbEntry(
                    id=3,
                    tenant_id=1,
                    kind="script",
                    title="超龄话术",
                    city="广州",
                    body="哥，这个厂卡到45的，您52进不去哈",
                    search_text="超龄 卡年龄 后续再聊",
                    status="enabled",
                ),
                KbEntry(
                    id=4,
                    tenant_id=1,
                    kind="job",
                    title="已过期岗位",
                    city="广州",
                    age_min=18,
                    age_max=50,
                    body="过期条目",
                    search_text="过期 广州",
                    status="enabled",
                    valid_until=now - timedelta(days=1),
                ),
                KbEntry(
                    id=5,
                    tenant_id=1,
                    kind="job",
                    title="已停用岗位",
                    city="广州",
                    age_min=18,
                    age_max=50,
                    body="停用条目",
                    search_text="停用 广州",
                    status="disabled",
                ),
            ]
        )
        await session.commit()


class TestAgeExtraction:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("我52了还能去吗", 52),
            ("我今年52了", 52),
            ("52岁还能去吗", 52),
            ("今年五十二了", None),
            ("有没有包住的活", None),
        ],
    )
    def test_extract_age(self, text: str, expected: int | None) -> None:
        assert extract_age_from_query(text) == expected


class TestSqlTier:
    async def test_age_excludes_ineligible_jobs(self, seeded_kb: None) -> None:
        """52 岁：18-45 的岗位必须被排除，18-55 的必须保留。"""
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(city="广州", age=52))
        titles = {h.entry.title for h in result.hits}
        assert "广州万美表带厂" not in titles
        assert "广州放宽到55的电子厂" in titles
        assert all(h.tier == "sql" for h in result.hits)

    async def test_city_filter(self, seeded_kb: None) -> None:
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(city="深圳"))
        assert len(result) == 0

    async def test_script_entries_survive_age_filter(self, seeded_kb: None) -> None:
        """话术条目没有年龄字段，不应被年龄硬过滤掉。"""
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(city="广州", age=52, kind="script"))
        assert any(h.entry.kind == "script" for h in result.hits)


class TestActiveFiltering:
    async def test_expired_entries_excluded(self, seeded_kb: None) -> None:
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(city="广州"))
        assert "已过期岗位" not in {h.entry.title for h in result.hits}

    async def test_disabled_entries_excluded(self, seeded_kb: None) -> None:
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(city="广州"))
        assert "已停用岗位" not in {h.entry.title for h in result.hits}


class TestJobPriority:
    async def test_jobs_rank_before_scripts(self, seeded_kb: None) -> None:
        """实测踩到过：广州的话术条目主键更小，会先占满 limit，岗位一条都出不来。

        客户问"广州 52 岁能去吗"，先要告诉他哪个厂能接，话术是辅助。
        """
        async with SessionLocal() as session:
            result = await search(
                session, SearchQuery(city="广州", age=52, limit=1)
            )
        assert len(result.hits) == 1
        assert result.hits[0].entry.kind == "job"


class TestFulltextTier:
    async def test_match_by_factory_name(self, seeded_kb: None) -> None:
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(text="万美表带厂"))
        assert any("万美表带厂" in h.entry.title for h in result.hits)
        assert "fulltext" in result.tiers_used

    async def test_no_match_returns_empty(self, seeded_kb: None) -> None:
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(text="根本不存在的内容"))
        assert len(result) == 0

    async def test_limit_is_respected(self, seeded_kb: None) -> None:
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(city="广州", limit=1))
        assert len(result) <= 1


class TestTenantIsolation:
    async def test_other_tenant_sees_nothing(self, seeded_kb: None) -> None:
        """租户 2 查不到租户 1 的任何条目——接第二个客户时的底线。"""
        async with SessionLocal() as session:
            result = await search(session, SearchQuery(tenant_id=2, city="广州"))
        assert len(result) == 0


class TestDefaultTenant:
    async def test_default_tenant_created(self, client) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            tenant = (
                await session.execute(select(Tenant).where(Tenant.id == 1))
            ).scalar_one_or_none()
        assert tenant is not None
        assert tenant.slug == "default"

    async def test_init_db_is_idempotent(self, client) -> None:  # noqa: ARG002
        """重复调用不能报唯一约束错误。"""
        await init_db()
        await init_db()

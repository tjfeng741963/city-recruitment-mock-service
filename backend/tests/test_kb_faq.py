"""知识库 v3 场景问答的回归用例。

核心断言：**同一句问法，绑定 A 厂和绑定 B 厂必须拿到各自答案，不能串。**

这是「已读乱回 / 分不清厂」的直接验收标准——旧路径靠打分，别家厂的话术
分数够高就会被选中；新路径按 vertical + employer 硬过滤，别家的条目根本
不进候选集。
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text

from app.db import SessionLocal
from app.services import kb_faq


@pytest_asyncio.fixture
async def session():
    """独立会话：直接查库，不走 HTTP。"""
    async with SessionLocal() as s:
        yield s


async def _ensure_faq_schema(session) -> None:
    """测试库由 SQLAlchemy 建表，这里用**确定性 DDL** 重建 v3 的四张表。

    为什么直接 DROP：SQLAlchemy 的 create_all 按模型建表时，`default="{}"` /
    `default=utcnow` 都是 **Python 侧默认**，DDL 里没有 DEFAULT 子句；
    裸 SQL 插入就会撞 NOT NULL。本文件用裸 SQL 造数据，所以要自己定义表结构，
    保证和 021_kb_verticals.sql 语义一致（有 DEFAULT）。
    """
    for table in ("kb_faq", "employer", "vertical", "location"):
        await session.execute(text(f"DROP TABLE IF EXISTS {table}"))

    statements = [
        """
        CREATE TABLE IF NOT EXISTS vertical (
          id INTEGER PRIMARY KEY,
          tenant_id INTEGER NOT NULL DEFAULT 1,
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          config_json TEXT NOT NULL DEFAULT '{}',
          sort_order INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'enabled',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, code)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS employer (
          id INTEGER PRIMARY KEY,
          tenant_id INTEGER NOT NULL DEFAULT 1,
          vertical_id INTEGER NOT NULL,
          employer_code TEXT NOT NULL,
          display_name TEXT NOT NULL,
          short_name TEXT NOT NULL DEFAULT '',
          location_id INTEGER,
          status TEXT NOT NULL DEFAULT 'enabled',
          data_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, employer_code)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS location (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER,
          level TEXT NOT NULL,
          name TEXT NOT NULL,
          code TEXT NOT NULL DEFAULT '',
          lat REAL,
          lng REAL,
          address TEXT NOT NULL DEFAULT '',
          walk_guide TEXT NOT NULL DEFAULT '',
          image_key TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'enabled',
          data_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kb_faq (
          id INTEGER PRIMARY KEY,
          tenant_id INTEGER NOT NULL DEFAULT 1,
          vertical_id INTEGER,
          scope_level TEXT NOT NULL DEFAULT 'global',
          scope_location_id INTEGER,
          scope_employer_id INTEGER,
          question TEXT NOT NULL,
          keywords TEXT NOT NULL DEFAULT '[]',
          answer TEXT NOT NULL,
          media TEXT NOT NULL DEFAULT '[]',
          priority INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'enabled',
          template_item_id INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """,
    ]
    for stmt in statements:
        await session.execute(text(stmt))
    await session.commit()


@pytest.fixture
async def faq_db(session):
    """建表 + 两个厂 + 三条问答（A 厂、B 厂、全局）。"""
    await _ensure_faq_schema(session)
    for table in ("kb_faq", "employer", "vertical", "location"):
        await session.execute(text(f"DELETE FROM {table}"))

    await session.execute(
        text(
            # 全量跑时这些表可能已由 SQLAlchemy create_all 建好，模型的 Python 侧默认
            # （config_json / sort_order / status / data_json）不会被裸 SQL 自动带上，
            # 所以显式给全，避免 NOT NULL 约束失败。
            "INSERT INTO vertical(id, tenant_id, code, name, config_json, sort_order, status) VALUES "
            "(1, 1, 'factory', '工厂', '{}', 1, 'enabled'), "
            "(2, 1, 'subway', '地铁安检', '{}', 2, 'enabled')"
        )
    )
    await session.execute(
        text(
            "INSERT INTO employer(id, tenant_id, vertical_id, employer_code, display_name, short_name, status, data_json) VALUES "
            "(11, 1, 1, 'GZ-PY-001', '松下万宝电子（广州）有限公司', '松下万宝', 'enabled', '{}'), "
            "(12, 1, 1, 'GZ-PY-002', '广汽荻原模具有限公司', '荻原', 'enabled', '{}')"
        )
    )
    await session.execute(
        text(
            "INSERT INTO kb_faq(tenant_id, vertical_id, scope_level, scope_employer_id, question, keywords, answer, priority) VALUES "
            "(1, 1, 'employer', 11, '包吃住吗', '[\"包吃\",\"包住\",\"吃住\"]', '{welfare}', 10), "
            "(1, 1, 'employer', 12, '包吃住吗', '[\"包吃\",\"包住\",\"吃住\"]', '包吃，住宿补贴 200 元/月', 10), "
            "(1, 1, 'global', NULL, '多久转正', '[\"转正\",\"正式工\"]', '3 个月，上手快可以提前', 5)"
        )
    )
    await session.commit()
    yield
    for table in ("kb_faq", "employer", "vertical", "location"):
        await session.execute(text(f"DELETE FROM {table}"))
    await session.commit()


class TestNoCrossFactory:
    """同一句问法，不同厂拿到不同答案——这就是「不串厂」。"""

    async def test_a_factory_hits_a_row(self, faq_db, session) -> None:
        hit = await kb_faq.lookup(session, "包吃住吗", vertical_code="factory", employer_id=11)
        assert hit is not None
        assert hit.tier == "employer"
        assert hit.answer == "{welfare}"

    async def test_b_factory_hits_b_row(self, faq_db, session) -> None:
        hit = await kb_faq.lookup(session, "包吃住吗", vertical_code="factory", employer_id=12)
        assert hit is not None
        assert hit.tier == "employer"
        assert hit.answer == "包吃，住宿补贴 200 元/月"

    async def test_same_question_different_answers(self, faq_db, session) -> None:
        a = await kb_faq.lookup(session, "包吃住吗", vertical_code="factory", employer_id=11)
        b = await kb_faq.lookup(session, "包吃住吗", vertical_code="factory", employer_id=12)
        assert a is not None and b is not None
        assert a.answer != b.answer, "两个厂拿到了同一个答案 = 串厂"

    async def test_unbound_device_does_not_hit_factory_faq(self, faq_db, session) -> None:
        """设备没绑厂时不能命中任何厂级问答。"""
        hit = await kb_faq.lookup(session, "包吃住吗", vertical_code="factory", employer_id=None)
        assert hit is None

    async def test_global_answer_still_reachable(self, faq_db, session) -> None:
        hit = await kb_faq.lookup(session, "多久能转正", vertical_code="factory", employer_id=11)
        assert hit is not None
        assert hit.tier == "global"
        assert "3 个月" in hit.answer


class TestVerticalIsolation:
    """地铁品类的客户不能命中工厂的问答。"""

    async def test_subway_cannot_hit_factory_faq(self, faq_db, session) -> None:
        hit = await kb_faq.lookup(session, "包吃住吗", vertical_code="subway", employer_id=None)
        assert hit is None, "地铁品类命中了工厂问答 = 品类隔离失效"


class TestPlaceholderRender:
    """占位符渲染：缺值整句丢弃，绝不输出 {wage} 字面量。"""

    def test_render_with_value(self) -> None:
        out = kb_faq.render("这边工价是{wage}，包吃住", job={"wage_text": "25元/小时"})
        assert out == "这边工价是25元/小时，包吃住"

    def test_render_missing_value_drops_sentence(self) -> None:
        out = kb_faq.render("这边工价是{wage}", job={})
        assert out == ""
        assert "{" not in out

    def test_render_keeps_neighbour_sentence(self) -> None:
        out = kb_faq.render(
            "面试地点在{address}。带身份证原件。",
            location={"address": "番禺钟村"},
        )
        assert out == "面试地点在番禺钟村。带身份证原件。"

    def test_render_unknown_placeholder_not_leaked(self) -> None:
        out = kb_faq.render("你好{不存在的字段}再见。这条保留。", job={})
        assert "{不存在的字段}" not in out
        assert "这条保留。" in out

    def test_media_json_tolerates_dirty_data(self) -> None:
        assert kb_faq._loads('["【图片:广州面试点】"]') == ["【图片:广州面试点】"]
        assert kb_faq._loads("not json") == []

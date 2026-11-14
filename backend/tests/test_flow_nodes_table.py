"""节点表在 Python 侧的存在性与可读性。

背景：`flow_graph.load_graph()` 直查 `flow_nodes` / `flow_edges`。这两张表最初
只在 Node 侧 SQLite 建过（`src/db/migrations/029_flow_nodes.sql`），8090 连的是
另一个库，查不到就抛异常 → 回空图 → 节点编排永远不生效，而且没有任何报错。

这里锁三件事：
1. `init_db()` 会把这两张表建出来（新建库 / 空 PG 也不会 "no such table"）
2. 表为空时 `load_graph` 回空图——即「建表不等于启用」，线上行为不变
3. 灌了节点之后能正常读出节点、边与入口
"""

from __future__ import annotations

from sqlalchemy import text

from app.db import SessionLocal, init_db
from app.services import flow_graph


async def _seed_factory_graph() -> None:
    """用 ORM 插入，default= 才会补上 created_at / media 这些 NOT NULL 列。"""
    from app.models_flow_graph import FlowEdge, FlowNode

    async with SessionLocal() as session:
        session.add_all([
            FlowNode(
                tenant_id=1, device_code="", vertical_code="factory",
                node_key="send_info", title="发岗位卡", is_entry=1, sort_order=1,
            ),
            FlowNode(
                tenant_id=1, device_code="", vertical_code="factory",
                node_key="ask_interview", title="约面试", sort_order=2,
            ),
            FlowEdge(
                tenant_id=1, device_code="", vertical_code="factory",
                from_node="send_info", to_node="ask_interview",
                condition_type="keyword", condition_value="可以,行", priority=10,
            ),
        ])
        await session.commit()


def test_models_are_registered() -> None:
    """模型必须挂在 Base.metadata 上，否则 create_all 建不出表。"""
    from app.models import Base

    assert "flow_nodes" in Base.metadata.tables
    assert "flow_edges" in Base.metadata.tables


async def test_empty_graph_when_no_nodes() -> None:
    """建了表但没数据 → 空图。这是迁移期「不破坏原有」的关键保证。"""
    await init_db()
    async with SessionLocal() as session:
        graph = await flow_graph.load_graph(
            session, device_code="", vertical_code="factory-empty-check"
        )
    assert graph["nodes"] == []
    assert graph["edges"] == []
    assert graph["entry"] is None


async def test_load_graph_reads_seeded_nodes() -> None:
    await init_db()
    async with SessionLocal() as session:
        existing = (
            await session.execute(
                text("SELECT COUNT(*) FROM flow_nodes WHERE vertical_code='factory'")
            )
        ).scalar()
        if not existing:
            await _seed_factory_graph()
        graph = await flow_graph.load_graph(
            session, device_code="", vertical_code="factory"
        )
    assert len(graph["nodes"]) >= 2
    assert graph["entry"] == "send_info"
    assert any(edge["from_node"] == "send_info" for edge in graph["edges"])


async def test_other_vertical_sees_nothing() -> None:
    """按板块隔离：工厂的节点不能被地铁设备读到。"""
    await init_db()
    async with SessionLocal() as session:
        graph = await flow_graph.load_graph(
            session, device_code="", vertical_code="subway-nonexistent"
        )
    assert graph["nodes"] == []

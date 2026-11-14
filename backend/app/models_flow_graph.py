"""节点化编排的表（flow_nodes / flow_edges）。

和 Node 侧 `src/db/migrations/029_flow_nodes.sql` 是同一套表结构的 Python 声明。
为什么要在 Python 侧也建：8090 的 `flow_graph.load_graph()` 直接查这两张表，
而它连的是 `APP_DATABASE_URL`（生产 PostgreSQL），不是 Node 的 SQLite。
不建表 → 查询抛异常 → 回空图 → 节点编排永远不生效。

字段与 SQLite 侧一一对应，只把 SQLite 的 TEXT 时间换成带时区的 datetime。

注意：建表不等于启用。`load_graph` 读不到节点会回退到写死流程，
所以这两张表存在但为空时，线上行为与改造前完全一致——这是迁移期要的。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow
from .models_kb import BigIntPK


class FlowNode(Base):
    """流程节点：一个板块一套，设备可单独覆盖。

    `device_code` 为空串 = 板块级模板（该板块所有设备共用）；
    非空 = 该设备专属覆盖，同 node_key 时设备那份优先（见 flow_graph.load_graph）。
    """

    __tablename__ = "flow_nodes"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(Integer, default=1, index=True)
    device_code: Mapped[str] = mapped_column(String(64), default="")
    vertical_code: Mapped[str] = mapped_column(String(50), default="")
    # 稳定标识：greet / send_info / ask_city ...，默认节点与 flow_engine 的 stage 同名
    node_key: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(100), default="")
    # 话术正文，支持 {{factory}} {{wage}} 等占位符；空串 = 用系统默认话术
    body: Mapped[str] = mapped_column(Text, default="")
    media: Mapped[str] = mapped_column(Text, default="")
    is_entry: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="enabled")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    data_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "device_code", "vertical_code", "node_key",
            name="uq_flow_node_scope",
        ),
    )


class FlowEdge(Base):
    """节点之间的连线：条件满足时从 from_node 转到 to_node。

    condition_type: always / keyword / regex / collected / intent（intent 当前按 keyword）。
    priority 小的先生效——「拒绝」这类边永远要排在「答应」前面。
    """

    __tablename__ = "flow_edges"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(Integer, default=1, index=True)
    device_code: Mapped[str] = mapped_column(String(64), default="")
    vertical_code: Mapped[str] = mapped_column(String(50), default="")
    from_node: Mapped[str] = mapped_column(String(64))
    to_node: Mapped[str] = mapped_column(String(64))
    condition_type: Mapped[str] = mapped_column(String(20), default="always")
    condition_value: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[int] = mapped_column(Integer, default=100)
    status: Mapped[str] = mapped_column(String(20), default="enabled")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


__all__ = ["FlowNode", "FlowEdge"]

"""多租户 + 知识库数据模型。

和 models.py 的分工：
- models.py 是"实时通信层"的表（设备/通道/会话/消息/发件箱）；
- 本文件是"配置与知识层"的表（租户/分类/条目/片段/素材）。

设计依据见 docs/知识库与后端技术选型-决策文档.md 第 5 节，三个关键点：

1. `kb_entry.kind` 分 `job` / `script`。这是能不能安全接 LLM 的开关：
   `job` 里的事实（工价、年龄、面试时间）禁止改写，`script` 里的话术可以任意润色。
   混在一起，模型会编工价。
2. `interview_at` 存 timestamptz，不存"明天"。源数据 245 条含相对日期，
   入库时必须换算成绝对时间，展示时再算回"明天"。
3. 图片脱离 base64 存对象存储，库里只留 `storage_key`。

单租户阶段（现在）：`tenant_id` 全部 DEFAULT 1，不开 RLS。
接第二个客户时再加 Row-Level Security，见计划阶段 4。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .models import Base, utcnow

DEFAULT_TENANT_ID = 1

# PostgreSQL 用 BIGSERIAL；SQLite 只有在列类型正好是 INTEGER PRIMARY KEY 时
# 才是 rowid 别名（自动递增）。BigInteger 声明到 SQLite 会变成 BIGINT PRIMARY KEY，
# 插入时 id 为 NULL 直接报 NOT NULL 约束失败——测试和本地开发都跑不起来。
# with_variant 让两边各用各的正确类型，迁移到 PG 后不改一行代码。
BigIntPK = BigInteger().with_variant(Integer, "sqlite")


class Tenant(Base):
    """一家劳务公司 = 一个租户。平台域表，本身不带 tenant_id。"""

    __tablename__ = "tenant"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="active")
    settings_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    __table_args__ = (
        CheckConstraint("status IN ('active', 'suspended')", name="ck_tenant_status"),
    )


class KbCategory(Base):
    """分类树。源数据 word_class 的 ParentSign 是两层结构，这里用 parent_id 表达任意层。"""

    __tablename__ = "kb_category"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenant.id"), default=DEFAULT_TENANT_ID, index=True
    )
    parent_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("kb_category.id", ondelete="SET NULL"), nullable=True
    )
    label: Mapped[str] = mapped_column(String(255))
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    __table_args__ = (Index("ix_kb_category_tenant_parent", "tenant_id", "parent_id"),)


class KbEntry(Base):
    """一条知识：要么是一个岗位（kind='job'），要么是一条话术（kind='script'）。

    岗位的结构化字段（city/age/wage/...）是分层检索第 1 层的基础。
    "我 52 了还能去吗"这句话里没有岗位名，只有 `age_max >= 52` 这种确定性判断
    才能给出正确回答——这是 SQL 放在检索最前面的真正原因，不是性能。
    """

    __tablename__ = "kb_entry"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenant.id"), default=DEFAULT_TENANT_ID, index=True
    )
    category_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("kb_category.id", ondelete="SET NULL"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(20), default="script")
    title: Mapped[str] = mapped_column(String(500))

    # 岗位事实字段：只对 kind='job' 有意义，从文案里抽取
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    district: Mapped[str | None] = mapped_column(String(100), nullable=True)
    factory_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    age_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    age_max: Mapped[int | None] = mapped_column(Integer, nullable=True)
    wage_min: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    wage_max: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    wage_unit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    has_meal: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_dorm: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    interview_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # 通用字段
    body: Mapped[str] = mapped_column(Text, default="")
    search_text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="enabled")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    fragments: Mapped[list["KbFragment"]] = relationship(
        back_populates="entry", order_by="KbFragment.position", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("kind IN ('job', 'script')", name="ck_kb_entry_kind"),
        CheckConstraint(
            "status IN ('enabled', 'disabled', 'expired')", name="ck_kb_entry_status"
        ),
        CheckConstraint(
            "age_min IS NULL OR (age_min >= 0 AND age_min <= 150)", name="ck_kb_entry_age_min"
        ),
        CheckConstraint(
            "age_max IS NULL OR (age_max >= 0 AND age_max <= 150)", name="ck_kb_entry_age_max"
        ),
        CheckConstraint(
            "wage_unit IS NULL OR wage_unit IN ('hour', 'day', 'month')",
            name="ck_kb_entry_wage_unit",
        ),
        # 覆盖检索的三种入口：租户+状态（全表扫的兜底）、城市、年龄区间。
        # 这三个索引对应 kb_search 的第 1 层条件，缺任何一个都会退化成全表扫描。
        Index("ix_kb_entry_tenant_status", "tenant_id", "status"),
        Index("ix_kb_entry_tenant_city", "tenant_id", "city"),
        Index("ix_kb_entry_tenant_age", "tenant_id", "age_min", "age_max"),
    )


class KbAsset(Base):
    """图片等二进制素材。base64 不落库，只存对象存储路径。

    源数据 78 张图共 157 MB 全在 base64 里，每次查询都在拖慢整个库。
    """

    __tablename__ = "kb_asset"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenant.id"), default=DEFAULT_TENANT_ID, index=True
    )
    storage_key: Mapped[str] = mapped_column(String(500))
    mime: Mapped[str | None] = mapped_column(String(100), nullable=True)
    bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class KbFragment(Base):
    """条目内的有序片段。源数据 263 条是"一条目多片段"，顺序不能丢。"""

    __tablename__ = "kb_fragment"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    entry_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("kb_entry.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20), default="text")
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    asset_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("kb_asset.id", ondelete="SET NULL"), nullable=True
    )

    entry: Mapped[KbEntry] = relationship(back_populates="fragments")

    __table_args__ = (
        UniqueConstraint("entry_id", "position", name="uq_kb_fragment_position"),
        CheckConstraint("kind IN ('text', 'image')", name="ck_kb_fragment_kind"),
    )

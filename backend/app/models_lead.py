"""谈单状态与面试记录。

`leads` 每个会话一条，记录当前进展；`lead_events` 只追加，记录每一次流转。
两者分开是因为：列表页只需要当前状态，而统计（今天约了几个人、到面率）
必须靠流水算，不能靠覆盖当前值。

设计见 docs/谈单状态机与面试记录设计.md
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, inspect, text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow

# 业务时区固定东八区。库里统一存 naive UTC，展示/归一都先转到这个时区。
LOCAL_TZ = timezone(timedelta(hours=8))

# 约面精度：minute=钟点确定；day=只知道哪一天（"明天过来"就是这种）
PRECISION_MINUTE = "minute"
PRECISION_DAY = "day"

# 状态枚举。顺序有意义：前 6 个是主流程，后 4 个是分支/终态。
STAGE_NEW = "new"
STAGE_ASKING = "asking"
STAGE_INTENT = "intent"
STAGE_BOOKED = "booked"
STAGE_INTERVIEWED = "interviewed"
STAGE_HIRED = "hired"
STAGE_NO_SHOW = "no_show"
STAGE_GAVE_UP = "gave_up"
STAGE_UNSUITABLE = "unsuitable"
STAGE_DORMANT = "dormant"

ALL_STAGES = (
    STAGE_NEW,
    STAGE_ASKING,
    STAGE_INTENT,
    STAGE_BOOKED,
    STAGE_INTERVIEWED,
    STAGE_HIRED,
    STAGE_NO_SHOW,
    STAGE_GAVE_UP,
    STAGE_UNSUITABLE,
    STAGE_DORMANT,
)

STAGE_LABEL = {
    STAGE_NEW: "新来",
    STAGE_ASKING: "咨询中",
    STAGE_INTENT: "有意向",
    STAGE_BOOKED: "已约面",
    STAGE_INTERVIEWED: "已到面",
    STAGE_HIRED: "已入职",
    STAGE_NO_SHOW: "爽约",
    STAGE_GAVE_UP: "客户放弃",
    STAGE_UNSUITABLE: "条件不符",
    STAGE_DORMANT: "沉默",
}

# 主流程的推进顺序，用于拦截"自动倒退"
STAGE_ORDER = {
    STAGE_NEW: 0,
    STAGE_ASKING: 1,
    STAGE_INTENT: 2,
    STAGE_BOOKED: 3,
    STAGE_INTERVIEWED: 4,
    STAGE_HIRED: 5,
}


class Lead(Base):
    """一个会话的谈单现状。"""

    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id"), unique=True, index=True
    )

    stage: Mapped[str] = mapped_column(String(24), default=STAGE_NEW, index=True)
    # 约的时间。stage=booked 时必须有值，否则只算 intent
    interview_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 约面精度：minute=钟点确定；day=只知道哪一天（此时 interview_at 归一为本地 00:00）
    interview_precision: Mapped[str] = mapped_column(String(8), default=PRECISION_DAY)
    # 该标"待核实"的时刻（naive UTC）。由 compute_check_at 算出，NULL 表示不用扫
    check_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # 已产出待办提醒的时刻，与"有没有给客户发消息"无关
    alerted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    interview_place: Mapped[str | None] = mapped_column(String(128), nullable=True)
    job_title: Mapped[str | None] = mapped_column(String(128), nullable=True)

    age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    city: Mapped[str | None] = mapped_column(String(32), nullable=True)
    intent: Mapped[int] = mapped_column(Integer, default=0)  # 1-5 意向度
    confidence: Mapped[float] = mapped_column(Float, default=0.0)

    # booked 且过了约定时间，等人工确认"到面"还是"爽约"
    pending_confirm: Mapped[bool] = mapped_column(Boolean, default=False)

    last_message_id: Mapped[str] = mapped_column(String(64), default="")
    updated_by: Mapped[str] = mapped_column(String(16), default="llm")  # llm / manual / system
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class LeadEvent(Base):
    """状态流转流水。只追加，不改不删。"""

    __tablename__ = "lead_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    # stage_change / scheduled / rescheduled / no_show / manual
    event_type: Mapped[str] = mapped_column(String(24), default="stage_change")
    from_stage: Mapped[str | None] = mapped_column(String(24), nullable=True)
    to_stage: Mapped[str | None] = mapped_column(String(24), nullable=True)
    payload: Mapped[str] = mapped_column(Text, default="{}")  # JSON：时间/地点/岗位/理由
    source: Mapped[str] = mapped_column(String(16), default="llm")
    message_id: Mapped[str] = mapped_column(String(64), default="")


# ─────────────────────── 待核实时刻 ───────────────────────
def _to_local(dt: datetime) -> datetime:
    """库里是 naive UTC，先补时区再转东八区；带时区的直接转。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ)


def _to_naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def compute_check_at(
    interview_at: datetime | None,
    precision: str | None,
    now: datetime | None = None,
) -> datetime | None:
    """算出「该标待核实」的时刻，返回 naive UTC（库里统一这个口径）。

    两种精度分开算，因为「知道几点」和「只知道哪天」能容忍的滞后完全不同：

    - day：客户只说"明天过来"，那就当天 18:00 巡一次，问他到底来没来；
    - minute：约了钟点，+3 小时还没消息就提醒。若这个点落在夜间
      （本地 22:00–08:00），顺延到最近的 09:00 —— 半夜弹待办没人处理，
      第二天也会被新一批覆盖掉。

    ``now`` 保留给调用方传时间基准，本函数本身不依赖它（规则是纯函数，好测）。
    """
    if interview_at is None:
        return None

    local = _to_local(interview_at)

    if precision != PRECISION_MINUTE:
        # 只知道哪一天：本地当天 18:00（此时 local 已被归一为当天 00:00）
        return _to_naive_utc(local.replace(hour=18, minute=0, second=0, microsecond=0))

    candidate = local + timedelta(hours=3)
    if candidate.hour >= 22:
        # 22:00 之后 -> 次日 09:00
        candidate = (candidate + timedelta(days=1)).replace(
            hour=9, minute=0, second=0, microsecond=0
        )
    elif candidate.hour < 8:
        # 凌晨 -> 当天 09:00
        candidate = candidate.replace(hour=9, minute=0, second=0, microsecond=0)
    return _to_naive_utc(candidate)


# ─────────────────────── 存量库补列 ───────────────────────
async def ensure_lead_columns(conn) -> list[str]:
    """给已存在的 leads 表补上后加的列，返回本次新建的列名。

    ``Base.metadata.create_all`` 只建表不改表，存量库（已经在跑的环境）不会
    自动多出这三列，所以启动时显式补一次。

    两条硬约束：

    1. ``interview_precision`` 用 ``DEFAULT 'day'`` 回填——历史数据本来就没记
       精度，按「只知道哪一天」解释最保守；
    2. ``check_at`` / ``alerted_at`` **绝不回填**，保持 NULL。一旦回填，
       上线瞬间所有历史 booked 会同时到点，扫描 worker 一次把所有线索标成
       待核实，等于批量事故。
    """
    def _existing_columns(sync_conn) -> set[str] | None:
        insp = inspect(sync_conn)
        if not insp.has_table("leads"):
            return None
        return {c["name"] for c in insp.get_columns("leads")}

    existing = await conn.run_sync(_existing_columns)
    if existing is None:
        # 表还没建（全新库），create_all 会带上全部列
        return []

    # SQLite 用 DATETIME；Postgres 要与 DateTime(timezone=True) 建出来的类型一致
    ts_type = "DATETIME" if conn.dialect.name == "sqlite" else "TIMESTAMP WITH TIME ZONE"
    ddl = {
        "interview_precision": "VARCHAR(8) DEFAULT 'day'",
        "check_at": ts_type,
        "alerted_at": ts_type,
    }

    added: list[str] = []
    for name in ("interview_precision", "check_at", "alerted_at"):
        if name in existing:
            continue
        await conn.execute(text(f"ALTER TABLE leads ADD COLUMN {name} {ddl[name]}"))
        added.append(name)

    if "check_at" in added:
        await conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_leads_check_at ON leads (check_at)")
        )
    return added

"""谈单状态与面试记录。

`leads` 每个会话一条，记录当前进展；`lead_events` 只追加，记录每一次流转。
两者分开是因为：列表页只需要当前状态，而统计（今天约了几个人、到面率）
必须靠流水算，不能靠覆盖当前值。

设计见 docs/谈单状态机与面试记录设计.md
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, utcnow

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

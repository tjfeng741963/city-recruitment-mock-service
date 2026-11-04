"""谈单线索接口。

- `POST /leads/observe`  给本地 agent 用（JWT 或服务令牌），对话发完后上报，触发抽取
- `GET  /leads`          后台列表
- `GET  /leads/stats`    漏斗与今日统计
- `POST /leads/{id}/manual` 人工标记到面/入职/爽约（这些只能靠人确认）
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .api_kb import _build_provider
from .deps import AdminUser, ServiceOrUser, SessionDep
from .models import ChannelAccount, Conversation, Customer
from .models_lead import (
    ALL_STAGES,
    PRECISION_DAY,
    PRECISION_MINUTE,
    STAGE_LABEL,
    Lead,
    LeadEvent,
    compute_check_at,
)
from .services.agent_ingest import _counterpart, ensure_channel_account
from .services.lead_extract import observe as extract_observe

router = APIRouter(prefix="/api/v1/leads", tags=["leads"])

LOCAL_TZ = timezone(timedelta(hours=8))

# 人工标这些状态说明这次约面已经有结论了，待核实提醒必须一并收掉，
# 否则列表上会一直挂着「待核实」的噪音。
CLOSED_STAGES = {"interviewed", "hired", "no_show", "gave_up", "unsuitable"}


# ─────────────────────────── 入参 / 出参 ───────────────────────────
class HistoryItem(BaseModel):
    role: str = Field(description="customer 或 agent")
    text: str
    at: str | None = None


class ObserveIn(BaseModel):
    conversation_external_id: str
    channel_external_id: str
    nickname: str | None = None
    last_message_id: str = ""
    history: list[HistoryItem] = Field(default_factory=list)


class LeadOut(BaseModel):
    conversation_id: int
    external_id: str
    nickname: str | None = None
    stage: str
    stage_label: str
    interview_at: datetime | None = None
    interview_precision: str = PRECISION_DAY
    interview_place: str | None = None
    job_title: str | None = None
    age: int | None = None
    city: str | None = None
    intent: int
    confidence: float
    pending_confirm: bool
    updated_by: str
    updated_at: datetime | None = None


class ManualIn(BaseModel):
    stage: str
    interview_at: datetime | None = None
    # 人工改时间时顺手校准精度；不传就沿用原值
    interview_precision: str | None = None
    interview_place: str | None = None
    note: str | None = None


# ─────────────────────────── 工具 ───────────────────────────
def _local_day_start(now: datetime | None = None) -> datetime:
    """本地（东八区）当天 0 点，转成 naive UTC —— 库里存的就是 naive UTC。"""
    ref = (now or datetime.now(timezone.utc)).astimezone(LOCAL_TZ)
    start_local = ref.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_local.astimezone(timezone.utc).replace(tzinfo=None)


def _now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _ensure_conversation(
    session, channel_external_id: str, conversation_external_id: str, nickname: str | None
) -> Conversation:
    """会话可能还没被采集上报过，这里按 external_id 兜底建一个。"""
    channel: ChannelAccount = await ensure_channel_account(session, None, channel_external_id)

    conv = (
        await session.execute(
            select(Conversation).where(
                Conversation.channel_account_id == channel.id,
                Conversation.external_id == conversation_external_id,
            )
        )
    ).scalar_one_or_none()
    if conv:
        if nickname:
            customer = await session.get(Customer, conv.customer_id)
            if customer is not None and not customer.nickname:
                customer.nickname = nickname
        return conv

    counterpart = _counterpart(conversation_external_id, channel_external_id)
    customer = (
        await session.execute(
            select(Customer).where(
                Customer.channel_account_id == channel.id,
                Customer.external_userid == counterpart,
            )
        )
    ).scalar_one_or_none()
    if customer is None:
        customer = Customer(
            channel_account_id=channel.id,
            external_userid=counterpart,
            nickname=nickname,
        )
        session.add(customer)
        await session.flush()
    elif nickname and not customer.nickname:
        # 采集上报时昵称可能是空的，这里补上
        customer.nickname = nickname

    conv = Conversation(
        channel_account_id=channel.id,
        customer_id=customer.id,
        external_id=conversation_external_id,
        kind="group" if conversation_external_id.startswith("R:") else "single",
    )
    session.add(conv)
    await session.flush()
    return conv


def _to_local(dt: datetime | None) -> datetime | None:
    """库里是 naive UTC，返回给前端统一带东八区偏移，避免前端猜。"""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ)


def _to_out(lead: Lead, conv: Conversation, nickname: str | None) -> LeadOut:
    return LeadOut(
        conversation_id=lead.conversation_id,
        external_id=conv.external_id,
        nickname=nickname,
        stage=lead.stage,
        stage_label=STAGE_LABEL.get(lead.stage, lead.stage),
        interview_at=_to_local(lead.interview_at),
        interview_precision=lead.interview_precision or PRECISION_DAY,
        interview_place=lead.interview_place,
        job_title=lead.job_title,
        age=lead.age,
        city=lead.city,
        intent=lead.intent,
        confidence=lead.confidence,
        pending_confirm=lead.pending_confirm,
        updated_by=lead.updated_by,
        updated_at=lead.updated_at,
    )


# ─────────────────────────── 上报（agent） ───────────────────────────
@router.post("/observe")
async def observe(payload: ObserveIn, caller: ServiceOrUser, session: SessionDep) -> dict:
    """agent 发完消息后调用。抽取失败不影响业务，只返回原因。"""
    if not payload.history:
        return {"changed": False, "reason": "没有对话内容"}

    conv = await _ensure_conversation(
        session,
        payload.channel_external_id,
        payload.conversation_external_id,
        payload.nickname,
    )
    await session.commit()

    provider = _build_provider()
    history = [h.model_dump() for h in payload.history]

    result = await extract_observe(
        session,
        conv,
        history,
        provider=provider,
        message_id=payload.last_message_id,
    )
    return result


# ─────────────────────────── 列表 ───────────────────────────
@router.get("", response_model=list[LeadOut])
async def list_leads(
    admin: AdminUser,
    session: SessionDep,
    stage: str | None = Query(default=None),
    pending_confirm: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[LeadOut]:
    stmt = (
        select(Lead, Conversation, Customer.nickname)
        .join(Conversation, Conversation.id == Lead.conversation_id)
        .join(Customer, Customer.id == Conversation.customer_id)
        .order_by(Lead.updated_at.desc())
        .limit(limit)
    )
    if stage:
        stmt = stmt.where(Lead.stage == stage)
    if pending_confirm is not None:
        stmt = stmt.where(Lead.pending_confirm == pending_confirm)
    rows = (await session.execute(stmt)).all()
    return [_to_out(lead, conv, nick) for lead, conv, nick in rows]


# ─────────────────────────── 统计 ───────────────────────────
@router.get("/stats")
async def stats(admin: AdminUser, session: SessionDep) -> dict:
    day_start = _local_day_start()

    by_stage = dict(
        (await session.execute(select(Lead.stage, func.count()).group_by(Lead.stage))).all()
    )

    async def _count_events(**where) -> int:
        stmt = select(func.count()).select_from(LeadEvent)
        for key, val in where.items():
            stmt = stmt.where(getattr(LeadEvent, key) == val)
        return int((await session.execute(stmt)).scalar_one())

    scheduled_today = int(
        (
            await session.execute(
                select(func.count())
                .select_from(LeadEvent)
                .where(LeadEvent.event_type == "scheduled", LeadEvent.at >= day_start)
            )
        ).scalar_one()
    )
    interviewed_today = int(
        (
            await session.execute(
                select(func.count())
                .select_from(LeadEvent)
                .where(LeadEvent.to_stage == "interviewed", LeadEvent.at >= day_start)
            )
        ).scalar_one()
    )
    no_show_today = int(
        (
            await session.execute(
                select(func.count())
                .select_from(LeadEvent)
                .where(LeadEvent.to_stage == "no_show", LeadEvent.at >= day_start)
            )
        ).scalar_one()
    )
    new_today = int(
        (
            await session.execute(
                select(func.count()).select_from(Lead).where(Lead.created_at >= day_start)
            )
        ).scalar_one()
    )

    booked_total = await _count_events(event_type="scheduled")
    interviewed_total = int(
        (
            await session.execute(
                select(func.count()).select_from(LeadEvent).where(LeadEvent.to_stage == "interviewed")
            )
        ).scalar_one()
    )
    no_show_total = int(
        (
            await session.execute(
                select(func.count()).select_from(LeadEvent).where(LeadEvent.to_stage == "no_show")
            )
        ).scalar_one()
    )

    def _rate(a: int, b: int) -> float:
        return round(a / b, 3) if b else 0.0

    return {
        "total": sum(by_stage.values()),
        "by_stage": by_stage,
        "today": {
            "new": new_today,
            "scheduled": scheduled_today,
            "interviewed": interviewed_today,
            "no_show": no_show_today,
        },
        "funnel": {
            "booked": booked_total,
            "interviewed": interviewed_total,
            "no_show": no_show_total,
            "interview_rate": _rate(interviewed_total, booked_total),
            "no_show_rate": _rate(no_show_total, booked_total),
        },
    }


# ─────────────────────────── 人工标记 ───────────────────────────
@router.post("/{conversation_id}/manual", response_model=LeadOut)
async def manual_update(
    conversation_id: int,
    payload: ManualIn,
    admin: AdminUser,
    session: SessionDep,
) -> LeadOut:
    """到面 / 入职 / 爽约确认 / 改期 —— 这些只能人工判定。"""
    if payload.stage not in ALL_STAGES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"未知状态 {payload.stage!r}")

    lead = (
        await session.execute(select(Lead).where(Lead.conversation_id == conversation_id))
    ).scalar_one_or_none()
    if lead is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "该会话还没有线索记录")

    conv = await session.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")

    old_stage = lead.stage
    if payload.stage == "booked" and payload.interview_at is None and lead.interview_at is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "标记为已约面必须提供 interview_at")

    lead.stage = payload.stage
    if payload.interview_at is not None:
        lead.interview_at = (
            payload.interview_at.astimezone(timezone.utc).replace(tzinfo=None)
            if payload.interview_at.tzinfo
            else payload.interview_at
        )
    if payload.interview_precision is not None:
        # 只认两种，填错按最保守的"只知道哪一天"处理
        lead.interview_precision = (
            PRECISION_MINUTE
            if payload.interview_precision == PRECISION_MINUTE
            else PRECISION_DAY
        )
    if payload.interview_place:
        lead.interview_place = payload.interview_place
    lead.pending_confirm = False
    lead.updated_by = "manual"

    if payload.stage == "booked":
        # 时间/精度任一被人工改过，待核实时刻都要重算，旧提醒作废
        lead.check_at = compute_check_at(lead.interview_at, lead.interview_precision)
        lead.alerted_at = None
    elif payload.stage in CLOSED_STAGES:
        lead.check_at = None
        lead.alerted_at = None

    session.add(
        LeadEvent(
            conversation_id=conversation_id,
            event_type="manual",
            from_stage=old_stage,
            to_stage=payload.stage,
            payload=json.dumps(
                {
                    "note": payload.note,
                    "by": admin.username,
                    "interview_at": lead.interview_at.isoformat() if lead.interview_at else None,
                    "interview_precision": lead.interview_precision,
                },
                ensure_ascii=False,
            ),
            source="manual",
        )
    )
    await session.commit()

    customer = await session.get(Customer, conv.customer_id)
    return _to_out(lead, conv, customer.nickname if customer else None)

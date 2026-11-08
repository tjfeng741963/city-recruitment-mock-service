"""招聘对话流程接口（演示版）。

    POST /api/v1/flow/answer    推进一轮对话
    GET  /api/v1/flow/state     查看某会话投影出的状态
    POST /api/v1/flow/reset     重置会话（追加 reset 事件，不删历史）

客户端只需要多传一个 session_key（用 4222 的 conversation_id 即可）。
每轮顺带抽出候选人档案（profile）：随事件落到 flow_events 可回放，
档案有变化时再推给 4222 的 /api/v1/agent/profile（推不推得动都不影响回复）。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .deps import ServiceOrUser, SessionDep
from .services import flow_session as store
from .services import profile_push
from .services.flow_llm import a_step
from .services.llm_provider import build_provider

router = APIRouter(prefix="/api/v1/flow", tags=["flow"])


class FlowAnswerIn(BaseModel):
    session_key: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=2000)
    # 推档案给 4222 时用来定位会话；老客户端不传也能跑（走 external_conversation_id）
    device_code: str = Field(default="", max_length=64)


class FlowAnswerOut(BaseModel):
    reply: str
    stage: str
    finished: bool
    action: str | None
    slots: dict[str, Any]
    profile: dict[str, Any] = Field(default_factory=dict)


class FlowStateOut(BaseModel):
    session_key: str
    stage: str
    slots: dict[str, Any]
    profile: dict[str, Any] = Field(default_factory=dict)
    turns: int
    history: list[dict[str, str]]
    actions: list[dict[str, Any]]


@router.post("/answer", response_model=FlowAnswerOut)
async def flow_answer(
    payload: FlowAnswerIn, session: SessionDep, _: ServiceOrUser
) -> FlowAnswerOut:
    events = await store.load_events(session, payload.session_key)
    state = store.project(events)
    before = dict(state.get("slots") or {})
    before_profile = dict(state.get("profile") or {})
    stage_before = str(state.get("stage") or "")

    # 主路径交给模型；没配模型或调用失败时，a_step 内部退到确定性状态机
    result = await a_step(state, payload.text, build_provider())

    records: list[tuple[str, dict[str, Any]]] = [
        (store.EVENT_INBOUND, {"text": payload.text})
    ]
    if result.stage != stage_before:
        records.append(
            (store.EVENT_STAGE, {"from": stage_before, "to": result.stage})
        )
    records.extend(store.diff_slots(before, result.slots))
    profile_records = store.diff_profile(before_profile, result.slots)
    records.extend(profile_records)
    if result.reply:
        records.append((store.EVENT_REPLY, {"text": result.reply}))
    if result.action:
        records.append(
            (store.EVENT_ACTION, {"name": result.action, "stage": result.stage})
        )
    await store.append_events(session, payload.session_key, records)

    profile = store.profile_of(result.slots)

    # 事件先落库，推送再尽力而为：推失败不回滚、不影响回复
    out_profile = profile_push.build_profile(result.slots, result.stage, result.action)
    if (profile_records or result.action) and profile_push.has_content(out_profile):
        device_code = payload.device_code or os.getenv(
            "FLOW_PROFILE_DEVICE", profile_push.DEFAULT_DEVICE
        )
        try:
            await profile_push.push(device_code, payload.session_key, out_profile)
        except Exception:  # noqa: BLE001  推送是附加动作，不许影响客户收到话
            pass

    return FlowAnswerOut(
        reply=result.reply,
        stage=result.stage,
        finished=result.finished,
        action=result.action,
        slots=result.slots,
        profile=profile,
    )


@router.get("/state", response_model=FlowStateOut)
async def flow_state(
    session_key: str, session: SessionDep, _: ServiceOrUser
) -> FlowStateOut:
    events = await store.load_events(session, session_key)
    if not events:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="该会话还没有事件"
        )
    state = store.project(events)
    return FlowStateOut(
        session_key=session_key,
        stage=str(state.get("stage") or ""),
        slots=state.get("slots") or {},
        profile=state.get("profile") or {},
        turns=int(state.get("turns") or 0),
        history=state.get("history") or [],
        actions=state.get("actions") or [],
    )


@router.post("/reset", status_code=status.HTTP_204_NO_CONTENT)
async def flow_reset(
    session_key: str, session: SessionDep, _: ServiceOrUser
) -> None:
    await store.append_events(session, session_key, [(store.EVENT_RESET, {})])

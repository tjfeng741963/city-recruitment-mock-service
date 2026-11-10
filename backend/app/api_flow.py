"""招聘对话流程接口（v2）。

    POST /api/v1/flow/answer    推进一轮对话
    GET  /api/v1/flow/state     查看某会话投影出的状态
    POST /api/v1/flow/reset     重置会话（追加 reset 事件，不删历史）

客户端只需要多传一个 session_key（用 4222 的 conversation_id 即可）。
每轮顺带抽出候选人档案（profile）：随事件落到 flow_events 可回放，
档案有变化时再推给 4222 的 /api/v1/agent/profile（推不推得动都不影响回复）。

响应里的 `parts` 是这一轮要说的话拆成的多条消息（客户端一次只能发一条），
`reply` 仍然是 parts 用换行拼起来的一段，老客户端不用改。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .deps import ServiceOrUser, SessionDep
from .services import flow_session as store
from .services import kb_placeholder, profile_push, unknown_questions
from .services.device_scripts import fetch_scripts, pick_script, render_script
from .services.flow_engine import (
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_SEND_INFO,
    FlowResult,
    absorb_profile,
    extract_city,
    jobs_for_city,
    set_remote_jobs,
)
from .services.job_lookup import lookup_jobs
from .services.flow_llm import a_step
from .services.llm_provider import build_provider

router = APIRouter(prefix="/api/v1/flow", tags=["flow"])

# 只有这两步客户会插问（问体检 / 住宿 / 地点），别的阶段不查库，省一次查询
_KB_STAGES = {STAGE_ASK_INTERVIEW, STAGE_COLLECT}


class FlowAnswerIn(BaseModel):
    session_key: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=2000)
    # 推档案给 4222 时用来定位会话；老客户端不传也能跑（走 external_conversation_id）
    device_code: str = Field(default="", max_length=64)


class FlowAnswerOut(BaseModel):
    reply: str
    parts: list[str] = Field(default_factory=list)
    attachments: list[Any] = Field(default_factory=list)
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
    slots = state.setdefault("slots", {})

    # 知识库只做占位命中（标题关键词包含匹配），没命中交给流程走兜底话术
    kb_answer: str | None = None
    if stage_before in _KB_STAGES:
        try:
            kb_answer = await kb_placeholder.lookup(session, payload.text)
        except Exception:  # noqa: BLE001  查库失败等同于没命中，不能挡住回复
            kb_answer = None

    device_code = payload.device_code or os.getenv(
        "FLOW_PROFILE_DEVICE", profile_push.DEFAULT_DEVICE
    )

    # 城市线索：先看客户这轮说的，再看已有槽位（别名归一在 4222 侧，这里只透传）
    city_hint = extract_city(payload.text) or str(slots.get("city") or "")

    # ① 按城市查真实岗位（60s 缓存，失败返回 []）并注入引擎：
    #    本轮所有取岗位的地方（发信息/模型简报/工价护栏/档案推送）统一走
    #    jobs_for_city：远端优先，DEMO_JOBS 兜底。无城市线索时清空注入。
    if city_hint:
        try:
            remote_jobs = await lookup_jobs(city_hint)
        except Exception:  # noqa: BLE001
            remote_jobs = []
        set_remote_jobs({city_hint: remote_jobs})
    else:
        set_remote_jobs({})

    # ② 按设备拉 config 话术：send_info 轮命中就整段直发，不过模型（防改数字）
    script: dict[str, Any] | None = None
    if city_hint:
        try:
            script = pick_script(await fetch_scripts(device_code), STAGE_SEND_INFO, city_hint)
        except Exception:  # noqa: BLE001  config 拉不到就走原逻辑
            script = None

    will_send_info = (
        bool(city_hint)
        and stage_before in (STAGE_ASK_CITY, STAGE_SEND_INFO)
        and not slots.get("interview_offer_sent")
    )

    if script and will_send_info and str(script.get("content") or "").strip():
        # config 话术命中：岗位数据照常注入占位符，档案抽取照常做，
        # 只是发出去的话换成运营配的整段话术
        slots["city"] = city_hint
        slots.setdefault("job_index", 0)
        absorb_profile(slots, payload.text)
        slots["interview_offer_sent"] = True
        job = (jobs_for_city(city_hint) or [{}])[0]
        result = FlowResult(
            reply="",
            parts=[render_script(str(script.get("content") or ""), job)],
            stage=STAGE_ASK_INTERVIEW,
            slots=slots,
        )
    else:
        # ③ 主路径交给模型；没配模型或调用失败时，a_step 内部退到确定性状态机
        result = await a_step(state, payload.text, build_provider(), kb_answer=kb_answer)

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
        # parts 一并落库：回放时能看出「那轮其实发了两条」
        records.append((store.EVENT_REPLY, {"text": result.reply, "parts": result.parts}))
    if result.action:
        records.append(
            (store.EVENT_ACTION, {"name": result.action, "stage": result.stage})
        )
    await store.append_events(session, payload.session_key, records)

    profile = store.profile_of(result.slots)

    # 事件先落库，推送再尽力而为：推失败不回滚、不影响回复
    out_profile = profile_push.build_profile(result.slots, result.stage, result.action)
    if (profile_records or result.action) and profile_push.has_content(out_profile):
        try:
            await profile_push.push(device_code, payload.session_key, out_profile)
        except Exception:  # noqa: BLE001  推送是附加动作，不许影响客户收到话
            pass

    # 知识库没答上来的原话：记一条给运营补话术（同样不许影响回复）
    if result.unknown_question:
        try:
            await unknown_questions.record(
                result.unknown_question,
                device_code=device_code,
                session_key=payload.session_key,
            )
        except Exception:  # noqa: BLE001
            pass

    return FlowAnswerOut(
        reply=result.reply,
        parts=result.parts,
        attachments=result.attachments,
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

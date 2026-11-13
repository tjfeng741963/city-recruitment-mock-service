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
import re
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .deps import ServiceOrUser, SessionDep
from .services import flow_session as store
from .services import kb_placeholder, profile_push, unknown_questions
from .services.device_scripts import fetch_device_meta, fetch_scripts, pick_script, render_script
from .services.flow_engine import (
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_SEND_INFO,
    absorb_profile,
    extract_city,
    jobs_for_city,
    set_remote_jobs,
)
from .services.job_lookup import lookup_jobs
from .services.flow_llm import a_step, build_material
from .services.llm_provider import build_provider

router = APIRouter(prefix="/api/v1/flow", tags=["flow"])

# 只有这两步客户会插问（问体检 / 住宿 / 地点），别的阶段不查库，省一次查询
_KB_STAGES = {STAGE_ASK_INTERVIEW, STAGE_COLLECT}
# 纯问候语不查知识库（2026-11-13：客户只发「你好」被回「刚才回复过你」）
_GREETING_RE = re.compile(
    r"^(你好|您好|在吗|在么|嗨|哈喽|hi|hello|老板|师傅|帅哥|美女)[!！。~～,，\s]*$", re.I
)


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
    # done 重激活：流程结束后客户再来消息（问工资/换岗位…），AI 要继续服务
    # 而不是永远沉默——重置流程从问城市重新开始，老客户档案抽取照常
    flow_reset = stage_before == "done"
    if flow_reset:
        # 只重置阶段、保留 slots/profile——老客户的档案和城市不能丢。
        # 回到 ask_interview（老客户已看过岗位）：插问 KB 分支继续可用
        state["stage"] = "ask_interview"
        before["stage"] = "ask_interview"
        before_profile = dict(state.get("profile") or {})
        stage_before = "ask_interview"
    slots = state.setdefault("slots", {})

    device_code = payload.device_code or os.getenv(
        "FLOW_PROFILE_DEVICE", profile_push.DEFAULT_DEVICE
    )

    # 知识库命中只作为**素材**交给模型（标题关键词包含匹配，没命中不给素材）。
    # 城市/工厂线索来自设备绑定（fetch_device_meta 60s 缓存，拉不到回空 = 通配）；
    # 设备没绑城市时退回客户自己说的城市（老行为）。同城 +3、同厂 +5，异城/异厂排除。
    kb_body: str = ""
    kb_entry_id: str | None = None
    kb_markers: list[str] = []
    kb_repeat = False
    if stage_before in _KB_STAGES and not _GREETING_RE.match((payload.text or "").strip()):
        try:
            meta = await fetch_device_meta(device_code)
        except Exception:  # noqa: BLE001  meta 拉不到按通配，流程不中断
            meta = {"factory_name": "", "city": ""}
        try:
            city_hint_for_kb = (
                str(meta.get("city") or "")
                or extract_city(payload.text)
                or str(slots.get("city") or "")
            )
            kb_hit = await kb_placeholder.lookup_entry(
                session,
                payload.text,
                city=city_hint_for_kb,
                factory=str(meta.get("factory_name") or ""),
            )
        except Exception:  # noqa: BLE001  查库失败等同于没命中，不能挡住回复
            kb_hit = None
        if kb_hit:
            kb_entry_id = kb_hit["id"]
            kb_body = str(kb_hit.get("body") or "")
            kb_markers = re.findall(r"【(?:图片|视频):[^】]+】", kb_body)
            kb_repeat = any(
                e.type == store.EVENT_KB
                and (
                    f'"id": "{kb_entry_id}"' in (e.body or "")
                    or f'"id":"{kb_entry_id}"' in (e.body or "")
                )
                for e in events
            )

    # 城市线索：先看客户这轮说的，再看已有槽位（别名归一在 4222 侧，这里只透传）
    city_hint = extract_city(payload.text) or str(slots.get("city") or "")
    # 只在「问城市/发信息」阶段接受客户改城市；邀约/登记阶段客户顺口提个地名
    # 不能把已发的岗位换掉（否则素材和客户看到的岗位会对不上）
    if city_hint and (
        stage_before in (STAGE_ASK_CITY, STAGE_SEND_INFO) or not slots.get("city")
    ):
        slots["city"] = city_hint
        slots.setdefault("job_index", 0)
    city_for_jobs = str(slots.get("city") or city_hint)

    # ① 按城市查真实岗位（60s 缓存，失败返回 []）并注入引擎：
    #    本轮所有取岗位的地方（素材包/护栏/档案推送）统一走 jobs_for_city。
    #    城市查不到岗位时素材里明说「没有」，不编岗位。
    if city_for_jobs:
        try:
            remote_jobs = await lookup_jobs(city_for_jobs)
        except Exception:  # noqa: BLE001
            remote_jobs = []
        set_remote_jobs({city_for_jobs: remote_jobs})
    else:
        set_remote_jobs({})

    # 顺手把客户自报的姓名/手机/省区记下来（模型漏抽时档案也不丢）
    absorb_profile(
        slots, payload.text, strict_name=stage_before == STAGE_COLLECT
    )

    # ② 运营话术只作为素材（不再是「命中就整段直发」的分支）。
    #    只在还没看过岗位信息的轮次注入，避免邀约/登记阶段把介绍话术再抛一遍。
    script_material = ""
    if city_for_jobs and not slots.get("interview_offer_sent"):
        try:
            script = pick_script(
                await fetch_scripts(device_code), STAGE_SEND_INFO, city_for_jobs
            )
        except Exception:  # noqa: BLE001  config 拉不到就没这段素材
            script = None
        if script and str(script.get("content") or "").strip():
            job = (jobs_for_city(city_for_jobs) or [{}])[0]
            script_material = render_script(str(script.get("content") or ""), job)

    # ③ 已发摘要：让模型知道什么说过了，别重复倾倒
    sent_bits: list[str] = []
    if slots.get("interview_offer_sent"):
        sent_bits.append("该城市主推岗位的岗位信息已经发过（客户看过工价/地点），不要再整段重发")
    kb_sent = sum(1 for e in events if e.type == store.EVENT_KB)
    if kb_sent:
        sent_bits.append(f"知识库答复已发过 {kb_sent} 条")
    if slots.get("booked"):
        sent_bits.append("面试已经约好")
    sent_summary = "；".join(sent_bits)

    # ④ 单一决策点：这一轮的回复全部由模型决定，代码只给素材 + 事实护栏。
    #    模型没配/超时/返回乱码时才在 a_step 内部退到确定性状态机。
    material = build_material(
        state,
        payload.text,
        kb_body=kb_body,
        kb_repeat=kb_repeat,
        script=script_material,
        sent_summary=sent_summary,
    )
    # 没模型时不能用整段 KB 原文重发已答过的问题：兜底只给媒体标记
    fallback_kb = kb_body if (kb_body and not kb_repeat) else "\n".join(kb_markers)
    result = await a_step(
        state,
        payload.text,
        build_provider(),
        kb_answer=fallback_kb or None,
        material=material,
    )
    # 「沟通中」标记：一进 collect 就给 4222 发一次 stage=collect，让候选人页
    # 先出现「已答应面试，等联系方式」的一条。绕过 has_content 强推一次；
    # 槽位先记下保证整轮只推一次，推送本身尽力而为（失败不回滚不影响回复）。
    communicating = result.stage == STAGE_COLLECT and not result.slots.get(
        "communicating_pushed"
    )
    if communicating:
        result.slots["communicating_pushed"] = True

    records: list[tuple[str, dict[str, Any]]] = []
    if flow_reset:
        records.append((store.EVENT_STAGE, {"from": "done", "to": "ask_interview"}))
    records.append((store.EVENT_INBOUND, {"text": payload.text}))
    if result.stage != stage_before:
        records.append(
            (store.EVENT_STAGE, {"from": stage_before, "to": result.stage})
        )
    records.extend(store.diff_slots(before, result.slots))
    profile_records = store.diff_profile(before_profile, result.slots)
    records.extend(profile_records)
    if result.reply:
        # 回声防护：模型把客户原话当回复复读（2026-11-12 实测「能了解一下。广州
        # 地铁的那个工作吗」被原样发出）→ 丢弃模型输出，回退到知识库原文/通用接话
        inbound_text = (payload.text or "").strip()
        if len(inbound_text) >= 6 and inbound_text in result.reply:
            fallback = (kb_body if not kb_repeat else "").strip() or (
                "我在的，你想了解哪方面？工作内容、工资待遇还是面试时间？"
            )
            result.reply = fallback
            result.parts = [fallback]
        # 媒体兜底：命中的条目带【图片/视频:名称】而模型回复里弄丢了 → 补回，
        # 保证客户真的能收到视频/图片（2026-11-12「我的视频呢」教训）
        if kb_markers and not re.search(r"【(?:图片|视频):[^】]+】", result.reply):
            result.reply = result.reply.rstrip() + "\n" + "\n".join(kb_markers)
            if result.parts:
                result.parts = [p.rstrip() for p in result.parts] + [kb_markers[-1]]
        # 完整性命中护栏（2026-11-13 用户要求「问完地点就是岗位信息和图片视频」）：
        # 模型措辞由它决定，但该发卡的一轮必须发全三段（岗位/地点时间/邀约）。
        # 判断依据：客户提到了城市、模型这轮回复里却没出现该城市岗位的关键事实
        # （工价或面试地点）→ 用素材原文补全，三段同源自同一条岗位。
        try:
            _city = str(result.slots.get("city") or "").strip()
            if (
                _city
                and not result.slots.get("booked")
                and stage_before == "ask_city"
                and result.stage in ("send_info", "ask_interview")
            ):
                _jobs = jobs_for_city(_city)
                if _jobs:
                    _job = _jobs[0]
                    _wage = str(_job.get("wage_text") or "").strip()
                    _place = str(_job.get("place") or "").strip()
                    _has_fact = (
                        (_wage and _wage in result.reply)
                        or (_place and _place in result.reply)
                        or "面试地点" in result.reply
                    )
                    if not _has_fact:
                        from .services.flow_engine import send_info_parts

                        _probe = {"city": _city, "job_index": 0}
                        _card = send_info_parts(_probe)
                        if _card:
                            result.parts = list(_card)
                            result.reply = "\n".join(_card)
        except Exception:  # noqa: BLE001  补全失败不影响已生成的回复
            pass
        # parts 一并落库：回放时能看出「那轮其实发了两条」
        records.append((store.EVENT_REPLY, {"text": result.reply, "parts": result.parts}))
        if kb_entry_id:
            # 记住这条 KB 已对本会话发过：同条目再命中只提示模型别重发整段
            records.append((store.EVENT_KB, {"id": kb_entry_id}))
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

    # 「沟通中」推送：{"stage": "collect"}，4222 据此建 communicating 事件
    if communicating:
        try:
            await profile_push.push(device_code, payload.session_key, {"stage": "collect"})
        except Exception:  # noqa: BLE001  尽力而为，推不动就下一轮再说
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

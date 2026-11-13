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
from .services import kb_faq, kb_placeholder, profile_push, unknown_questions
from .services.device_scripts import fetch_device_meta, fetch_scripts, pick_script, render_script
from .services.flow_engine import (
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_SEND_INFO,
    FlowResult,
    absorb_profile,
    extract_city,
    jobs_for_city,
    set_remote_cities,
    set_remote_jobs,
)
from .services.job_lookup import lookup_cities, lookup_jobs, vertical_hint_of
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

    # 知识库两段式：
    #   ① 新路径 kb_faq —— 按品类 + 招工方硬过滤，命中就用岗位事实渲染占位符。
    #      别家厂的问答根本不进候选集，这是「分不清厂」的直接解法。
    #   ② 旧路径 kb_placeholder —— 扫存量话术，城市 +3 / 同厂 +5 打分。
    # 新路径没命中才回落旧路径，保证已有 534 条数据继续可用。
    kb_answer: str | None = None
    kb_entry_id: str | None = None
    kb_markers: list[str] = []
    kb_repeat = False
    if stage_before in _KB_STAGES:
        try:
            meta = await fetch_device_meta(device_code)
        except Exception:  # noqa: BLE001  meta 拉不到按通配，流程不中断
            meta = {"factory_name": "", "city": ""}
        city_hint_for_kb = (
            str(meta.get("city") or "")
            or extract_city(payload.text)
            or str(slots.get("city") or "")
        )
        employer_id_hint = int(meta.get("employer_id") or 0) or None
        location_id_hint = int(meta.get("location_id") or 0) or None
        position_id_hint = int(meta.get("position_id") or 0) or None

        # ① 新路径：kb_faq 硬过滤（position → employer → city → global）
        # vertical_code 必须跟设备绑定走：写死 factory 会让地铁设备永远查不到自己的包。
        try:
            faq_hit = await kb_faq.lookup(
                session,
                payload.text,
                vertical_code=str(meta.get("vertical_code") or "factory"),
                employer_id=employer_id_hint,
                location_id=location_id_hint,
                position_id=position_id_hint,
            )
        except Exception:  # noqa: BLE001  查库失败等同于没命中，不能挡住回复
            faq_hit = None
        if faq_hit:
            # 占位符用岗位事实渲染：工价/年龄/吃住都来自运营维护的岗位字段，
            # 模板里一个数字都没有，所以换工价不用改话术。
            job_for_faq = (jobs_for_city(city_hint_for_kb) or [{}])[0]
            try:
                location_ctx, employer_name = await kb_faq.resolve_context(
                    session,
                    employer_id=employer_id_hint,
                    location_id=location_id_hint,
                )
            except Exception:  # noqa: BLE001
                location_ctx, employer_name = {}, ""
            rendered = kb_faq.render(
                faq_hit.answer,
                job=job_for_faq,
                location=location_ctx,
                employer_name=employer_name,
            )
            if rendered.strip():
                kb_answer = rendered
                kb_entry_id = f"faq:{faq_hit.id}"
                kb_markers = list(faq_hit.media)

        # ② 旧路径：kb_faq 没命中才查存量话术
        if not kb_answer:
            try:
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
                kb_markers = re.findall(r"【(?:图片|视频):[^】]+】", kb_hit["body"])
                already_sent = any(
                    e.type == store.EVENT_KB
                    and f'"id": "{kb_entry_id}"' in (e.body or "")
                    or (e.type == store.EVENT_KB and f'"id":"{kb_entry_id}"' in (e.body or ""))
                    for e in events
                )
                if already_sent:
                    # 二次命中：不再重发整段（2026-11-12 青冥会话实测重复教训）。
                    # 模型只负责推进状态；最终回复在下方用确定性自然短句覆盖，
                    # 括号提示语这类内部元语言绝不下发给客户（2026-11-12 实测被复读）
                    kb_repeat = True
                    kb_answer = "\n".join(kb_markers) if kb_markers else ""
                else:
                    kb_answer = kb_hit["body"]

    # 城市线索：先看客户这轮说的，再看已有槽位（别名归一在 4222 侧，这里只透传）
    # 后台维护的城市/区县先注入进去，否则运营新建的城市（如北京）永远识别不出来。
    try:
        set_remote_cities(await lookup_cities())
    except Exception:  # noqa: BLE001  城市清单拉不到就退回硬编码别名，不影响回复
        set_remote_cities([])
    city_hint = extract_city(payload.text) or str(slots.get("city") or "")

    # ① 按城市查真实岗位（60s 缓存，失败返回 []）并注入引擎：
    #    本轮所有取岗位的地方（发信息/模型简报/工价护栏/档案推送）统一走
    #    jobs_for_city：只认远端数据。无城市线索时清空注入；
    #    城市查不到岗位时引擎走「已记下，帮你问问」话术并记未知问题。
    if city_hint:
        try:
            # 客户这轮明确说了「工厂/普工」就不再按「只推地铁」过滤
            remote_jobs = await lookup_jobs(city_hint, vertical_hint_of(payload.text))
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
        # 全部交给智能体编排（2026-11-12 用户指令）：运营话术不再是整段直发，
        # 而是作为素材交给模型组织（工价护栏保护数字）；话术里的媒体标记
        # 【图片/视频:x】也由模型取舍。档案抽取照常做。
        slots["city"] = city_hint
        slots.setdefault("job_index", 0)
        absorb_profile(slots, payload.text)
        job = (jobs_for_city(city_hint) or [{}])[0]
        script_material = render_script(str(script.get("content") or ""), job)
        material = script_material if not kb_answer else kb_answer + "\n" + script_material
        result = await a_step(state, payload.text, build_provider(), kb_answer=material)
        # 语义保持：这轮按「已发岗位+邀约」推进，下一站 ask_interview
        result.stage = STAGE_ASK_INTERVIEW
        result.slots["interview_offer_sent"] = True
    else:
        # ③ 主路径交给模型；没配模型或调用失败时，a_step 内部退到确定性状态机
        result = await a_step(state, payload.text, build_provider(), kb_answer=kb_answer)
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
        # 地铁的那个工作吗」被原样发出）→ 丢弃模型输出，回退到知识库正文/通用接话
        inbound_text = (payload.text or "").strip()
        if (
            len(inbound_text) >= 6
            and inbound_text in result.reply
            and not kb_repeat
        ):
            fallback = (kb_answer or "").strip() or "我在的，你想了解哪方面？工作内容、工资待遇还是面试时间？"
            result.reply = fallback
            result.parts = [fallback]
        # 媒体兜底：命中的条目带【图片/视频:名称】而模型回复里弄丢了 → 补回，
        # 保证客户真的能收到视频/图片（2026-11-12「我的视频呢」教训）
        if kb_markers and not re.search(r"【(?:图片|视频):[^】]+】", result.reply):
            result.reply = result.reply.rstrip() + "\n" + "\n".join(kb_markers)
            if result.parts:
                result.parts = [p.rstrip() for p in result.parts] + [kb_markers[-1]]
        # 二次命中：回复覆盖为自然短句（stage/slots 推进保留）。
        # 括号元语言绝不下发——2026-11-12 被模型复读给客户的教训
        if kb_repeat and kb_entry_id:
            if kb_markers:
                result.reply = "好的，这就再给你发一遍~\n" + "\n".join(kb_markers)
            else:
                result.reply = "这个问题刚才已经回复过你啦，有其他想了解的随时问我。"
            result.parts = [result.reply]
        # parts 一并落库：回放时能看出「那轮其实发了两条」
        records.append((store.EVENT_REPLY, {"text": result.reply, "parts": result.parts}))
        if kb_entry_id:
            # 记住这条 KB 已对本会话发过：同条目再命中就走短版+补媒体，不重发整段
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

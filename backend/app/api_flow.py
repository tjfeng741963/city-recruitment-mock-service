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
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .deps import ServiceOrUser, SessionDep
from .services import agent_session
from .services import flow_session as store
from .services import kb_faq, kb_placeholder, profile_push, unknown_questions
from .services import old_friend
from .services import flow_graph
from .services import device_scripts
from .services.device_scripts import (
    fetch_device_meta,
    fetch_position_scripts,
    fetch_scripts,
    pick_position_script,
    pick_script,
    render_script,
    render_welcome_parts,
)
from .services.flow_engine import (
    SCRIPT_STAGE_GREET,
    SCRIPT_STAGE_SEND_INFO,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    STAGE_SEND_INFO,
    FlowResult,
    absorb_profile,
    distinct_places,
    device_intro_followup,
    enter_info_result,
    extract_city,
    interview_window_of,
    jobs_for_city,
    pin_position,
    select_position_by_place,
    send_info_parts,
    set_position_scripts,
    set_remote_cities,
    set_remote_jobs,
    split_by_section_heads,
)
from .services.job_lookup import lookup_cities, lookup_jobs, vertical_hint_of
from .services.flow_llm import a_step, review_loop
from .services.llm_provider import begin_llm_trace, build_provider, collect_llm_trace
from .services.media_guard import filter_parts, markers_from_refs, markers_in

_warned_no_device = False


def _resolve_device_code(explicit: str) -> str:
    """本轮该用哪台设备：显式传入 > FLOW_PROFILE_DEVICE > 空（通配）。

    空态是「不知道是哪台」，此时按通配处理（不拿别台设备的城市/板块/话术去套），
    并只告警一次——每轮刷日志会把 run.log 冲爆。
    2026-11-14 之前这里兜底到硬编码的 pc-office-01（已停用的办公机），
    导致线上 pc-win-01 的整段对话都按那台机器的口径取数，实测串台。
    """
    global _warned_no_device
    code = (explicit or "").strip() or os.getenv(
        "FLOW_PROFILE_DEVICE", profile_push.DEFAULT_DEVICE
    ).strip()
    if not code and not _warned_no_device:
        _warned_no_device = True
        logging.getLogger(__name__).warning(
            "/flow/answer 与 /flow/greet 未收到 device_code，且未配置 "
            "FLOW_PROFILE_DEVICE：设备元信息与话术按通配处理，可能串用其他设备配置"
        )
    return code


router = APIRouter(prefix="/api/v1/flow", tags=["flow"])

# 这三步客户会插问（问体检 / 住宿 / 地点 / 工钱），别的阶段不查库，省一次查询。
# send_info 必须含在内：新好友首句就收到岗位卡（POST /flow/greet），
# 紧接着问的「多少钱」「包吃住吗」正落在 send_info 阶段——不含进来就查不到
# kb_answer，只能把岗位卡再发一遍（2026-11-14 模拟实测）。
_KB_STAGES = {STAGE_SEND_INFO, STAGE_ASK_INTERVIEW, STAGE_COLLECT, STAGE_DONE}


class FlowAnswerIn(BaseModel):
    session_key: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=2000)
    # 推档案给 4222 时用来定位会话；老客户端不传也能跑（走 external_conversation_id）
    device_code: str = Field(default="", max_length=64)
    # 客户端本地聊天记录（最近几轮双方对话，agent/autopilot.build_dialogue 的输出）。
    # 老客户端不传：为空时服务端仍用事件投影构建上下文（向后兼容）。
    history: list[dict[str, str]] = Field(default_factory=list, max_length=40)


class FlowAnswerOut(BaseModel):
    reply: str
    parts: list[str] = Field(default_factory=list)
    attachments: list[Any] = Field(default_factory=list)
    stage: str
    finished: bool
    action: str | None
    slots: dict[str, Any]
    profile: dict[str, Any] = Field(default_factory=dict)


class GreetIn(BaseModel):
    """新好友开场：本号招聘介绍优先，其次是岗位/通用首句及默认开场。"""

    session_key: str = Field(min_length=1, max_length=64)
    device_code: str = Field(default="", max_length=64)


class GreetOut(BaseModel):
    reply: str
    parts: list[str] = Field(default_factory=list)
    attachments: list[Any] = Field(default_factory=list)
    stage: str
    skipped: bool = False
    detail: str = ""


class FlowStateOut(BaseModel):
    session_key: str
    stage: str
    slots: dict[str, Any]
    profile: dict[str, Any] = Field(default_factory=dict)
    turns: int
    history: list[dict[str, str]]
    actions: list[dict[str, Any]]


async def _load_graph_for(session, device_code: str, meta: dict) -> dict:
    """读当前设备在本板块下的节点图。

    任何失败都回空图（`{"nodes": [], ...}`），让 flow_engine 走原有分支：
    没跑迁移、表不存在、设备没绑板块，都不该让客户收不到回复。
    """
    try:
        return await flow_graph.load_graph(
            session,
            device_code=str(device_code or ""),
            vertical_code=str((meta or {}).get("vertical_code") or ""),
        )
    except Exception:  # noqa: BLE001
        return {"nodes": [], "edges": [], "entry": None}


@router.post("/answer", response_model=FlowAnswerOut)
async def flow_answer(
    payload: FlowAnswerIn, session: SessionDep, _: ServiceOrUser
) -> FlowAnswerOut:
    # 模型调用留痕的起点：本轮所有 complete() 调用都会被记进这个收集器，
    # 落库时并进 reply 事件的 trace.llm。必须每请求重置，避免串到下一轮。
    begin_llm_trace()
    events = await store.load_events(session, payload.session_key)
    state = store.project(events)
    before = dict(state.get("slots") or {})
    before_profile = dict(state.get("profile") or {})
    stage_before = str(state.get("stage") or "")
    # done 重激活：流程结束后客户再来消息（问工资/换岗位…），AI 要继续服务
    # 而不是永远沉默——重置流程从问城市重新开始，老客户档案抽取照常
    slots = state.setdefault("slots", {})
    # 流失/不合适是终态，不是「聊完了」。
    # 原来只要 stage==done 就一律重激活到 ask_interview，导致客户明确说
    # 「我不去了」之后，下一条随便发个「在吗」又被问一次
    # 「这两天能不能过来面试？能来的话我把名额给你留着」——
    # 2026-11-14 三路模拟实测各 4 次，属骚扰级业务红线。
    abandoned = str(slots.get("recruit_status") or "").strip() in {
        "disqualified",
        "gave_up",
    }
    # 已约客户（booked）不重激活：否则他每发一句都被重新问「这两天能不能过来
    # 面试」，改期/问地点/补资料全被当成新的邀约（2026-11-15 实测）。
    # 这类客户保持 done，由 a_step 的 done 分支分流：改期 → 事实 → 知识库。
    flow_reset = stage_before == "done" and not abandoned and not slots.get("booked")
    if flow_reset:
        # 只重置阶段、保留 slots/profile——老客户的档案和城市不能丢。
        # 回到 ask_interview（老客户已看过岗位）：插问 KB 分支继续可用
        state["stage"] = "ask_interview"
        before["stage"] = "ask_interview"
        before_profile = dict(state.get("profile") or {})
        stage_before = "ask_interview"

    if abandoned and stage_before == "done":
        # 客户已明确放弃（流程已结束 + 标记流失/不合适）：不再推进、不再邀约。
        # 只回一句终止语并记一条入站事件，保留 slots 供人工在看板恢复。
        # 之前这里会重激活到 ask_interview，于是「在吗」这种随口一句
        # 又会收到「这两天能不能过来面试」，实测 4 次，属骚扰级红线。
        closing = "好的，那就不打扰你了。后面想了解哪个城市的岗位，随时跟我说哈。"
        await store.append_events(
            session,
            payload.session_key,
            [
                (store.EVENT_INBOUND, {"text": payload.text}),
                # 关闭语也是实际发出的内容：落 reply 事件，AgentSession 才能读到
                (
                    store.EVENT_REPLY,
                    {
                        "text": closing,
                        "parts": [closing],
                        # 灰度复盘：这条是「客户拒接后的收尾语」，不是普通回复。
                        # 单独标记出来，才统计得出「说了不去之后还追问」这种红线。
                        "trace": {
                            "source": "closing",
                            "stage_from": stage_before,
                            "stage_to": "done",
                            "action": None,
                            "kb_entry_id": "",
                            "recruit_status": str(slots.get("recruit_status") or ""),
                        },
                    },
                ),
            ],
        )
        # 这条路径在 build_provider 之前就返回，本轮不会有模型调用；
        # 仍显式清空收集器，避免残留串到下一个请求。
        collect_llm_trace()
        return FlowAnswerOut(
            reply=closing,
            parts=[closing],
            stage="done",
            finished=True,
            action=None,
            slots=dict(slots),
            profile=dict(state.get("profile") or {}),
        )

    device_code = _resolve_device_code(payload.device_code)

    # 知识库两段式：
    #   ① 新路径 kb_faq —— 按品类 + 招工方硬过滤，命中就用岗位事实渲染占位符。
    #      别家厂的问答根本不进候选集，这是「分不清厂」的直接解法。
    #   ② 旧路径 kb_placeholder —— 扫存量话术，城市 +3 / 同厂 +5 打分。
    # 新路径没命中才回落旧路径，保证已有 534 条数据继续可用。
    kb_answer: str | None = None
    kb_entry_id: str | None = None
    kb_markers: list[str] = []
    kb_repeat = False
    # 设备元信息（60s 缓存，拉不到回空 = 通配/不限，流程不中断）：
    #   factory_name/city/vertical_id/employer_id/location_id/position_id
    #       → 知识库 v3 硬过滤（kb_faq）+ 旧路径 kb_placeholder 加权
    #   job_scope → 设备级岗位口径（subway 只推地铁/安检，all 不过滤，空串跟随默认）
    # 提到外层统一拉一次：知识库阶段和岗位查询都要用。
    try:
        meta = await fetch_device_meta(device_code)
    except Exception:  # noqa: BLE001  meta 拉不到按通配，流程不中断
        meta = dict(device_scripts.EMPTY_META)
    # 岗位级硬编码话术（与 meta 同一份 config 缓存，不额外打网络）：
    # 注入引擎后，send_info / ask_interview / booked 命中即整段直发，不调模型。
    position_scripts: list[dict[str, Any]] = []
    try:
        position_scripts = await fetch_position_scripts(device_code)
    except Exception:  # noqa: BLE001  话术拉不到就走知识库/模型，不影响回复
        position_scripts = []
    set_position_scripts(position_scripts)

    # 先加载本轮岗位再查 FAQ，不能用 ContextVar 中旧请求的岗位填答案。
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
            # 口径优先级：设备绑定 > 客户这轮说的品类 > 环境变量默认。
            # 地铁号的设备配置说 subway，就不该被客户随口一句「工厂」带偏。
            # device_code 一并透传：4222 按设备绑定的工厂过滤岗位。
            remote_jobs = await lookup_jobs(
                city_hint,
                vertical_hint=vertical_hint_of(payload.text),
                device_scope=str(meta.get("job_scope") or ""),
                device_code=device_code,
            )
        except Exception:  # noqa: BLE001
            remote_jobs = []
        set_remote_jobs({city_hint: remote_jobs})
        # 旧 greet 只存了岗位编号，漏存事实快照。按当前设备可见岗位的精确 id
        # 补齐，不能用 job_index/首岗猜；已有快照或本轮换城时均保持原状态。
        if (
            city_hint == str(slots.get("city") or "")
            and slots.get("interview_offer_sent")
            and slots.get("position_id")
            and not slots.get("job_snapshot")
        ):
            pinned_job = next(
                (job for job in remote_jobs
                 if str(job.get("position_id") or "") == str(slots["position_id"])),
                None,
            )
            if pinned_job:
                pin_position(slots, pinned_job)
    else:
        set_remote_jobs({})

    # 知识库命中结果在 _KB_STAGES 分支内才产生；外层写 trace 时要读它，
    # 所以必须先在这里占位，否则非 KB 阶段一走就是 UnboundLocalError。
    faq_hit: Any | None = None

    if stage_before == STAGE_ASK_CITY and slots.get("device_intro_sent"):
        # Only an explicit customer base selection pins a multi-base introduction.
        if select_position_by_place(slots, payload.text):
            slots["interview_offer_sent"] = True

    if stage_before in _KB_STAGES or (stage_before == STAGE_ASK_CITY and slots.get("device_intro_sent")):
        city_hint_for_kb = (
            str(slots.get("city") or "")
            or extract_city(payload.text)
            or str(meta.get("city") or "")
        )
        # 已选岗位优先于设备默认值；缺 id 代表未知，不能借设备旧雇主填空。
        selected = "position_id" in slots or "job_snapshot" in slots
        identity = slots if selected else meta
        position_id_hint = int(identity.get("position_id") or 0) or None
        jobs_for_kb = jobs_for_city(city_hint_for_kb) or []
        snapshot = slots.get("job_snapshot")
        snapshot = snapshot if isinstance(snapshot, dict) else {}
        if position_id_hint:
            job_for_faq = next(
                (job for job in jobs_for_kb if int(job.get("position_id") or 0) == position_id_hint),
                snapshot if selected else {},
            )
        elif selected:
            job_for_faq = snapshot
        else:
            # 多岗位且没有明确选择时不拿首岗当客户已选岗位。
            job_for_faq = jobs_for_kb[0] if len(jobs_for_kb) == 1 else {}
        employer_id_hint = int(
            job_for_faq.get("employer_id", identity.get("employer_id")) or 0
        ) or None
        location_id_hint = int(
            job_for_faq.get("location_id", identity.get("location_id")) or 0
        ) or None
        factory_hint = str(
            job_for_faq.get("factory_name")
            or ("" if selected else meta.get("factory_name")) or ""
        )

        # ① 新路径：kb_faq 硬过滤（position → employer → city → global）
        # 已选岗位提供品类时用该岗位，否则沿用设备品类，不能写死 factory。
        try:
            faq_hit = await kb_faq.lookup(
                session,
                payload.text,
                vertical_code=str(
                    job_for_faq.get("vertical_code") or meta.get("vertical_code") or "factory"
                ),
                employer_id=employer_id_hint,
                location_id=location_id_hint,
                position_id=position_id_hint,
            )
        except Exception:  # noqa: BLE001  查库失败等同于没命中，不能挡住回复
            faq_hit = None
        if faq_hit:
            # 占位符用岗位事实渲染：工价/年龄/吃住都来自运营维护的岗位字段，
            # 模板里一个数字都没有，所以换工价不用改话术。
            # 岗位身份来自 Node，不能拿裸数字编号去另一份库查地址/厂名。
            # 没有已确认岗位事实时保持空值，让缺字段规则走正常兜底。
            location_ctx, employer_name = {}, factory_hint
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
                    factory=factory_hint,
                    require_factory=True,
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

    # 这一轮要发的那张卡是哪个岗：岗位 id 从岗位项本身取（不从 job_index 推算）
    card_job: dict[str, Any] = (jobs_for_city(city_hint) or [{}])[0] if city_hint else {}
    position_script = (
        pick_position_script(
            position_scripts, int(card_job.get("position_id") or 0), SCRIPT_STAGE_SEND_INFO
        )
        if will_send_info and card_job
        else None
    )

    # 每客户一个标准智能体上下文（AgentSession）：从事件日志投影最近轮次
    # （客户/我方逐轮累积，含话术与卡片），传给 A（决策 Prompt）与 B（审核查重）
    # 客户端带了聊天记录就以它为准（服务端投影缺人工/补发轮次，见
    # agent_session.merge_client_history）；老客户端不带 → 仍用事件投影。
    transcript = agent_session.merge_client_history(
        agent_session.build_transcript(events), payload.history
    )
    provider = build_provider()
    media_material = kb_answer or ""
    device_material_used = False

    intro_result = device_intro_followup(state, payload.text, kb_answer)
    if intro_result is not None:
        result = intro_result
    elif position_script and str(position_script.get("content") or "").strip():
        # 岗位话术命中：整段按运营台词直发（占位符由代码替换、媒体标记原样保留），
        # 这轮一次模型都不调——工价/年龄/地点一个字都不许被改写。
        # 状态推进仍走确定性规则：发过卡 + 进 ask_interview。
        # 媒体白名单必须取自这段话术本身：以前这里不设 media_material，
        # allowed_media 只剩空列表，review_loop/filter_parts 把运营配的
        # 【图片:x】【视频:x】当作未授权标记全部删掉——文本发出去、图一张没有
        # （2026-11-15 线上实测「发图片、视频没出来」）。
        media_material = str(position_script.get("content") or "")
        slots["city"] = city_hint
        slots.setdefault("job_index", 0)
        absorb_profile(slots, payload.text)
        result = enter_info_result(slots)
    elif script and will_send_info and str(script.get("content") or "").strip():
        # 设备级城市话术：仍作为素材交给模型组织（工价护栏保护数字）；
        # 单轮单源：素材只给话术本身，不再拼接 kb_answer——KB 是另一个来源，
        # 命中就该单独答（2026-11-14 话术一次性语义）。
        slots["city"] = city_hint
        slots.setdefault("job_index", 0)
        absorb_profile(slots, payload.text)
        job = card_job
        script_material = render_script(str(script.get("content") or ""), job)
        media_material = script_material
        device_material_used = True
        result = await a_step(
            state, payload.text, provider, kb_answer=script_material,
            graph=await _load_graph_for(session, device_code, meta),
            transcript=transcript,
        )
        # 语义保持：这轮按「已发岗位+邀约」推进，下一站 ask_interview
        result.stage = STAGE_ASK_INTERVIEW
        result.slots["interview_offer_sent"] = True
    else:
        # ③ 主路径交给模型；没配模型或调用失败时，a_step 内部退到确定性状态机
        result = await a_step(
            state, payload.text, provider, kb_answer=kb_answer,
            graph=await _load_graph_for(session, device_code, meta),
            transcript=transcript,
        )
    # B 审核循环：逐条把关要发的内容。打回 → A 重写一次 → 再审；
    # 2 轮后仍打回 → 兜底强制发送（事实卡直答 → 确定性提问 → 确认一下）。
    # B 不可用仍执行媒体白名单校验；模型审核是增强，不阻塞正常回复。
    # 只从当前素材和已选岗位构造白名单，不能从模型草稿、客户原话或历史消息取。
    # 知识库「查到过什么」与「最后用了没有」是两件事，必须分开记。
    # 下面 488 行会把未采用的命中重置掉（避免把命中但没用的素材补到运营回复后），
    # 如果不在这里留一份快照，灰度复盘就分不清「库里没有」和「有但没采用」。
    kb_hit_snapshot = {
        "id": f"faq:{faq_hit.id}" if faq_hit else "",
        "tier": str(getattr(faq_hit, "tier", "") or ""),
        "candidates": list(getattr(faq_hit, "candidates", []) or []),
    }

    if device_material_used or result.source in {"script", "card", "fact", "collect"} or result.action:
        # 本轮没使用 KB，不能把命中但未采用的另一份素材补到运营回复后。
        kb_markers, kb_entry_id, kb_repeat = [], None, False
        if not device_material_used:
            media_material = result.reply
    kb_markers = list(dict.fromkeys(marker for item in kb_markers for marker in markers_in(item)))
    allowed_media = markers_in(media_material) + kb_markers
    selected_slots = result.slots
    current_jobs = jobs_for_city(str(selected_slots.get("city") or ""))
    pinned = selected_slots.get("position_id")
    if pinned:
        selected_job = next((job for job in current_jobs if str(job.get("position_id")) == str(pinned)), {})
    else:
        index = int(selected_slots.get("job_index") or 0)
        selected_job = current_jobs[index] if 0 <= index < len(current_jobs) else {}
    allowed_media.extend(markers_from_refs(selected_job.get("media")))
    result = await review_loop(state, payload.text, provider, result, transcript, allowed_media=allowed_media)
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
        #
        # 判据是「整条回复就是客户原话」，不是「回复里包含客户原话」。
        # 后者会误杀正常业务回复：约面试成功的确认语本来就会引用客户的姓名手机
        # （「登记好了：张三 13800138000，明天…」），包含即拦截会让客户约上了
        # 却收不到确认（2026-11-14 模拟实测）。去标点后比较，才只拦真复读。
        inbound_text = (payload.text or "").strip()
        incoming_key = re.sub(r"[\s\W_]+", "", inbound_text)
        reply_key = re.sub(r"[\s\W_]+", "", result.reply)
        echo_guarded = False
        if (
            len(inbound_text) >= 6
            and incoming_key
            and reply_key == incoming_key
            and not kb_repeat
        ):
            fallback = (kb_answer or "").strip() or "我在的，你想了解哪方面？工作内容、工资待遇还是面试时间？"
            result.reply = fallback
            result.parts = [fallback]
            # 灰度复盘要能看出「模型这次复读了，被兜底换掉」——否则会把兜底话术
            # 误当成模型的正常输出。
            echo_guarded = True
        # 媒体兜底：命中的条目带【图片/视频:名称】而模型回复里弄丢了 → 补回，
        # 保证客户真的能收到视频/图片（2026-11-12「我的视频呢」教训）
        existing_markers = markers_in(result.reply)
        missing_markers = [marker for marker in kb_markers if marker not in existing_markers]
        if missing_markers:
            result.parts = (result.parts or [result.reply]) + missing_markers
            result.reply = "\n".join(result.parts)
        # 二次命中：回复覆盖为自然短句（stage/slots 推进保留）。
        # 括号元语言绝不下发——2026-11-12 被模型复读给客户的教训
        if kb_repeat and kb_entry_id:
            if kb_markers:
                result.reply = "好的，这就再给你发一遍~\n" + "\n".join(kb_markers)
            else:
                result.reply = "这个问题刚才已经回复过你啦，有其他想了解的随时问我。"
            result.parts = [result.reply]
        # 回声兜底、KB 补媒体/重复答复都发生在审核之后，落库前再统一校验。
        result.parts = filter_parts(result.parts or [result.reply], allowed_media) or ["这个我确认一下，稍后回你"]
        # 分段收口：模型组织的回复常把运营素材里的【用人要求】【上班时间】
        # 【工资待遇】塞进同一条，客户看到的是一条糊在一起的长消息
        # （2026-11-15 线上实测）。只按行首【标题】拆、不按空行拆——
        # 模型自己的正文也用空行分段，按空行切会把正常回复拆碎。
        # 标题不足 2 个时原样返回，不做任何改动。
        if len(result.parts) == 1:
            result.parts = split_by_section_heads(result.parts[0])
        result.reply = "\n".join(result.parts)
        # 灰度复盘用的诊断：这条回复是谁生成的、走了哪一步、命中了哪条知识库、
        # 审核动过没有、兜底触发过没有。追加字段不影响回放——project() 只读 text。
        trace = dict(result.trace or {})
        trace.update(
            {
                "device_code": device_code,                   # 哪台机器/哪个企微号说的
                "source": result.source,                      # script/card/fact/collect/kb/""
                "stage_from": stage_before,
                "stage_to": result.stage,
                "action": result.action,
                "kb_entry_id": kb_entry_id or "",
                # 「查到过什么」与「最后用了没有」分开记：
                # kb_used=False 表示命中了知识库但本轮回复来自岗位事实/话术，
                # 这不是故障，但复盘时必须能区分「库里没有」和「有但没采用」。
                "kb_used": bool(kb_entry_id),
                "kb_hit_id": kb_hit_snapshot["id"],
                "kb_tier": kb_hit_snapshot["tier"],
                "kb_candidates": kb_hit_snapshot["candidates"],
                "kb_repeat": kb_repeat,
                "kb_markers": list(kb_markers),
                "kb_answer_len": len(kb_answer or ""),
                "city": str(result.slots.get("city") or ""),
                "position_id": result.slots.get("position_id") or "",
                "booked": bool(result.slots.get("booked")),
                "recruit_status": str(result.slots.get("recruit_status") or ""),
                "echo_guarded": echo_guarded,
                "kb_natural_rewrite": bool(kb_repeat and kb_entry_id),
                "media_appended": len(missing_markers),
                # 模型调用明细：A 生成、B 审核、知识库改写三处的每次调用都在这里。
                # 空数组 = 这一轮一次模型都没调（走的是代码渲染或确定性兜底），
                # 这本身就是关键信息：能立刻分清「模型答错了」和「根本没调模型」。
                "llm": collect_llm_trace(),
            }
        )
        # parts 一并落库：回放时能看出「那轮其实发了两条」
        records.append((store.EVENT_REPLY, {"text": result.reply, "parts": result.parts, "trace": trace}))
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
    # 老客户识别只认客户自述（「我之前来过」「上次面试」），命中就随档案推给 4222，
    # 那边落 old_friend_records(status='unreleased')，入站拦截随即生效。
    out_profile.update(old_friend.old_friend_fields(payload.text))
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


@router.post("/greet", response_model=GreetOut)
async def flow_greet(
    payload: GreetIn, session: SessionDep, _: ServiceOrUser
) -> GreetOut:
    """新好友开场：本号招聘介绍 → 岗位首句 → 通用欢迎语 → 默认开场。

    固定欢迎语按独占一行的 --- 分条，不需要客户先发问题，也不调用模型。
    没有可用话术且岗位前提不足时返回 skipped=True，由客户端沿用原兜底。
    """
    device_code = _resolve_device_code(payload.device_code)
    try:
        meta = await fetch_device_meta(device_code)
    except Exception:  # noqa: BLE001  meta 拉不到就当没绑，不发卡
        meta = dict(device_scripts.EMPTY_META)

    vertical_code = str(meta.get("vertical_code") or "").strip()
    city = str(meta.get("city") or "").strip()
    factory_name = str(meta.get("factory_name") or "").strip()
    vertical_id = int(meta.get("vertical_id") or 0)

    # 通用欢迎语不依赖岗位或客户先发消息；仍由原客户端发送链路投递。
    try:
        position_scripts = await fetch_position_scripts(device_code)
    except Exception:  # noqa: BLE001
        position_scripts = []
    set_position_scripts(position_scripts)
    existing_slots = dict((store.project(await store.load_events(session, payload.session_key)).get("slots") or {}))
    sent_value = existing_slots.get("scripted_sent")
    scripted_sent = dict(sent_value) if isinstance(sent_value, dict) else {}

    try:
        intro = pick_script(await fetch_scripts(device_code), "greet", city)
    except Exception:  # noqa: BLE001
        intro = None

    async def device_welcome(jobs: list[dict[str, Any]]) -> GreetOut | None:
        if not intro or scripted_sent.get("greet"):
            return None
        # Keep only facts shared by all bases of the same factory. Different wages,
        # addresses and requirements must not silently come from jobs[0].
        common: dict[str, Any] = {}
        if jobs and len({str(j.get("factory_name") or "") for j in jobs}) == 1:
            common = {key: value for key, value in jobs[0].items()
                      if isinstance(value, (str, int, float)) and not isinstance(value, bool)
                      and all(j.get(key) == value for j in jobs)}
        parts = render_welcome_parts(str(intro.get("content") or ""), common, str(common.get("interview_time") or ""))
        if not parts:
            return None
        slots = {**existing_slots, "city": city, "vertical_id": vertical_id,
                 "device_intro_sent": True, "scripted_sent": {**scripted_sent, "greet": True}}
        pin_position(slots, common)
        selected = len(jobs) == 1 and bool(slots.get("position_id"))
        slots["interview_offer_sent"] = selected
        stage = STAGE_SEND_INFO if selected else STAGE_ASK_CITY
        await store.append_events(session, payload.session_key, [
            (store.EVENT_STAGE, {"to": stage}),
            *store.diff_slots(existing_slots, slots),
            (store.EVENT_REPLY, {"text": "\n".join(parts), "parts": parts, "source": "device_intro"}),
        ])
        return GreetOut(reply="\n".join(parts), parts=parts, stage=stage,
                        skipped=False, detail="本企微号的固定招聘介绍")

    async def configured_welcome(job: dict[str, Any]) -> GreetOut | None:
        if scripted_sent.get("greet"):
            return None
        script = pick_position_script(position_scripts, int(job.get("position_id") or job.get("id") or 0), SCRIPT_STAGE_GREET)
        if not script:
            return None
        parts = render_welcome_parts(str(script.get("content") or ""), job, interview_window_of(job))
        if not parts:
            return None
        scripted_sent["greet"] = True
        await store.append_events(session, payload.session_key, [
            (store.EVENT_STAGE, {"to": STAGE_ASK_CITY}),
            (store.EVENT_SLOT, {"key": "scripted_sent", "value": scripted_sent}),
            (store.EVENT_REPLY, {"text": "\n".join(parts), "parts": parts, "source": "script"}),
        ])
        return GreetOut(reply="\n".join(parts), parts=parts, stage=STAGE_ASK_CITY,
                        skipped=False, detail="后台配置的加好友首句")

    # 没绑板块：不知道该发哪套卡。不做「按城市兜底」——那等于自己猜品类，
    # 而业务上不存在综合号（一个微信号只做一个板块）。交回上层发问句。
    if not vertical_code:
        welcome = await device_welcome([]) or await configured_welcome({})
        if welcome:
            return welcome
        return GreetOut(
            reply="",
            stage=STAGE_ASK_CITY,
            skipped=True,
            detail="设备未绑定板块",
        )

    # 地铁号没绑城市：先问城市（这一步沿用现有话术，不问方向）
    if vertical_code == "subway" and not city:
        welcome = await device_welcome([]) or await configured_welcome({})
        if welcome:
            return welcome
        return GreetOut(
            reply="",
            stage=STAGE_ASK_CITY,
            skipped=True,
            detail="地铁号未绑定城市，先问城市",
        )

    # 拉该板块的岗位：有城市按城市查，没绑城市就把整个板块的在招岗位拉回来
    # device_code 透传：4222 只回该设备绑定工厂的岗位。
    try:
        jobs = await lookup_jobs(
            city,
            device_scope="subway" if vertical_code == "subway" else "all",
            device_code=device_code,
        )
    except Exception:  # noqa: BLE001
        jobs = []
    # 设备绑了具体工厂就只留这家；没绑就用板块全量
    if factory_name:
        scoped = [j for j in jobs if str(j.get("factory_name") or "") == factory_name]
        if scoped:
            jobs = scoped

    if not jobs:
        welcome = await device_welcome([]) or await configured_welcome({})
        if welcome:
            return welcome
        # 板块没岗位数据时不瞎编，交回上层走「帮你问问」
        return GreetOut(
            reply="",
            stage=STAGE_ASK_CITY,
            skipped=True,
            detail=f"板块 {vertical_code or '(未绑定)'} 没有在招岗位",
        )

    welcome = await device_welcome(jobs)
    if welcome:
        return welcome

    set_remote_jobs({city: jobs})

    slots: dict[str, Any] = {
        **existing_slots,
        "city": city,
        "job_index": 0,
        "vertical_id": vertical_id,
        "scripted_sent": scripted_sent,
    }
    # 发卡这一刻钉岗位 id：能取到卡片岗位的 id 就用它，取不到才退到设备绑定的岗位
    card_job = jobs[0]
    slots["position_id"] = (
        pin_position(slots, card_job) or int(meta.get("position_id") or 0)
    )

    welcome = await configured_welcome(card_job)
    if welcome:
        return welcome

    # 没配首句话术：一个工厂多个面试基地时先问去哪个基地，不直接甩卡。
    # 2026-11-15 实测：地铁号（陈村/竹料两个基地）加好友第一句就收到 jobs[0]
    # 的卡，客户问「包吃住吗」收到的却是另一基地的面试地点。业务口径是
    # 加好友 → 问地点 → 拿到地点再发该基地的岗位；只有一个基地时问地点是废话，
    # 仍保持老行为直接发卡，工厂号不受影响。
    places = distinct_places(slots)
    if len(places) >= 2:
        factory = str(card_job.get("factory_name") or card_job.get("job_title") or "").strip()
        lead = f"在招{factory}" if factory else "有岗在招"
        ask = (
            f"你好，我们这边{lead}，面试基地有：{'、'.join(places)}。"
            "你在哪个基地方便？确定后我把岗位详情和面试时间发你。"
        )
        # 只落 stage + 岗位身份/快照 + 回复，不置 interview_offer_sent：
        # 下一轮拿到基地才发卡。快照仍然要存——客户在答基地之前问「工资多少」
        # 也得能按岗位事实答，不能因为没有卡就掉回模型编造。
        await store.append_events(
            session,
            payload.session_key,
            [
                (store.EVENT_STAGE, {"to": STAGE_ASK_CITY}),
                *store.diff_slots(existing_slots, slots),
                (store.EVENT_REPLY, {"text": ask}),
            ],
        )
        return GreetOut(
            reply=ask,
            parts=[ask],
            stage=STAGE_ASK_CITY,
            skipped=False,
            detail=f"无 greet 话术 · 多基地先问地点（{len(places)} 个）",
        )

    # 没配首句话术且只有一个基地：保持老行为（直接发岗位卡），工价/年龄/地点全部来自岗位数据
    parts = send_info_parts(slots)
    slots["interview_offer_sent"] = True

    records: list[tuple[str, dict[str, Any]]] = [
        (store.EVENT_STAGE, {"to": STAGE_SEND_INFO}),
        # 发卡过程会钉岗位身份、事实快照和话术记账；整套保存，后续 answer
        # 从事件回放才能拿到同一岗位的工资，不能只手工挑部分字段落库。
        *store.diff_slots(existing_slots, slots),
    ]
    if parts:
        records.append((store.EVENT_REPLY, {"text": "\n".join(parts)}))
    await store.append_events(session, payload.session_key, records)

    return GreetOut(
        reply="\n".join(parts),
        parts=parts,
        stage=STAGE_SEND_INFO,
        skipped=False,
        detail=f"{vertical_code} · {city or '不限城市'} · {len(jobs)} 个岗位",
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

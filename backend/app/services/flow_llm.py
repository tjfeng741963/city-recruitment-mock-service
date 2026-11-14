"""LLM 驱动的招聘对话（harness 风格，v2 流程）。

与 flow_engine 的分工：
- flow_engine 是**确定性兜底**：模型挂了也保证客户收到一句像样的话
- 本模块是**主路径**：模型自己读懂客户、自己说人话
- 但工作信息（厂名/工价/班次/年龄/吃住）永远由代码从 4222 岗位数据拼，
  模型碰不到——它只要说了数据里没有的工价，整句就作废退回兜底

对应 DeepSeek Harness 的几个关键取舍：
1. 会话日志只追加（在 flow_session 里），本模块只读投影 + 追加，不覆盖
2. turn / step：一次客户消息 = 一个 turn；模型调用失败在同一个 step 内重试，
   不重复消费客户输入、不重复发消息
3. surface 投影：给模型的是"最近几轮 + 当前已知信息"，不是全部历史
4. 副作用与文字分离：模型只提议 action，真正落库/算时间由代码做
"""

from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from typing import Any

from .flow_engine import (
    ACTION_BOOK,
    ACTION_GAVE_UP,
    ACTION_HANDOFF,
    INTERVIEW_WINDOW,
    PROFILE_KEYS,
    SCRIPT_STAGE_ASK_INTERVIEW,
    SCRIPT_STAGE_BOOKED,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    STAGE_KB,
    STAGE_SEND_INFO,
    FlowResult,
    _agree_interview,
    _absorb,
    _book,
    _day_offset_of,
    _gave_up_text,
    _is_bare_greeting,
    _script_sent,
    _stage_script,
    extract_day_offset,
    enter_info_result,
    interview_window_of,
    is_agree,
    is_disagree,
    jobs_for_city,
    looks_like_question,
    next_interview,
    remote_job_cities,
    step as fallback_step,
)
from .llm_provider import ChatMessage, LLMProvider

ALLOWED_STAGES = {
    STAGE_ASK_CITY,
    STAGE_SEND_INFO,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_KB,
    STAGE_DONE,
}

# 阶段推进顺序：clamp 时按这个比较「模型想跳多远」
_STAGE_ORDER = {
    STAGE_ASK_CITY: 0,
    STAGE_SEND_INFO: 1,
    STAGE_ASK_INTERVIEW: 2,
    STAGE_COLLECT: 3,
    STAGE_DONE: 4,
}

SYSTEM_PROMPT = """你是一家劳务中介的招聘顾问，叫「陈姐」，在广东做工厂招工十几年。

# 你的目标
把每一个来咨询的人，聊到「约好面试」为止。顺序是：
1. 问客户投递的是哪个城市
2. 按城市发工作信息（厂名、工价、班次、年龄、吃住，系统会自己发，你不用重复）
3. 问「这两天能不能过来面试」
4. 客户答应 → 一次要**姓名 + 手机号**两个
5. 信息齐了 → 收尾，然后不再回复

# 说话方式（很重要）
- 像微信上聊天的真人：短句、口语、可以用「哈」「嗯」「好嘞」
- 一次只说一件事，别把几个问题堆一起
- 客户问什么就先答什么，答完再自然接回你该问的
- 不要复读上一句，不要每句都「您好」「请问」

# 硬性规则
- **不许编数字**。工价、年龄、吃住只能照下面岗位数据说，一个字都不能改
- **不许编自己在做什么**。绝不说「我在打印面试表」「我叫了主管去门口接你」
  「我给你登记工号」「我帮你留着名额」这类你并没有真的做的事——
  你只是在微信上打字，没有线下动作。客户问到具体流程，就答「面试当天到了联系我」
- 不许编电话号码、联系人、工牌、宿舍号、班车时间；这些数据里没有就说有就说不清楚
- 不知道就说「我确认一下，稍后回你」，不要猜体检报销、住宿条件这类细节
- 客户拒绝面试：客气一句就结束（action="gave_up"），别再追
- 已经约好之后又发消息：不再回复
- **不要重复上一句**。客户没接话就换个说法问，同一句话不许连发两次

# 进度纪律
- 顺序是 城市 → 发信息 → 问面试 → 收姓名手机号，缺一个都不能往下走
- 只问这三样：城市、姓名、手机号
- collect 阶段必须**一次问两个**（姓名和手机号一起要），不要分成两轮
- 客户答得含糊（比如问城市他回「没有」），把该问的重问一次，不要当他在回答别的问题

# 岗位数据（只能从这里取）
{jobs}

# 面试时间
默认次日 {window}，地点就是岗位地址。客户明确说别的时间，以客户为准。

# 现在时间
{now}

# 输出格式（必须是 JSON，不要代码块，不要多余文字）
{{"reply": "发给客户的话", "stage": "ask_city|send_info|ask_interview|collect|done",
  "slots": {{"city": "", "job_index": 0}},
  "profile": {{"name": "", "phone": "", "province": "", "city": "", "district": "", "age": null, "notes": ""}},
  "action": null,
  "finished": false}}

profile 是档案，客户说到才填，没说到就留空：
- name 真实姓名、phone 手机号、province 省（如「广东省」）、district 区县（如「白云区」）
- phone 照客户原话抄，**不要改格式**（不要加空格、横线，也不要补 0）
- 客户随口说的、跟他本人无关的（比如「我朋友在东莞」）不算他的档案

action 只能是 null / "book_interview" / "gave_up"：
- 姓名和手机号都拿到了 → action="book_interview"，finished=true，reply 是欢迎语
- 客户说这两天来不了 / 不去了 → action="gave_up"，finished=true
- 其他情况一律 null
"""


def _jobs_brief() -> str:
    lines: list[str] = []
    for city in sorted(remote_job_cities()):
        for index, job in enumerate(jobs_for_city(city)):
            lines.append(
                f"- [{city}#{index}] {job.get('job_title', '')}｜{job.get('place', '')}"
                f"｜{job.get('wage_text', '')}｜{job.get('hours_text', '')}"
                f"｜{job.get('age_text', '')}｜{job.get('welfare_text', '')}"
            )
    return "\n".join(lines)


def build_messages(
    state: dict[str, Any], text: str, now: datetime | None = None
) -> list[ChatMessage]:
    """surface 投影：只给最近几轮对话 + 已收集信息，不给全量历史。"""
    when = now or datetime.now().astimezone()
    system = SYSTEM_PROMPT.format(
        jobs=_jobs_brief(),
        window=INTERVIEW_WINDOW,
        now=when.strftime("%Y-%m-%d %H:%M"),
    )
    slots = {k: v for k, v in (state.get("slots") or {}).items() if v}
    recent = (state.get("history") or [])[-8:]

    transcript = "\n".join(
        f"{'客户' if item['role'] == 'customer' else '你'}：{item['text']}"
        for item in recent
    )
    context = (
        f"当前阶段：{state.get('stage')}\n"
        f"已知信息：{json.dumps(slots, ensure_ascii=False)}\n"
        f"最近对话：\n{transcript or '（还没有）'}\n\n"
        f"客户刚说：{text}"
    )
    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=context),
    ]


def _parse_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型没返回 JSON")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("模型返回的不是对象")
    return data


_WANTS_MORE = re.compile(r"别的|其他|其它|换一|换家|还有|多几个|几个厂|哪些厂")


def _list_other_jobs(state: dict[str, Any], now: datetime | None = None) -> FlowResult:
    """客户要换岗位：代码列出该城市其他岗位（排除已发过的），不调模型。"""
    slots: dict[str, Any] = state.setdefault("slots", {})
    stage = str(state.get("stage") or STAGE_ASK_INTERVIEW)
    city = str(slots.get("city") or "")
    current = int(slots.get("job_index") or 0)
    jobs = [j for i, j in enumerate(jobs_for_city(city)) if i != current]
    if not jobs:
        return FlowResult(
            reply=f"{city}这边暂时就这一个岗位在招，有了新岗位我第一时间告诉你。",
            stage=stage,
            slots=slots,
        )
    lines = []
    for job in jobs:
        title = str(job.get("job_title") or "")
        factory = str(job.get("factory_name") or "")
        kind = title[len(factory):].strip() if factory and title.startswith(factory) else title
        lines.append(
            f"{factory}（{kind}）：{job.get('wage_text', '')}，"
            f"{job.get('hours_text', '')}，{job.get('age_text', '')}，{job.get('welfare_text', '')}，"
            f"地点{job.get('place', '')}"
        )
    body = "这边还有这几个：\n" + "\n".join(f"{i}. {line}" for i, line in enumerate(lines, start=1))
    parts = [body, "想看哪个跟我说，或者说下你的要求我帮你挑。"]
    slots["interview_offer_sent"] = True
    return FlowResult(reply="\n".join(parts), parts=parts, stage=stage, slots=slots)


def _job_of(slots: dict[str, Any]) -> dict[str, str]:
    jobs = jobs_for_city(str(slots.get("city") or ""))
    if not jobs:
        return {}
    index = int(slots.get("job_index") or 0)
    return jobs[min(max(index, 0), len(jobs) - 1)]


def _money_guard(reply: str, slots: dict[str, Any]) -> bool:
    """回复里出现的「N 元」必须能在岗位数据里找到，防止模型编工价。"""
    allowed = " ".join(
        f"{job.get('wage_text', '')} {job.get('welfare_text', '')}"
        for job in jobs_for_city(str(slots.get("city") or ""))
    )
    for number in re.findall(r"\d+(?:\.\d+)?\s*元", reply):
        if number.replace(" ", "") not in allowed.replace(" ", ""):
            return False
    return True


def _clean_slots(raw: Any) -> dict[str, Any]:
    slots: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return slots
    # 城市归一在 4222 侧做，这里只做基本清洗；查不到岗位时引擎走「帮你问问」
    city = str(raw.get("city") or "").strip()[:20]
    if city:
        slots["city"] = city
    index = raw.get("job_index")
    if isinstance(index, int) and index >= 0:
        slots["job_index"] = index
    return slots


def _clean_profile(raw: Any) -> dict[str, Any]:
    """档案字段：只透传，不做格式校验（电话不许改格式）。空值跳过，免得覆盖已有值。"""
    profile: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return profile
    for key in PROFILE_KEYS:
        value = raw.get(key)
        if key == "age":
            if isinstance(value, int) and 16 <= value <= 70:
                profile["age"] = value
            continue
        text = str(value or "").strip()
        if text:
            profile[key] = text
    return profile


def _max_stage(slots: dict[str, Any]) -> str:
    """缺什么就停在哪一步。模型不能跳过没拿到的槽位。"""
    if not slots.get("city"):
        return STAGE_ASK_CITY
    if not slots.get("interview_offer_sent"):
        return STAGE_SEND_INFO
    if not slots.get("interview_agreed"):
        return STAGE_ASK_INTERVIEW
    if not (slots.get("name") and slots.get("phone")):
        return STAGE_COLLECT
    return STAGE_DONE


_QUESTION = {
    STAGE_ASK_CITY: "你投递的是哪个城市的简历呀？",
    STAGE_ASK_INTERVIEW: "这两天能不能过来面试？",
    STAGE_COLLECT: "麻烦把姓名和手机号一起发我。",
}

_ASKED_HINTS = {
    STAGE_ASK_CITY: ("城市", "哪个市", "哪里"),
    STAGE_ASK_INTERVIEW: ("面试", "这两天", "过来"),
    STAGE_COLLECT: ("姓名", "手机", "电话"),
}


def _split_parts(reply: str) -> list[str]:
    """模型返回的空行分段 → parts。老客户端只看 reply，新客户端逐条发。"""
    parts = [chunk.strip() for chunk in re.split(r"\n{2,}", reply or "") if chunk.strip()]
    return parts or ([reply.strip()] if reply.strip() else [])


def apply_result(
    state: dict[str, Any],
    data: dict[str, Any],
    text: str = "",
    now: datetime | None = None,
) -> FlowResult:
    """把模型输出落成状态。副作用（时间、地点、多段文本）由代码算，不信任模型。"""
    slots: dict[str, Any] = state.setdefault("slots", {})
    slots.update(_clean_slots(data.get("slots")))
    # 档案沿用同一份槽位，只是来源不同（模型单独给的 profile 对象）
    slots.update(_clean_profile(data.get("profile")))
    # 客户说了「后天」就按他的来；模型给的时间不作数
    day_offset = extract_day_offset(text)
    if day_offset is not None:
        slots["interview_day_offset"] = day_offset
    when = next_interview(now, _day_offset_of(slots))

    stage = str(data.get("stage") or state.get("stage") or STAGE_ASK_CITY)
    if stage not in ALLOWED_STAGES:
        stage = str(state.get("stage") or STAGE_ASK_CITY)

    # kb 只是插问标签，不落成终态
    if stage == STAGE_KB:
        stage = str(state.get("stage") or STAGE_ASK_INTERVIEW)

    # 一拿到城市，工作信息就由代码发（多段），模型的措辞在这轮不采用：
    # 工价/班次一个字都不能错，让模型复述等于把事故概率交给运气。
    # 城市查不到岗位时由 enter_info_result 走「帮你问问」并记未知问题。
    if slots.get("city") and not slots.get("interview_offer_sent"):
        result = enter_info_result(slots, when)
        state["stage"] = result.stage
        return result

    action = data.get("action")
    action = action if action in (ACTION_BOOK, ACTION_GAVE_UP, ACTION_HANDOFF) else None
    finished = bool(data.get("finished")) or stage == STAGE_DONE

    # 档案兜底：模型嘴上说约好了但没给姓名手机，按 collect 处理
    if stage in (STAGE_COLLECT, STAGE_DONE) and not slots.get("booked"):
        slots["interview_agreed"] = True

    # 护栏：槽位没齐，不许往后跳
    requested = stage
    ceiling = _max_stage(slots)
    clamped = _STAGE_ORDER.get(stage, 0) > _STAGE_ORDER[ceiling]
    if clamped:
        stage, finished = ceiling, False

    if action == ACTION_GAVE_UP:
        slots["recruit_status"] = "disqualified"
        stage, finished = STAGE_DONE, True
    elif action == ACTION_HANDOFF:
        # 交人工：结束自动流程，但不写面试时间，别让客户以为约上了
        stage, finished = STAGE_DONE, True
    elif action == ACTION_BOOK:
        if not (slots.get("name") and slots.get("phone")):
            action = None
            stage, finished = STAGE_COLLECT, False
        else:
            slots["interview_at"] = when.isoformat()
            slots["interview_window"] = interview_window_of(_job_of(slots))
            slots["interview_place"] = _job_of(slots).get("place", "")
            slots["interview_agreed"] = True
            slots["booked"] = True
            stage, finished = STAGE_DONE, True

    # 约面试必须走到 collect 且姓名手机齐了，否则这单不算成
    if action == ACTION_BOOK and not slots.get("booked"):
        action = None
        stage, finished = STAGE_COLLECT, False

    if stage == STAGE_DONE and not finished:
        finished = True

    reply = str(data.get("reply") or "").strip()
    parts = _split_parts(reply)

    # 兜底：模型编了工价 / 给了空话，退回确定性话术（在副本上跑，别污染真状态）
    if not parts or not _money_guard(reply, slots):
        probe = copy.deepcopy(state)
        probe["stage"] = stage
        probe["slots"] = dict(slots)
        safe = fallback_step(probe, text, now=now)
        slots.update(safe.slots)
        state["stage"] = safe.stage
        return FlowResult(
            reply="",
            parts=safe.parts,
            stage=safe.stage,
            slots=slots,
            finished=safe.finished,
            action=safe.action or action,
            unknown_question=safe.unknown_question,
        )

    # 只有被护栏按回阶段时，才补一句缺失的提问（回复里已经问到就不加）
    need = _QUESTION.get(stage)
    if need and clamped and requested != stage and not finished:
        asked = _ASKED_HINTS.get(stage, ())
        if not any(word in reply for word in asked):
            parts.append(need)

    # 约好的确认话术（面试地点在这里）命中 booked 岗位话术：模型这轮说的话整段作废
    # ——它常常把地点/时间说得跟岗位数据不一致。状态（booked/interview_at）照旧。
    if action == ACTION_BOOK and slots.get("booked"):
        booked = _stage_script(slots, SCRIPT_STAGE_BOOKED)
        if booked:
            parts = [booked]

    state["stage"] = stage
    return FlowResult(
        reply="",
        parts=parts,
        stage=stage,
        slots=slots,
        finished=finished,
        action=action,
    )


# ── 决策 Prompt（单轮单源 + 对话即上下文）────────────────────────────
# 与 SYSTEM_PROMPT 的分工：SYSTEM_PROMPT 保留给旧 build_messages/兼容路径；
# 主路径 a_step 走 DECISION_PROMPT——事实卡给数字、缺失清单给推进方向、
# 历史给上下文，stage 一律由缺失清单算，模型只出「这一轮的一句话」。
DECISION_PROMPT = """你是一家劳务中介的招聘顾问，叫「陈姐」，在广东做工厂招工十几年。

# 单轮单源：这一轮只做一件事，绝不拼接
按优先级取第一个能做的，答完就停，不要既答问题又推进：
1. 客户插问岗位事实（工价/班次/年龄/吃住/地点）→ 只用下面的岗位事实卡回答，答完就停
2. 客户没接话/答非所问 → 换个说法追问缺失清单的第一项，不重复你说过的原句
3. 客户问的事你答不了 → reply 只说「这个我确认一下，稍后回你」，unknown_question 填客户原话
4. 其他 → 正常接话，并推进缺失清单的第一项

# 岗位事实卡（数字唯一合法来源；为空 = 还没有选定岗位，先问城市）
{fact_card}

# 缺失清单（按顺序，一次只推进第一项缺失）
{missing}

# 最近对话（复述前先看这里，说过的不要再重复）
{transcript}
{material}
# 硬规则
- 工价/工资/钱数只能来自事实卡，事实卡里没有的数字一个都不许出现
- 不许编线下动作（打印面试表、叫主管去门口、登记工号），不许编电话、宿舍号、班车时间
- 客户拒绝（来不了/不去了）→ reply 客气收尾一句，别再追问
- collect 时姓名和手机号一起要；capture 只填客户这句话里明确给的，没给留空串
- day 只能填 今天/明天/后天/大后天，客户没提就留空串
- 不许编自己在做什么；不确定的细节说「我确认一下，稍后回你」

# 现在时间
{now}

# 输出格式（必须是 JSON，不要代码块，不要多余文字）
{{"reply": "发给客户的一句话", "capture": {{"name": "", "phone": "", "city": "", "day": ""}}, "unknown_question": ""}}
"""

_FACT_LABELS = {
    "factory_name": "厂名",
    "job_title": "岗位",
    "wage_text": "工价",
    "hours_text": "班次",
    "age_text": "年龄要求",
    "welfare_text": "吃住",
    "place": "地点",
}

_DAY_LABELS = {0: "今天", 1: "明天", 2: "后天", 3: "大后天"}


def _fact_card_text(slots: dict[str, Any]) -> str:
    snapshot = slots.get("job_snapshot")
    if not isinstance(snapshot, dict) or not snapshot:
        return "（还没有选定岗位，先问城市）"
    return "\n".join(
        f"- {_FACT_LABELS.get(key, key)}：{value}"
        for key, value in snapshot.items()
        if str(value or "").strip()
    )


def _missing_checklist(slots: dict[str, Any]) -> str:
    """缺失清单：城市→岗位确认→面试意向→面试时间→姓名→电话，标出当前第一项缺失。"""
    day = slots.get("interview_day_offset")
    items: list[tuple[str, bool, str]] = [
        ("城市", bool(slots.get("city")), str(slots.get("city") or "")),
        ("岗位确认（已发岗位信息）", bool(slots.get("interview_offer_sent")), ""),
        ("面试意向（这两天能否过来面试）", bool(slots.get("interview_agreed")), ""),
        (
            "面试时间（默认明天）",
            day is not None,
            _DAY_LABELS.get(int(day or 1), "") if isinstance(day, (int, float)) else "",
        ),
        ("姓名", bool(slots.get("name")), str(slots.get("name") or "")),
        ("电话", bool(slots.get("phone")), str(slots.get("phone") or "")),
    ]
    lines: list[str] = []
    first_missing = True
    for index, (label, done, detail) in enumerate(items, start=1):
        if done:
            lines.append(f"{index}. {label}：已拿到" + (f"（{detail}）" if detail else ""))
        else:
            mark = " ← 当前只推进这一项" if first_missing else ""
            lines.append(f"{index}. {label}：缺{mark}")
            first_missing = False
    return "\n".join(lines)


def build_decision_messages(
    state: dict[str, Any],
    text: str,
    now: datetime | None = None,
    material: str = "",
) -> list[ChatMessage]:
    """决策上下文：事实卡 + 缺失清单 + 最近对话历史（复用 build_messages 的投影）。"""
    when = now or datetime.now().astimezone()
    slots = state.get("slots") or {}
    recent = (state.get("history") or [])[-8:]
    transcript = "\n".join(
        f"{'客户' if item['role'] == 'customer' else '你'}：{item['text']}"
        for item in recent
    )
    extra = f"\n# 运营素材（口径已核实，优先原样使用）\n{material}\n" if material else ""
    system = DECISION_PROMPT.format(
        fact_card=_fact_card_text(slots),
        missing=_missing_checklist(slots),
        transcript=transcript or "（还没有）",
        material=extra,
        now=when.strftime("%Y-%m-%d %H:%M"),
    )
    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=f"客户刚说：{text}"),
    ]


# ── 决策输出落地（capture 校验 + stage 由缺失清单算 + 事实校验）───────

# 价格数字的三类抓法：N元（含 N元/小时、N元/班）、N/班、底薪/时薪前缀。
_MONEY_PATTERNS = (
    re.compile(r"(\d+(?:\.\d+)?)\s*元"),
    re.compile(r"(\d+(?:\.\d+)?)\s*/\s*(?:小时|时|天|日|月|班|周|[hH])"),
    re.compile(r"(?:底薪|时薪|月薪|日薪)\s*(\d+(?:\.\d+)?)"),
)


def _fact_guard(reply: str, slots: dict[str, Any]) -> bool:
    """回复里的价格数字必须能在岗位事实卡里找到（防编工价、防串厂）。

    没有快照的老会话退回全城岗位数据（与旧 _money_guard 同口径）；
    有快照后只认本岗——别家厂的工价出现在回复里直接拦下。
    """
    snapshot = slots.get("job_snapshot")
    if isinstance(snapshot, dict) and snapshot:
        allowed = " ".join(str(value) for value in snapshot.values())
    else:
        allowed = " ".join(
            f"{job.get('wage_text', '')} {job.get('welfare_text', '')}"
            for job in jobs_for_city(str(slots.get("city") or ""))
        )
    allowed = allowed.replace(" ", "")
    for pattern in _MONEY_PATTERNS:
        for number in pattern.findall(reply or ""):
            if number.replace(" ", "") not in allowed:
                return False
    return True


def _clean_capture(raw: Any) -> dict[str, Any]:
    """决策输出的 capture：逐字段用现有抽取器校验，格式错丢弃。

    - phone：extract_phone 认可（1[3-9] 开头 11 位）才写，坏格式整字段丢弃
    - name：strict 抽取认得出来才写（2-4 个汉字、不在停用词表）
    - city：必须能归一到在招城市
    - day：只认 今天/明天/后天/大后天
    """
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    from .flow_engine import extract_city, extract_name, extract_phone

    phone = str(raw.get("phone") or "").strip()
    if phone:
        valid = extract_phone(phone)
        if valid:
            out["phone"] = valid
    name = str(raw.get("name") or "").strip()
    if name:
        valid = extract_name(name, strict=True)
        if valid:
            out["name"] = valid
    city = str(raw.get("city") or "").strip()
    if city:
        valid = extract_city(city)
        if valid:
            out["city"] = valid
    day = str(raw.get("day") or "").strip()
    if day:
        offset = extract_day_offset(day)
        if offset is not None:
            out["interview_day_offset"] = offset
    return out


def apply_decision(
    state: dict[str, Any],
    data: dict[str, Any],
    text: str = "",
    now: datetime | None = None,
    kb_answer: str | None = None,
    graph: dict[str, Any] | None = None,
) -> FlowResult:
    """决策输出落地：模型只出话，其余全部由代码算。

    - capture 逐字段抽取器校验（格式错丢弃），原话顺手再抽一遍兜底
    - stage 由缺失清单算，不信模型；模型想跳步 → 回复作废、换确定性提问
    - 价格数字过事实护栏；拦下就退确定性状态机（事实卡/知识库/确认一下）
    - 兼容旧输出契约（slots/profile/action/finished）：老提示词仍能跑
    """
    slots: dict[str, Any] = state.setdefault("slots", {})
    # 客户原话先用现有抽取器过一遍（capture 漏了的字段从这里兜底）
    _absorb(slots, text, strict_name=str(state.get("stage") or "") == STAGE_COLLECT)
    # 旧契约字段：slots/profile 透传（老 mock、老提示词兼容）
    slots.update(_clean_slots(data.get("slots")))
    slots.update(_clean_profile(data.get("profile")))
    # 新契约 capture：格式错丢弃
    slots.update(_clean_capture(data.get("capture")))
    # 客户说了「后天」就按他的来；模型给的时间不作数
    day_offset = extract_day_offset(text)
    if day_offset is not None:
        slots["interview_day_offset"] = day_offset
    when = next_interview(now, _day_offset_of(slots))

    # stage 由缺失清单算，不信模型
    stage = _max_stage(slots)
    requested = str(data.get("stage") or "")
    if requested == STAGE_KB:  # kb 只是插问标签，不参与推进比较
        requested = ""
    action = data.get("action")
    action = action if action in (ACTION_BOOK, ACTION_GAVE_UP, ACTION_HANDOFF) else None

    if action == ACTION_GAVE_UP:
        slots["recruit_status"] = "disqualified"
        state["stage"] = STAGE_DONE
        return FlowResult(
            reply=_gave_up_text(),
            stage=STAGE_DONE,
            slots=slots,
            finished=True,
            action=ACTION_GAVE_UP,
        )
    if action == ACTION_HANDOFF:
        state["stage"] = STAGE_DONE
        return FlowResult(
            reply="好嘞，那我这边先这样，有需要随时找我。",
            stage=STAGE_DONE,
            slots=slots,
            finished=True,
            action=ACTION_HANDOFF,
        )

    # 一拿到城市：工作信息由代码发（话术/卡片），模型的措辞在这轮不采用——
    # 工价/班次一个字都不能错，让模型复述等于把事故概率交给运气。
    if slots.get("city") and not slots.get("interview_offer_sent"):
        result = enter_info_result(slots, when, now)
        state["stage"] = result.stage
        return result

    # 约成：姓名电话齐 + 已答应 → 代码登记（时间/地点/确认话术都在这里算）
    if slots.get("interview_agreed") and slots.get("name") and slots.get("phone"):
        result = _book(slots, when, now)
        state["stage"] = result.stage
        return result

    # 模型想跳步（要的槽位还没拿到）：回复整段作废，换确定性提问（单源）
    clamped = bool(requested) and _STAGE_ORDER.get(
        requested, _STAGE_ORDER[stage]
    ) > _STAGE_ORDER[stage]
    if clamped or action == ACTION_BOOK:
        action = None
        state["stage"] = stage
        question = _QUESTION.get(stage, "")
        if question:
            return FlowResult(reply=question, stage=stage, slots=slots)

    reply = str(data.get("reply") or "").strip()
    unknown = str(data.get("unknown_question") or "").strip()
    if not reply and unknown:
        reply = "这个我确认一下，稍后回你"
    parts = _split_parts(reply)

    # 兜底：空话/编了工价 → 退确定性状态机（事实卡 → 知识库 → 确认一下）
    if not parts or not _fact_guard(reply, slots):
        return fallback_step(state, text, now=now, kb_answer=kb_answer, graph=graph)

    state["stage"] = stage
    return FlowResult(
        reply="",
        parts=parts,
        stage=stage,
        slots=slots,
        finished=stage == STAGE_DONE,
        action=action,
        unknown_question=unknown,
    )


async def a_step(
    state: dict[str, Any],
    text: str,
    provider: LLMProvider | None,
    now: datetime | None = None,
    kb_answer: str | None = None,
    graph: dict[str, Any] | None = None,
) -> FlowResult:
    """一个 turn：单轮单源决策。

    每轮回复只取一个来源，按优先级取第一个能答的，绝不拼接：
      ① 运营话术（该时点且未发过）→ 整段直发（greet/send_info/booked 在
        enter_info_result/_book 里由代码发；ask_interview 首投在下面分支）
      ② 岗位事实卡（job_snapshot）→ 直答，数字唯一合法来源
      ③ 知识库 kb_faq → 原话答
      ④ 智能体（决策 Prompt：事实卡+缺失清单+历史）→ 生成
      ⑤ 都没答上 → 「确认一下」+ 记 unknown_question

    拒绝（is_disagree）走确定性快速通道，不经模型；LLM 不可用/超时/乱码
    退到确定性状态机，不空回复。

    `graph` 是节点图（flow_graph.load_graph 的返回值）。透传给确定性状态机后，
    有图时按图的边走；没给则完全走原有分支。
    """
    stage = str(state.get("stage") or STAGE_ASK_CITY)
    slots: dict[str, Any] = state.setdefault("slots", {})
    when = next_interview(now, _day_offset_of(slots))

    # 已约好（done/booked）不再叫模型：省一次调用，也避免它把状态改回去。
    # 但不再静默（2026-11-12「我的视频呢」教训）——已约客户再来消息：
    # KB 命中就答 KB（问工资/带视频都正常答），没命中就回约面确认信息。
    if stage == STAGE_DONE or slots.get("booked"):
        slots_kept = state.get("slots") or {}
        if kb_answer:
            return FlowResult(
                reply=kb_answer,
                parts=[kb_answer],
                stage=STAGE_DONE,
                slots=slots_kept,
                finished=True,
            )
        _when_txt = "，".join(
            x for x in (str(slots_kept.get("interview_window", "")), str(slots_kept.get("interview_place", ""))) if x
        )
        booked_reply = "你之前已经约好面试啦" + (
            f"（{_when_txt}），到时候直接联系我就行~有其他想了解的也随时问我。"
            if _when_txt
            else "，到时候直接联系我就行~有其他想了解的也随时问我。"
        )
        return FlowResult(
            reply=booked_reply,
            parts=[booked_reply],
            stage=STAGE_DONE,
            slots=slots_kept,
            finished=True,
        )

    # 拒绝快速通道（护栏 5）：确定性处理，不经模型。
    # 问句形式先排除——「电话算了吗」里也有「算了」，那是问事不是拒绝。
    if stage in (STAGE_ASK_INTERVIEW, STAGE_COLLECT) and is_disagree(
        text
    ) and not looks_like_question(text):
        slots["recruit_status"] = "disqualified"
        state["stage"] = STAGE_DONE
        return FlowResult(
            reply=_gave_up_text(),
            stage=STAGE_DONE,
            slots=slots,
            finished=True,
            action=ACTION_GAVE_UP,
        )

    # 「还有别的厂吗 / 换一个」→ 代码列岗位。模型不知道岗位列表，让它答必然编造。
    if stage in (STAGE_SEND_INFO, STAGE_ASK_INTERVIEW) and _WANTS_MORE.search(text):
        return _list_other_jobs(state, now=now)

    # 答应面试：确定性推进（同状态机口径），不用模型判断同不同意
    if (
        stage == STAGE_ASK_INTERVIEW
        and is_agree(text)
        and not looks_like_question(text)
        and not _is_bare_greeting(text)
    ):
        result = _agree_interview(state, slots, when, now)
        state["node"] = result.stage
        return result

    # ② 岗位事实卡直答：客户问的事实能用已钉岗位快照答的，绝不进模型/知识库
    # （global 层条目没有厂归属，会答成别家厂的工价——串厂回归）
    if looks_like_question(text):
        from .flow_engine import _job_fact_answer

        fact = _job_fact_answer(slots, text)
        if fact:
            return FlowResult(reply="", parts=[fact], stage=stage, slots=slots)

    # ③ 知识库 / 兜底：插问分支交给确定性状态机（KB 原话 → 确认一下 + 记账），
    # 不让模型自由发挥——它最容易编出「体检费厂里全报」这种要赔钱的话。
    if stage in (STAGE_ASK_INTERVIEW, STAGE_COLLECT) and (
        kb_answer or looks_like_question(text)
    ):
        return fallback_step(state, text, now=now, kb_answer=kb_answer, graph=graph)

    # ① ask_interview 话术首投：设备配了该时点话术且没发过 → 整段直发。
    # 发过（scripted_sent 记账）就不再命中，由智能体换说法追问。
    if stage == STAGE_ASK_INTERVIEW and _stage_script(
        slots, SCRIPT_STAGE_ASK_INTERVIEW
    ) and not _script_sent(slots, SCRIPT_STAGE_ASK_INTERVIEW):
        return fallback_step(state, text, now=now, kb_answer=kb_answer, graph=graph)

    # 已发过卡但还停在 send_info 的插问：同样走确定性分支，不重发卡片
    if stage == STAGE_SEND_INFO and slots.get("interview_offer_sent") and (
        kb_answer or looks_like_question(text)
    ):
        return fallback_step(state, text, now=now, kb_answer=kb_answer, graph=graph)

    if provider is None:
        return fallback_step(state, text, now=now, kb_answer=kb_answer, graph=graph)

    try:
        raw = await provider.complete(
            build_decision_messages(state, text, now, material=kb_answer or ""),
            temperature=0.7,
            max_tokens=700,
        )
        data = _parse_json(raw)
    except Exception:  # noqa: BLE001  模型超时/返回乱码，不能让客户收不到话
        return fallback_step(state, text, now=now, kb_answer=kb_answer, graph=graph)

    return apply_decision(state, data, text, now=now, kb_answer=kb_answer, graph=graph)


__all__ = [
    "a_step",
    "apply_result",
    "apply_decision",
    "build_messages",
    "build_decision_messages",
    "SYSTEM_PROMPT",
    "DECISION_PROMPT",
]

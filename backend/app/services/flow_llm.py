"""LLM 驱动的招聘对话（harness 风格，v2 流程）。

与 flow_engine 的分工：
- flow_engine 是**确定性兜底**：模型挂了也保证客户收到一句像样的话
- 本模块是**主路径**：模型自己读懂客户、自己说人话
- 但工作信息（厂名/工价/班次/年龄/吃住）永远由代码从 DEMO_JOBS 拼，
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
    DEMO_JOBS,
    INTERVIEW_WINDOW,
    PROFILE_KEYS,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    STAGE_KB,
    STAGE_SEND_INFO,
    FlowResult,
    jobs_for_city,
    looks_like_question,
    next_interview,
    remote_job_cities,
    send_info_parts,
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
1. 问客户投递的是哪个城市（广州 / 深圳 / 东莞）
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
- 不知道就说「我确认一下，稍后回你」，不要猜体检报销、住宿条件这类细节
- 客户拒绝面试：客气一句就结束（action="gave_up"），别再追
- 已经约好之后又发消息：不再回复

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
    cities = sorted(set(DEMO_JOBS) | set(remote_job_cities()))
    lines: list[str] = []
    for city in cities:
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


_WANTS_MORE = re.compile(r"别的|其他|其它|换一|换家|还有没有|多几个")


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
    city = str(raw.get("city") or "").strip()
    if city in DEMO_JOBS:
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
    when = next_interview(now)

    stage = str(data.get("stage") or state.get("stage") or STAGE_ASK_CITY)
    if stage not in ALLOWED_STAGES:
        stage = str(state.get("stage") or STAGE_ASK_CITY)

    # kb 只是插问标签，不落成终态
    if stage == STAGE_KB:
        stage = str(state.get("stage") or STAGE_ASK_INTERVIEW)

    # 一拿到城市，工作信息就由代码发（多段），模型的措辞在这轮不采用：
    # 工价/班次一个字都不能错，让模型复述等于把事故概率交给运气。
    if slots.get("city") and not slots.get("interview_offer_sent"):
        slots["interview_offer_sent"] = True
        state["stage"] = STAGE_ASK_INTERVIEW
        return FlowResult(
            reply="",
            parts=send_info_parts(slots, when),
            stage=STAGE_ASK_INTERVIEW,
            slots=slots,
        )

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
            slots["interview_window"] = INTERVIEW_WINDOW
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

    state["stage"] = stage
    return FlowResult(
        reply="",
        parts=parts,
        stage=stage,
        slots=slots,
        finished=finished,
        action=action,
    )


async def a_step(
    state: dict[str, Any],
    text: str,
    provider: LLMProvider | None,
    now: datetime | None = None,
    kb_answer: str | None = None,
) -> FlowResult:
    """一个 turn：模型读懂 + 回话；失败就退到确定性状态机。"""
    stage = str(state.get("stage") or STAGE_ASK_CITY)

    # 已约好（done）就不再叫模型：省一次调用，也避免它把状态改回去
    if stage == STAGE_DONE or (state.get("slots") or {}).get("booked"):
        return FlowResult(
            reply="",
            stage=STAGE_DONE,
            slots=state.get("slots") or {},
            finished=True,
        )

    # 「还有别的厂吗 / 换一个」→ 代码列岗位。模型不知道岗位列表，让它答必然编造。
    if stage in (STAGE_SEND_INFO, STAGE_ASK_INTERVIEW) and _WANTS_MORE.search(text):
        return _list_other_jobs(state, now=now)

    # 插问交给确定性分支：命中就回知识库原话，没命中就兜底 + 记未知问题。
    # 这类问题让模型自由发挥，最容易编出「体检费厂里全报」这种要赔钱的话。
    if stage in (STAGE_ASK_INTERVIEW, STAGE_COLLECT) and (
        kb_answer or looks_like_question(text)
    ):
        return fallback_step(state, text, now=now, kb_answer=kb_answer)

    if provider is None:
        return fallback_step(state, text, now=now, kb_answer=kb_answer)

    try:
        raw = await provider.complete(
            build_messages(state, text, now), temperature=0.7, max_tokens=700
        )
        data = _parse_json(raw)
    except Exception:  # noqa: BLE001  模型超时/返回乱码，不能让客户收不到话
        return fallback_step(state, text, now=now, kb_answer=kb_answer)

    return apply_result(state, data, text, now=now)


__all__ = ["a_step", "apply_result", "build_messages", "SYSTEM_PROMPT"]

"""LLM 驱动的招聘对话（harness 风格）。

与 flow_engine 的分工：
- flow_engine 是**确定性兜底**：模型挂了也保证客户收到一句像样的话
- 本模块是**主路径**：模型自己读懂客户、自己决定问什么、自己说人话

对应 DeepSeek Harness 的几个关键取舍：
1. 会话日志只追加（在 flow_session 里），本模块只读投影 + 追加，不覆盖
2. turn / step：一次客户消息 = 一个 turn；模型调用失败在同一个 step 内重试，
   不重复消费客户输入、不重复发消息
3. surface 投影：给模型的是"最近几轮 + 当前已知信息"，不是全部历史
4. 副作用与文字分离：模型只提议 action，真正落库/算时间由代码做，
   避免它嘴上说"约好了"其实什么都没写
"""

from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from typing import Any

from .flow_engine import (
    ACTION_BOOK,
    ACTION_HANDOFF,
    DEMO_JOBS,
    STAGE_ASK_CITY,
    STAGE_ASK_GENDER,
    STAGE_ASK_RECORD,
    STAGE_CONFIRM,
    STAGE_DONE,
    FlowResult,
    next_noon,
    step as fallback_step,
)
from .llm_provider import ChatMessage, LLMProvider

ALLOWED_STAGES = {
    STAGE_ASK_CITY,
    STAGE_ASK_GENDER,
    STAGE_ASK_RECORD,
    STAGE_CONFIRM,
    STAGE_DONE,
}

SYSTEM_PROMPT = """你是一家劳务中介的招聘顾问，叫「陈姐」，在广东做工厂招工十几年。

# 你的目标
把每一个来咨询的人，聊到「约好面试」为止。顺序是：
1. 问他在哪个城市（广州 / 深圳 / 东莞）
2. 按他的城市，介绍岗位和待遇（钱、吃住、班次、年龄要求）
3. 问性别
4. 问有没有犯罪记录（要说明这是厂里要查，不影响正常安排）
5. 信息齐了，约面试：**默认第二天中午 1 点**，地点就是岗位地址
6. 约好之后，欢迎他去面试，然后**不再回复**

# 说话方式（很重要）
- 像微信上聊天的真人：短句、口语、可以用「哈」「嗯」「好嘞」
- 一次只说一件事，别把三个问题堆一起
- 客户问什么就先答什么，答完再自然接回你该问的
- 不要复读上一句，不要每句都「您好」「请问」
- 客户问「还有别的岗位吗」就把其他岗位报给他；说想换，就换

# 硬性规则
- **不许编数字**。工价、年龄、吃住只能照下面岗位数据说，一个字都不能改
- 不知道就说「我问一下厂里，回头告诉你」，不要猜
- 客户说有犯罪记录：别约面试，说如实报上去、能不能过看厂里
- 客户已经约好之后又发消息：不再回复

# 进度纪律
- 顺序是 城市 → 性别 → 犯罪记录 → 约面试，缺一个都不能往下走
- 只问这三样：城市、性别、有没有犯罪记录。**年龄、民族、学历这些不要问**
- 一次只问一个问题，别连着抛三个
- 客户答得含糊（比如你问「想去哪个厂」他回「没有」），不要当他在回答别的问题，把该问的重问一次
- 客户没明确说去哪个厂，就默认第一个，**别反复问「你想去哪个」**
- 约时间那句必须**以问句结尾**（「明天中午 1 点方便吗？」），客户答应了才说欢迎语
- 三项都拿到了才约面试；约成之后不再回复

# 岗位数据（只能从这里取）
{jobs}

# 现在时间
{now}

# 输出格式（必须是 JSON，不要代码块，不要多余文字）
{{"reply": "发给客户的话", "stage": "ask_city|ask_gender|ask_record|confirm|done",
  "slots": {{"city": "", "gender": "", "record": "", "age": null, "job_index": 0}},
  "action": null,
  "finished": false}}

action 只能是 null / "book_interview" / "handoff"：
- 客户同意面试时间 → action="book_interview"，finished=true，reply 是欢迎语
- 客户说有犯罪记录 → action="handoff"，finished=true
- 其他情况一律 null
"""


def _jobs_brief() -> str:
    lines: list[str] = []
    for city, jobs in DEMO_JOBS.items():
        for index, job in enumerate(jobs):
            lines.append(
                f"- [{city}#{index}] {job['title']}｜{job['place']}｜{job['pay']}"
                f"｜{job['hours']}｜{job['age']}｜{job['welfare']}"
            )
    return "\n".join(lines)


def build_messages(
    state: dict[str, Any], text: str, now: datetime | None = None
) -> list[ChatMessage]:
    """surface 投影：只给最近几轮对话 + 已收集信息，不给全量历史。"""
    when = now or datetime.now().astimezone()
    system = SYSTEM_PROMPT.format(jobs=_jobs_brief(), now=when.strftime("%Y-%m-%d %H:%M"))
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


def _job_of(slots: dict[str, Any]) -> dict[str, str]:
    jobs = DEMO_JOBS.get(str(slots.get("city") or ""), [])
    if not jobs:
        return {}
    index = int(slots.get("job_index") or 0)
    return jobs[min(max(index, 0), len(jobs) - 1)]


def _money_guard(reply: str, slots: dict[str, Any]) -> bool:
    """回复里出现的「N 元」必须能在岗位数据里找到，防止模型编工价。"""
    allowed = " ".join(
        f"{job['pay']} {job['welfare']}" for job in DEMO_JOBS.get(str(slots.get("city") or ""), [])
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
    gender = str(raw.get("gender") or "").strip()
    if gender in ("男", "女"):
        slots["gender"] = gender
    record = str(raw.get("record") or "").strip()
    if record in ("有", "无"):
        slots["record"] = record
    age = raw.get("age")
    if isinstance(age, int) and 16 <= age <= 70:
        slots["age"] = age
    index = raw.get("job_index")
    if isinstance(index, int) and index >= 0:
        slots["job_index"] = index
    return slots


def _max_stage(slots: dict[str, Any]) -> str:
    """缺什么就停在哪一步。模型不能跳过没拿到的槽位。"""
    if not slots.get("city"):
        return STAGE_ASK_CITY
    if not slots.get("gender"):
        return STAGE_ASK_GENDER
    if not slots.get("record"):
        return STAGE_ASK_RECORD
    return STAGE_CONFIRM


_QUESTION = {
    STAGE_ASK_CITY: "你在哪个城市呀？广州、深圳还是东莞？",
    STAGE_ASK_GENDER: "对了，你是男生还是女生？",
    STAGE_ASK_RECORD: "还有个事，厂里要查，你有没有犯罪记录？",
    STAGE_CONFIRM: "那咱就约明天中午 1 点，方便吗？",
}


def apply_result(
    state: dict[str, Any],
    data: dict[str, Any],
    text: str = "",
    now: datetime | None = None,
) -> FlowResult:
    """把模型输出落成状态。副作用（时间、地点）由代码算，不信任模型。"""
    slots: dict[str, Any] = state.setdefault("slots", {})
    slots.update(_clean_slots(data.get("slots")))

    stage = str(data.get("stage") or state.get("stage") or STAGE_ASK_CITY)
    if stage not in ALLOWED_STAGES:
        stage = str(state.get("stage") or STAGE_ASK_CITY)

    reply = str(data.get("reply") or "").strip()
    action = data.get("action")
    action = action if action in (ACTION_BOOK, ACTION_HANDOFF) else None
    finished = bool(data.get("finished")) or stage == STAGE_DONE

    # 约面试必须先问过「方便吗」。模型拿到记录就直接宣布约好，
    # 客户下一句「可以」会撞在已结束的状态上收不到欢迎语。
    if action == ACTION_BOOK and str(state.get("stage") or "") != STAGE_CONFIRM:
        action = None
        stage, finished = STAGE_CONFIRM, False

    # 护栏：槽位没齐，不许往后跳。模型想跳就按回该停的阶段，
    # 只有**被按回**的时候才补一句缺失的提问，否则会变成每句都复读。
    ceiling = _max_stage(slots)
    clamped = action is None and stage != ceiling
    if clamped:
        stage, finished = ceiling, False

    if action == ACTION_BOOK:
        if _max_stage(slots) != STAGE_CONFIRM:
            action = None
            stage = _max_stage(slots)
            finished = False
        else:
            when = next_noon(now)
            slots["interview_at"] = when.isoformat()
            slots["interview_place"] = _job_of(slots).get("place", "")
            slots["booked"] = True
            stage, finished = STAGE_DONE, True
    elif action == ACTION_HANDOFF:
        slots.pop("interview_at", None)
        stage, finished = STAGE_DONE, True

    if stage == STAGE_DONE and not finished:
        finished = True

    # 兜底：模型编了工价 / 给了空话，退回确定性话术（在副本上跑，别污染真状态）
    if not reply or not _money_guard(reply, slots):
        safe = fallback_step(copy.deepcopy(state), text, now=now)
        state["stage"] = stage
        return FlowResult(
            reply=safe.reply or reply,
            stage=stage,
            slots=slots,
            finished=finished,
            action=action,
        )

    # 只有被护栏按回阶段时，才补一句缺失的提问（回复里已经问到就不加）
    need = _QUESTION.get(stage)
    if clamped and need and not finished:
        asked = {
            STAGE_ASK_CITY: ("城市",),
            STAGE_ASK_GENDER: ("男", "女"),
            STAGE_ASK_RECORD: ("记录",),
            STAGE_CONFIRM: ("方便", "约", "明天", "点"),
        }.get(stage, ())
        if not any(word in reply for word in asked):
            reply = f"{reply}\n{need}" if reply else need

    state["stage"] = stage
    return FlowResult(reply=reply, stage=stage, slots=slots, finished=finished, action=action)


async def a_step(
    state: dict[str, Any],
    text: str,
    provider: LLMProvider | None,
    now: datetime | None = None,
) -> FlowResult:
    """一个 turn：模型读懂 + 回话；失败就退到确定性状态机。"""
    # 已约好（done）就不再叫模型：省一次调用，也避免它把状态改回去
    if str(state.get("stage")) == STAGE_DONE or (state.get("slots") or {}).get("booked"):
        return FlowResult(
            reply="",
            stage=STAGE_DONE,
            slots=state.get("slots") or {},
            finished=True,
        )

    if provider is None:
        return fallback_step(state, text, now=now)

    try:
        raw = await provider.complete(
            build_messages(state, text, now), temperature=0.7, max_tokens=700
        )
        data = _parse_json(raw)
    except Exception:  # noqa: BLE001  模型超时/返回乱码，不能让客户收不到话
        return fallback_step(state, text, now=now)

    return apply_result(state, data, text, now=now)


__all__ = ["a_step", "apply_result", "build_messages", "SYSTEM_PROMPT"]

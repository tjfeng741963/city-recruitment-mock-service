"""招聘对话状态机（演示版）。

核心思想：**问什么由代码决定，怎么说由话术模板决定。**

每轮输入 (state, 客户这句话) → 输出 (reply, 新 state)。state 可落库、可回放，
出了问题能查出"当时他在哪一步、已经收集了哪些信息"。

流程（与产品定义一致）：
    ask_city      问地点
    offer_job     按城市发岗位 + 待遇（与问性别合并成一条消息）
    ask_gender    问性别
    ask_record    问有无犯罪记录
    confirm       复述信息 + 约面试（默认次日 13:00）
    done          欢迎去面试，之后不再自动回复

演示数据在 DEMO_JOBS 里，接真实数据时替换它即可，其余逻辑不动。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

# 固定 UTC+8：Windows 上常常没有 tzdata，依赖 zoneinfo 会在测试环境直接炸
TZ = timezone(timedelta(hours=8), "CST")

STAGE_ASK_CITY = "ask_city"
STAGE_OFFER_JOB = "offer_job"
STAGE_ASK_GENDER = "ask_gender"
STAGE_ASK_RECORD = "ask_record"
STAGE_CONFIRM = "confirm"
STAGE_DONE = "done"

ACTION_BOOK = "book_interview"
ACTION_HANDOFF = "handoff"

# ── 演示数据：真实数据缺失，这里先编一套能跑通流程的 ──────────────────
DEMO_JOBS: dict[str, list[dict[str, str]]] = {
    "广州": [
        {
            "title": "利口福食品厂 普工",
            "place": "番禺南村员岗地铁站附近",
            "pay": "16 元/小时",
            "hours": "两班倒，月休 2-4 天",
            "age": "18-48 岁",
            "welfare": "包吃包住",
        },
        {
            "title": "钟村电子厂 组装工",
            "place": "番禺钟村工业区",
            "pay": "18 元/小时",
            "hours": "长白班，月休 4 天",
            "age": "16-43 岁",
            "welfare": "包吃，住宿补贴 200 元/月",
        },
    ],
    "深圳": [
        {
            "title": "龙华电子厂 质检",
            "place": "龙华大浪街道",
            "pay": "20 元/小时",
            "hours": "两班倒，月休 4 天",
            "age": "18-45 岁",
            "welfare": "包吃包住，满三个月奖励 500",
        },
        {
            "title": "宝安玩具厂 包装工",
            "place": "宝安沙井街道",
            "pay": "18 元/小时",
            "hours": "长白班，月休 4 天",
            "age": "18-50 岁",
            "welfare": "包住，饭补 260 元/月",
        },
        {
            "title": "龙岗物流园 分拣员",
            "place": "龙岗布吉街道",
            "pay": "21 元/小时",
            "hours": "夜班为主，月休 2 天",
            "age": "20-45 岁",
            "welfare": "包住，加班另算",
        },
    ],
    "东莞": [
        {
            "title": "长安五金厂 操作工",
            "place": "长安镇乌沙社区",
            "pay": "19 元/小时",
            "hours": "两班倒，月休 2 天",
            "age": "18-50 岁",
            "welfare": "包住，饭补 300 元/月",
        },
        {
            "title": "虎门电子厂 组装工",
            "place": "虎门镇白沙工业区",
            "pay": "20 元/小时",
            "hours": "两班倒，月休 4 天",
            "age": "18-45 岁",
            "welfare": "包吃包住，满勤奖 300",
        },
        {
            "title": "厚街鞋厂 针车工",
            "place": "厚街镇汀山村",
            "pay": "18.5 元/小时",
            "hours": "长白班，月休 4 天",
            "age": "20-48 岁",
            "welfare": "包住，计件另算",
        },
    ],
}

_CITY_ALIASES = {
    "广州": "广州", "广州市": "广州", "番禺": "广州", "天河": "广州", "白云": "广州",
    "深圳": "深圳", "深圳市": "深圳", "龙华": "深圳", "宝安": "深圳", "龙岗": "深圳",
    "东莞": "东莞", "东莞市": "东莞", "长安": "东莞", "虎门": "东莞",
}

_GENDER_MALE = ("男", "男生", "男工", "男孩", "爷们", "哥们")
_GENDER_FEMALE = ("女", "女生", "女工", "女孩", "姐妹")

_RECORD_NONE = ("没有", "无", "没", "干净", "清白", "没案底", "没有案底", "没记录")
_RECORD_HAS = ("有案底", "有前科", "坐过牢", "判过", "拘留", "有记录", "有过", "有案")

_AGREE = ("可以", "好", "行", "方便", "没问题", "能", "嗯", "ok", "OK", "Ok", "去", "准时")
_DISAGREE = ("不行", "不方便", "没空", "改天", "再说", "来不了", "不能")

_FAQ_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("地铁", "怎么去", "怎么走", "地址", "在哪", "位置"), "address"),
    (("工资", "工价", "多少钱", "待遇", "几块", "小时"), "pay"),
    (("吃", "住", "宿舍", "饭"), "welfare"),
    (("几岁", "年龄", "多大"), "age"),
    (("几点", "多久", "几号", "上班时间", "班次"), "hours"),
)


@dataclass
class FlowResult:
    """一轮对话的处理结果。"""

    reply: str
    stage: str
    slots: dict[str, Any] = field(default_factory=dict)
    finished: bool = False
    action: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "reply": self.reply,
            "stage": self.stage,
            "slots": self.slots,
            "finished": self.finished,
            "action": self.action,
        }


def new_state() -> dict[str, Any]:
    return {"stage": STAGE_ASK_CITY, "slots": {"city": "", "job_index": 0}, "turns": 0}


# ── 抽取 ──────────────────────────────────────────────
def extract_city(text: str) -> str:
    for alias, city in _CITY_ALIASES.items():
        if alias in text:
            return city
    return ""


def extract_gender(text: str) -> str:
    for word in _GENDER_MALE:
        if word in text:
            return "男"
    for word in _GENDER_FEMALE:
        if word in text:
            return "女"
    return ""


def extract_record(text: str) -> str:
    for word in _RECORD_HAS:
        if word in text:
            return "有"
    for word in _RECORD_NONE:
        if word in text:
            return "无"
    return ""


def extract_age(text: str) -> int | None:
    match = re.search(r"(\d{2})\s*(?:岁|周岁)", text)
    return int(match.group(1)) if match else None


def is_agree(text: str) -> bool:
    if any(word in text for word in _DISAGREE):
        return False
    return any(word in text for word in _AGREE)


def is_disagree(text: str) -> bool:
    return any(word in text for word in _DISAGREE)


def next_noon(now: datetime | None = None) -> datetime:
    """默认面试时间：第二天 13:00（本地时区）。"""
    base = now or datetime.now(TZ)
    if base.tzinfo is None:
        base = base.replace(tzinfo=TZ)
    return (base + timedelta(days=1)).replace(
        hour=13, minute=0, second=0, microsecond=0
    )


# ── 话术 ──────────────────────────────────────────────
def _jobs_of(slots: dict[str, Any]) -> list[dict[str, str]]:
    return DEMO_JOBS.get(str(slots.get("city") or ""), [])


def _job_of(slots: dict[str, Any]) -> dict[str, str]:
    jobs = _jobs_of(slots)
    if not jobs:
        return {}
    index = int(slots.get("job_index") or 0)
    return jobs[min(index, len(jobs) - 1)]


def _city_ask(slots: dict[str, Any]) -> str:
    cities = "、".join(DEMO_JOBS) or "本地"
    return f"你好，我们这边{cities}都有厂在招。你人在哪个城市？"


def _offer_text(slots: dict[str, Any]) -> str:
    jobs = _jobs_of(slots)
    if not jobs:
        return _city_ask(slots)
    job = _job_of(slots)
    lines = [f"{slots['city']}这边现在有 {len(jobs)} 个岗位在招，先发你一个："]
    lines.append(
        f"【{job['title']}】{job['place']}，{job['pay']}，{job['hours']}，"
        f"年龄 {job['age']}，{job['welfare']}。"
    )
    if len(jobs) > 1:
        others = "、".join(j["title"].split(" ")[0] for j in jobs[1:])
        lines.append(f"另外还有{others}，想看去哪个跟我说。")
    lines.append("你是男生还是女生？")
    return "\n".join(lines)


def _record_ask(slots: dict[str, Any]) -> str:
    return "性别我记下了。厂里要查这个，你有没有犯罪记录？（如实说就行，不影响正常安排）"


def _confirm_text(slots: dict[str, Any], when: datetime) -> str:
    job = _job_of(slots)
    stamp = when.strftime("%m月%d日 %H:%M").replace(" 13:00", " 中午1点")
    return (
        f"我确认一下：{slots.get('city', '')} · {job.get('title', '')} · "
        f"{job.get('pay', '')} · {slots.get('gender', '')} · "
        f"记录 {slots.get('record', '无')}。\n"
        f"那就约明天（{stamp}）在{job.get('place', '')}面试，方便吗？"
    )


def _welcome_text(slots: dict[str, Any], when: datetime) -> str:
    job = _job_of(slots)
    stamp = when.strftime("%m月%d日 %H:%M").replace(" 13:00", " 中午1点")
    return (
        f"好嘞，约好了：明天（{stamp}）{job.get('place', '')}。\n"
        f"到时候带上身份证，到了给我发个消息，我出来接你。祝你面试顺利！"
    )


def _faq_answer(text: str, job: dict[str, str]) -> str:
    if not job:
        return ""
    for keywords, key in _FAQ_RULES:
        if any(word in text for word in keywords):
            value = job.get(key, "")
            if key == "address":
                return f"地址是{job.get('place', '')}。"
            if key == "pay":
                return f"这个岗位{job.get('pay', '')}，{job.get('welfare', '')}。"
            if key == "welfare":
                return f"{job.get('welfare', '')}。"
            if key == "age":
                return f"年龄要求{job.get('age', '')}。"
            if key == "hours":
                return f"{job.get('hours', '')}。"
            return str(value)
    return ""


# ── 主流程 ────────────────────────────────────────────
def step(state: dict[str, Any], text: str, now: datetime | None = None) -> FlowResult:
    """推进一轮对话。state 会被就地更新，返回值同时带上新 state。"""
    text = (text or "").strip()
    stage = str(state.get("stage") or STAGE_ASK_CITY)
    slots: dict[str, Any] = state.setdefault("slots", {})
    state["turns"] = int(state.get("turns") or 0) + 1
    when = next_noon(now)

    if stage == STAGE_DONE:
        return FlowResult(reply="", stage=STAGE_DONE, slots=slots, finished=True)

    # 中途插问：先把客户的问题答了，再把当前该问的追问一次
    if stage != STAGE_ASK_CITY:
        faq = _faq_answer(text, _job_of(slots))
        if faq:
            follow = {
                STAGE_ASK_GENDER: "你是男生还是女生？",
                STAGE_ASK_GENDER + "_pending": "你是男生还是女生？",
                STAGE_ASK_RECORD: "对了，有没有犯罪记录？",
                STAGE_CONFIRM: "明天中午 1 点方便吗？",
            }.get(stage, "")
            reply = f"{faq}{follow}" if follow else faq
            return FlowResult(reply=reply, stage=stage, slots=slots)

    if stage == STAGE_ASK_CITY:
        city = extract_city(text) or str(slots.get("city") or "")
        if not city:
            return FlowResult(reply=_city_ask(slots), stage=STAGE_ASK_CITY, slots=slots)
        slots["city"] = city
        slots.setdefault("job_index", 0)
        state["stage"] = STAGE_ASK_GENDER
        return FlowResult(
            reply=_offer_text(slots), stage=STAGE_ASK_GENDER, slots=slots
        )

    if stage == STAGE_OFFER_JOB:
        state["stage"] = STAGE_ASK_GENDER
        return FlowResult(reply=_offer_text(slots), stage=STAGE_ASK_GENDER, slots=slots)

    if stage == STAGE_ASK_GENDER:
        gender = extract_gender(text)
        if not gender:
            return FlowResult(
                reply="我这边好安排岗位，你先说下是男生还是女生？",
                stage=STAGE_ASK_GENDER,
                slots=slots,
            )
        slots["gender"] = gender
        age = extract_age(text)
        if age:
            slots["age"] = age
        state["stage"] = STAGE_ASK_RECORD
        return FlowResult(reply=_record_ask(slots), stage=STAGE_ASK_RECORD, slots=slots)

    if stage == STAGE_ASK_RECORD:
        record = extract_record(text)
        if not record:
            return FlowResult(
                reply="这个要如实说哈，有没有犯罪记录？有或没有都回我一句。",
                stage=STAGE_ASK_RECORD,
                slots=slots,
            )
        slots["record"] = record
        age = extract_age(text)
        if age:
            slots["age"] = age
        if record == "有":
            slots.pop("interview_at", None)
            state["stage"] = STAGE_DONE
            return FlowResult(
                reply=(
                    "这个情况我记下了。有记录的话厂里审核会卡，我先如实报上去，"
                    "能不能过要看厂里，有结果我第一时间告诉你。"
                ),
                stage=STAGE_DONE,
                slots=slots,
                finished=True,
                action=ACTION_HANDOFF,
            )
        slots["interview_at"] = when.isoformat()
        slots["interview_place"] = _job_of(slots).get("place", "")
        state["stage"] = STAGE_CONFIRM
        return FlowResult(reply=_confirm_text(slots, when), stage=STAGE_CONFIRM, slots=slots)

    if stage == STAGE_CONFIRM:
        if is_disagree(text):
            # 客户想去别的时间：留在 confirm，等他自己给时间点（演示版先问一句）
            return FlowResult(
                reply="那你哪天方便？大概几点？说了我帮你跟厂里报。",
                stage=STAGE_CONFIRM,
                slots=slots,
            )
        if not is_agree(text):
            return FlowResult(
                reply="明天中午 1 点这个时间行不行？回我一句就行。",
                stage=STAGE_CONFIRM,
                slots=slots,
            )
        state["stage"] = STAGE_DONE
        slots["booked"] = True
        return FlowResult(
            reply=_welcome_text(slots, when),
            stage=STAGE_DONE,
            slots=slots,
            finished=True,
            action=ACTION_BOOK,
        )

    # 未知阶段：兜底回到问城市
    state["stage"] = STAGE_ASK_CITY
    return FlowResult(reply=_city_ask(slots), stage=STAGE_ASK_CITY, slots=slots)

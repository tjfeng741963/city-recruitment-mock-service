"""招聘对话状态机（v2）。

核心思想没变：**问什么由代码决定，怎么说由话术模板决定。**
变的是流程本身（对齐 docs/对齐-对话流程与知识库v2.md）：

    ask_city       问「你投递的是哪个城市的简历」
    send_info      按城市发工作信息（多段，一个 turn 内发完）
    ask_interview  问「这两天能不能过来面试」
    collect        要姓名 + 手机号（一次问两个）
    done           期待你来面试，到了联系我；之后静默
    kb             任意阶段的插问，答完仍回到原阶段

三条不能破的规矩：
1. 工作信息只从岗位数据取（4222 注入的远端岗位），话术里不许出现数据里没有的工价
2. 面试时间由代码算（默认次日 09:00-11:00），不听客户以外的人瞎说
3. 客户拒绝面试就到此为止，不再追问

岗位数据全部来自 4222（api_flow 每轮注入 set_remote_jobs）；某城市查不到岗位时
不编岗位，走「已记下，帮你问问」话术并记未知问题。
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

# 固定 UTC+8：Windows 上常常没有 tzdata，依赖 zoneinfo 会在测试环境直接炸
TZ = timezone(timedelta(hours=8), "CST")

STAGE_ASK_CITY = "ask_city"
STAGE_SEND_INFO = "send_info"
STAGE_ASK_INTERVIEW = "ask_interview"
STAGE_COLLECT = "collect"
STAGE_DONE = "done"
# 插问的暂存阶段：答完就回原阶段，不落库成终态（见 _RESUME_OF）
STAGE_KB = "kb"

ACTION_BOOK = "book_interview"
ACTION_GAVE_UP = "gave_up"
ACTION_HANDOFF = "handoff"

# 面试时间窗口：工厂账号可改成别的窗口，地铁账号固定早场
INTERVIEW_WINDOW = "09:00-11:00"

# 档案字段：与业务槽位同放 state["slots"]，另由 profile 事件单独记一份便于回放/推送
PROFILE_KEYS = ("name", "phone", "province", "district", "age", "notes")

_CITY_ALIASES = {
    "广州": "广州", "广州市": "广州", "番禺": "广州", "天河": "广州", "白云": "广州",
    "深圳": "深圳", "深圳市": "深圳", "龙华": "深圳", "宝安": "深圳", "龙岗": "深圳",
    "东莞": "东莞", "东莞市": "东莞", "长安": "东莞", "虎门": "东莞",
}

_AGREE = (
    "可以", "好的", "好呀", "好啊", "行", "没问题", "方便", "能来", "过去",
    "嗯", "ok", "OK", "Ok", "准时", "去",
)
# 「不能」本身是拒绝，但「能不能过来」里也含它——先排掉疑问句式再判断。
# 2026-11-13 实测：客户回「不能」，系统当成含糊答非所问，又追问一遍。
_DISAGREE = (
    "不行", "不方便", "没空", "改天", "再说", "来不了", "不能来", "不去了",
    "不过去", "不想去", "去不了", "再等等", "不能", "不去", "算了",
)
# 这些是「询问能否」的句式，不能当拒绝
_ASK_FORM = ("能不能", "可不可以", "行不行", "来不来", "去不去", "要不要")

# 判断"这句话是不是在问事"，决定要不要走知识库
_QUESTION_MARKS = (
    "?", "？", "吗", "呢", "多少", "怎么", "怎样", "能不能", "可不可以",
    "行不行", "有没有", "要不要", "是不是", "什么", "几点", "多久", "几号", "哪里", "在哪",
)

# 姓名抽取时要排掉的词：两个汉字的常用词太多，不排就会把「手机」当人名
_NAME_STOPWORDS = {
    "广州", "深圳", "东莞", "番禺", "天河", "白云", "龙华", "宝安", "龙岗", "长安", "虎门",
    "手机", "电话", "号码", "联系", "方式", "微信", "你好", "在吗", "可以", "没有", "明天",
    "今天", "后天", "男生", "女生", "普工", "面试", "工厂", "我们", "我是", "名字", "姓名",
}


@dataclass
class FlowResult:
    """一轮对话的处理结果。

    `reply` 永远是 `parts` 用换行拼起来的：老客户端只读 reply，
    新客户端按 parts 逐条发（客户端一次只能发一条消息）。
    """

    reply: str
    stage: str
    slots: dict[str, Any] = field(default_factory=dict)
    finished: bool = False
    action: str | None = None
    parts: list[str] = field(default_factory=list)
    attachments: list[Any] = field(default_factory=list)
    # 知识库没答上来的原话，由调用方落 unknown_questions（本模块不做 I/O）
    unknown_question: str = ""

    def __post_init__(self) -> None:
        self.parts = [part for part in (self.parts or []) if part]
        if self.parts:
            self.reply = "\n".join(self.parts)
        elif self.reply:
            self.parts = [self.reply]

    def to_dict(self) -> dict[str, Any]:
        return {
            "reply": self.reply,
            "parts": self.parts,
            "attachments": self.attachments,
            "stage": self.stage,
            "slots": self.slots,
            "finished": self.finished,
            "action": self.action,
        }


def new_state() -> dict[str, Any]:
    return {
        "stage": STAGE_ASK_CITY,
        "slots": {"city": "", "job_index": 0},
        "turns": 0,
        "profile": {},
    }


# ── 抽取 ──────────────────────────────────────────────
# 运行时城市/区县表，由 api_flow 每轮从 4222 注入（GET /api/v1/agent/cities）。
# 硬编码别名只覆盖最早对接的 3 个城市；运营在后台新建的城市靠这张表才认得出来。
# [(别名, 城市名), ...]，长别名排前面，避免「广州市」被「广州」先吃掉。
_REMOTE_PLACES: ContextVar[list[tuple[str, str]]] = ContextVar(
    "remote_places", default=[]
)


def set_remote_cities(items: list[dict[str, Any]] | None) -> None:
    """注入后台维护的城市与区县。失败时传空列表，退回硬编码别名。"""
    places: list[tuple[str, str]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        city = str(item.get("city_name") or "").strip()
        if not city:
            continue
        places.append((city, city))
        districts = item.get("districts")
        if isinstance(districts, list):
            for district in districts:
                alias = str(district or "").strip()
                if alias:
                    places.append((alias, city))
    places.sort(key=lambda pair: len(pair[0]), reverse=True)
    _REMOTE_PLACES.set(places)


def remote_city_names() -> list[str]:
    """后台在招的城市名（给「我们这边X都有厂在招」这类话术用）。"""
    return list(dict.fromkeys(city for _, city in _REMOTE_PLACES.get()))


def extract_city(text: str) -> str:
    for alias, city in _REMOTE_PLACES.get():
        if alias in text:
            return city
    for alias, city in _CITY_ALIASES.items():
        if alias in text:
            return city
    return ""


def extract_province(text: str) -> str:
    match = re.search(r"([\u4e00-\u9fa5]{2,3}省)", text)
    return match.group(1) if match else ""


def extract_district(text: str) -> str:
    match = re.search(r"([\u4e00-\u9fa5]{2,3}(?:区|县|镇))", text)
    if not match:
        return ""
    district = match.group(1)
    # 「市白云区」这种把上一级尾巴带进来的，掐掉
    while len(district) > 3 and district[0] in "省市县":
        district = district[1:]
    return district


def extract_phone(text: str) -> str:
    compact = re.sub(r"[\s\-—－.()（）]", "", text or "")
    match = re.search(r"(?<!\d)(1[3-9]\d{9})(?!\d)", compact)
    return match.group(1) if match else ""


def _name_token(text: str) -> str:
    for raw in re.split(r"[^\u4e00-\u9fa5]+", text or ""):
        token = raw.strip()
        for prefix in ("叫", "是"):
            if token.startswith(prefix) and len(token) > 2:
                token = token[len(prefix):]
        for suffix in ("的手机", "的手机号", "电话"):
            if token.endswith(suffix) and len(token) > len(suffix):
                token = token[: -len(suffix)]
        if 2 <= len(token) <= 4 and token not in _NAME_STOPWORDS:
            return token
    return ""


def extract_name(text: str, strict: bool = False) -> str:
    """抽姓名。

    strict=False 只认明确线索（「我叫张三」）——问城市那一轮把「广州」当人名的坑踩过。
    strict=True 才敢把光秃秃的「张三」当名字，用在 collect 阶段。
    """
    for cue in ("我叫", "名字叫", "姓名叫", "姓名是", "我是"):
        if cue in text:
            name = _name_token(text.split(cue, 1)[1])
            if name:
                return name
    return _name_token(text) if strict else ""


def extract_age(text: str) -> int | None:
    match = re.search(r"(\d{2})\s*(?:岁|周岁)", text)
    return int(match.group(1)) if match else None


def is_agree(text: str) -> bool:
    if any(word in text for word in _DISAGREE):
        return False
    # 「好几号到？」这种长句里的「好」不算答应，短句才算
    return len(text) <= 12 and any(word in text for word in _AGREE)


def is_disagree(text: str) -> bool:
    value = text or ""
    # 「能不能过来」是问句，不是拒绝：先把它抹掉再判
    for form in _ASK_FORM:
        value = value.replace(form, "")
    return any(word in value for word in _DISAGREE)


def looks_like_question(text: str) -> bool:
    return any(mark in (text or "") for mark in _QUESTION_MARKS)


def next_interview(now: datetime | None = None, day_offset: int = 1) -> datetime:
    """面试时间：默认第二天 09:00，`day_offset` 可改成今天(0)/后天(2)。

    2026-11-13 实测：客户说「后天面试是吧」，系统回「明天（11月14日）」。
    原来这里写死 +1 天，客户说什么都不影响。
    """
    base = now or datetime.now(TZ)
    if base.tzinfo is None:
        base = base.replace(tzinfo=TZ)
    offset = max(int(day_offset or 0), 0)
    return (base + timedelta(days=offset)).replace(hour=9, minute=0, second=0, microsecond=0)


# 「大后天」必须排在「后天」前面，否则只匹配到「后天」
_DAY_WORDS = (("大后天", 3), ("后天", 2), ("明天", 1), ("今天", 0))


def extract_day_offset(text: str) -> int | None:
    """客户这句话里说的是哪天。没说返回 None（走默认的明天）。"""
    value = text or ""
    for word, offset in _DAY_WORDS:
        if word in value:
            return offset
    return None


def day_label(when: datetime, now: datetime | None = None) -> str:
    """日期标签按实际差天数说「今天/明天/后天」，差得远就直接写日期。"""
    base = now or datetime.now(TZ)
    if base.tzinfo is None:
        base = base.replace(tzinfo=TZ)
    days = (when.date() - base.date()).days
    prefix = {0: "今天", 1: "明天", 2: "后天", 3: "大后天"}.get(days)
    if prefix:
        return f"{prefix}（{when.month}月{when.day}日）"
    return f"{when.month}月{when.day}日"


# ── 话术 ──────────────────────────────────────────────
# 本轮请求拿到的 4222 真实岗位（api_flow 注入），用 ContextVar 隔离并发请求。
# 岗位数据源只有这一处；城市查不到就返回空，上层走「帮你问问」。
_REMOTE_JOBS: ContextVar[dict[str, list[dict[str, str]]]] = ContextVar(
    "remote_jobs", default={}
)


def set_remote_jobs(jobs_by_city: dict[str, list[dict[str, str]]]) -> None:
    """注入本轮可用的远端岗位（api_flow 在调引擎前调一次，无远端数据传空 dict）。"""
    _REMOTE_JOBS.set(jobs_by_city or {})


def jobs_for_city(city: str) -> list[dict[str, str]]:
    """统一取岗位入口：只认本轮注入的远端岗位，查不到返回空列表。"""
    city = str(city or "")
    return _REMOTE_JOBS.get().get(city, [])


def remote_job_cities() -> list[str]:
    """本轮注入了远端岗位的城市（给 LLM 简报合并用）。"""
    return list(_REMOTE_JOBS.get().keys())


def _jobs_of(slots: dict[str, Any]) -> list[dict[str, str]]:
    return jobs_for_city(str(slots.get("city") or ""))


def _job_of(slots: dict[str, Any]) -> dict[str, str]:
    jobs = _jobs_of(slots)
    if not jobs:
        return {}
    index = int(slots.get("job_index") or 0)
    return jobs[min(index, len(jobs) - 1)]


def _city_ask(slots: dict[str, Any] | None = None) -> str:
    del slots
    cities = "、".join(remote_job_cities())
    if cities:
        return f"你投递的是哪个城市的简历？我们这边{cities}都有厂在招。"
    return "你投递的是哪个城市的简历？"


def _factory(job: dict[str, str]) -> str:
    if job.get("factory_name"):
        return str(job["factory_name"])
    # 远端契约里 factory_name 必有；兜底从 job_title 拆（「厂名 岗位」取前半截）
    return str(job.get("job_title", "")).split(" ")[0]


def interview_window_of(job: dict[str, Any]) -> str:
    """该岗位真实面试时段。运营在岗位/工厂数据里填了就用，没填才用默认。

    2026-11-13 实测：深圳地铁真实是「周一至周六 上午11:00-12:00、下午14:00-17:00」，
    系统却发「明天 09:00-11:00」——因为窗口写死成常量，岗位数据里的值没读。
    """
    value = str(job.get("interview_time") or "").strip()
    return value or INTERVIEW_WINDOW


def send_info_parts(
    slots: dict[str, Any], when: datetime | None = None, now: datetime | None = None
) -> list[str]:
    """工作信息多段文本：段1 岗位事实，段2 面试地点+时间窗口，段3 邀约问句。

    这三段必须**由代码拼**，不能交给模型——工价一改就是事故。

    卡片标题和字段顺序来自品类配置（vertical.config_json）：
      factory → employer_label=工厂，字段 工价/班次/吃住/年龄/纹身要求
      subway  → employer_label=线路，字段 薪资/班次/身高要求/纹身要求/安排线路
    以前写死成工厂的五段，地铁的「安排线路」没处放，只能挤进「吃住」那一行。
    """
    job = _job_of(slots)
    if not job:
        return [_city_ask(slots)]
    when = when or next_interview(now, _day_offset_of(slots))
    day = day_label(when, now)
    part1 = "\n".join(_job_card_lines(job))
    part2 = f"面试地点：{job.get('place', '')}\n面试时间：{day} {interview_window_of(job)}"
    part3 = _interview_ask(slots)
    return [part1, part2, part3]


def _job_card_lines(job: dict[str, Any]) -> list[str]:
    """按品类 schema 拼卡片。schema 缺失时退回工厂的五段，保持旧行为。"""
    title = str(job.get("job_title") or "")
    kind = title.split(" ")[-1] if " " in title else title
    # 「厂名」/「线路」由品类给；老数据没有 vertical_id 时按名字猜
    default_label = "线路" if _looks_subway(job) else "厂名"
    employer_label = str(job.get("employer_label") or default_label)
    lines = [f"{employer_label}：{_factory(job)}（{kind}）"]

    schema = job.get("position_schema")
    if isinstance(schema, list) and schema:
        for field in schema:
            if not isinstance(field, dict):
                continue
            key = str(field.get("key") or "")
            label = str(field.get("label") or "")
            value = str(job.get(key) or "").strip()
            # 空字段不出现：「吃住：」后面空着比不写更奇怪
            if key and label and value:
                lines.append(f"{label}：{value}")
        return lines

    # 老路径（没有 schema）：保持原来的五段
    for label, key in (
        ("工价", "wage_text"),
        ("班次", "hours_text"),
        ("年龄", "age_text"),
        ("吃住", "welfare_text"),
    ):
        value = str(job.get(key) or "").strip()
        if value:
            lines.append(f"{label}：{value}")
    return lines


def _looks_subway(job: dict[str, Any]) -> bool:
    text = f"{job.get('factory_name') or ''}{job.get('job_title') or ''}"
    return "地铁" in text or "安检" in text


def _day_offset_of(slots: dict[str, Any]) -> int:
    """客户说的「后天」记在 slots 里；没说就是默认的明天。"""
    try:
        return int(slots.get("interview_day_offset") or 1)
    except (TypeError, ValueError):
        return 1


def _interview_ask(slots: dict[str, Any] | None = None) -> str:
    """邀约问句。连续追问时换说法，不把同一句连发三遍。

    2026-11-13 实测：客户答非所问，系统把同一句「这两天能不能过来面试」
    连发了 3 次。这里按重问次数轮换，第 3 次之后再回到第一句。
    """
    retries = int((slots or {}).get("ask_retries") or 0)
    variants = (
        "这两天能不能过来面试？能来的话我把名额给你留着。",
        "你看是明天还是后天方便过来？我好提前给你登记。",
        "要是这两天来不了也没事，你说个大概时间，我给你留着名额。",
    )
    return variants[retries % len(variants)]


def _collect_ask(missing: str = "") -> str:
    if missing == "name":
        return "方便留个姓名吗？我这边登记一下。"
    if missing == "phone":
        return "手机号也发我一下，到面试那天好联系你。"
    return "那我登记一下：麻烦把姓名和手机号一起发我。"


def _gave_up_text() -> str:
    return "好的，那就不打扰你了。后面想过来的话随时找我，名额一直有。"


def _done_parts(
    slots: dict[str, Any],
    when: datetime | None = None,
    now: datetime | None = None,
) -> list[str]:
    job = _job_of(slots)
    when = when or next_interview(now, _day_offset_of(slots))
    day = day_label(when, now)
    who = " ".join(
        part for part in (str(slots.get("name") or ""), str(slots.get("phone") or "")) if part
    )
    detail = f"{day} {interview_window_of(job)} 在{job.get('place', '')}面试"
    head = f"好嘞，登记好了：{who}，{detail}。" if who else f"好嘞，{detail}。"
    return [head, "期待你来面试，到了联系我。"]


def _faq_retry(stage: str, slots: dict[str, Any]) -> str:
    if stage == STAGE_COLLECT:
        return _collect_prompt(slots) or _interview_ask(slots)
    return _interview_ask(slots)


# ── 主流程 ────────────────────────────────────────────
def _absorb(slots: dict[str, Any], text: str, strict_name: bool = False) -> None:
    """顺手把客户自报的档案字段记下来（问城市那一轮也常一起报）。"""
    phone = extract_phone(text)
    if phone:
        slots["phone"] = phone
    name = extract_name(text, strict=strict_name)
    if name:
        slots["name"] = name
    province = extract_province(text)
    if province:
        slots["province"] = province
    district = extract_district(text)
    if district:
        slots["district"] = district
    age = extract_age(text)
    if age:
        slots["age"] = age


def absorb_profile(slots: dict[str, Any], text: str, strict_name: bool = False) -> None:
    """公开版档案抽取：config 话术命中时 api_flow 也要照常记客户顺口报的姓名电话。"""
    _absorb(slots, text, strict_name=strict_name)


def _no_job_parts(city: str) -> list[str]:
    return [
        f"已记下，你找{city}的厂。我帮你问问这边有没有合适的岗位，有消息马上回你。"
    ]


def enter_info_result(
    slots: dict[str, Any],
    when: datetime | None = None,
    now: datetime | None = None,
) -> FlowResult:
    """拿到城市后由代码发工作信息（多段）。

    该城市在 4222 岗位库查不到时：不编岗位，回「已记下，帮你问问」并把需求
    记成未知问题（由运营补话术/补数据）。阶段保持 ask_city、不发面试邀约，
    等岗位数据补上后客户再提城市就能正常走发信息流程。
    """
    city = str(slots.get("city") or "")
    if not jobs_for_city(city):
        return FlowResult(
            reply="",
            parts=_no_job_parts(city),
            stage=STAGE_ASK_CITY,
            slots=slots,
            unknown_question=f"{city}有哪些厂在招" if city else "客户没说清想找哪个城市的厂",
        )
    slots["interview_offer_sent"] = True
    return FlowResult(
        reply="",
        parts=send_info_parts(slots, when, now),
        stage=STAGE_ASK_INTERVIEW,
        slots=slots,
    )


def _book(slots: dict[str, Any], when: datetime, now: datetime | None = None) -> FlowResult:
    job = _job_of(slots)
    slots["interview_at"] = when.isoformat()
    slots["interview_window"] = interview_window_of(job)
    slots["interview_place"] = job.get("place", "")
    slots["interview_agreed"] = True
    slots["booked"] = True
    return FlowResult(
        reply="",
        parts=_done_parts(slots, when, now),
        stage=STAGE_DONE,
        slots=slots,
        finished=True,
        action=ACTION_BOOK,
    )


def step(
    state: dict[str, Any],
    text: str,
    now: datetime | None = None,
    kb_answer: str | None = None,
) -> FlowResult:
    """推进一轮对话。state 会被就地更新，返回值同时带上新 state。

    `kb_answer` 是调用方（api_flow）先查知识库拿到的答案：本模块不碰数据库，
    保证纯函数可单测。为 None 表示没命中。
    """
    text = (text or "").strip()
    stage = str(state.get("stage") or STAGE_ASK_CITY)
    slots: dict[str, Any] = state.setdefault("slots", {})
    state["turns"] = int(state.get("turns") or 0) + 1
    # 客户说了「后天/明天/今天」就按他的来，没说才用默认的明天
    day_offset = extract_day_offset(text)
    if day_offset is not None:
        slots["interview_day_offset"] = day_offset
    when = next_interview(now, _day_offset_of(slots))

    if stage == STAGE_DONE:
        return FlowResult(reply="", stage=STAGE_DONE, slots=slots, finished=True)

    # kb 只是插问的暂存标签，真进来就按"面试邀约"继续
    if stage == STAGE_KB:
        stage = STAGE_ASK_INTERVIEW
        state["stage"] = stage

    if stage == STAGE_ASK_CITY:
        city = extract_city(text) or str(slots.get("city") or "")
        if not city:
            return FlowResult(reply=_city_ask(slots), stage=STAGE_ASK_CITY, slots=slots)
        slots["city"] = city
        slots.setdefault("job_index", 0)
        _absorb(slots, text)
        result = enter_info_result(slots, when, now)
        state["stage"] = result.stage
        return result

    if stage == STAGE_SEND_INFO:
        _absorb(slots, text)
        result = enter_info_result(slots, when, now)
        state["stage"] = result.stage
        return result

    if stage == STAGE_ASK_INTERVIEW:
        _absorb(slots, text)
        # 拒绝优先：客户说「这两天不行」里也含「行」，顺序反了就会误约
        if is_disagree(text):
            slots["recruit_status"] = "disqualified"
            state["stage"] = STAGE_DONE
            return FlowResult(
                reply=_gave_up_text(),
                stage=STAGE_DONE,
                slots=slots,
                finished=True,
                action=ACTION_GAVE_UP,
            )
        if is_agree(text) and not looks_like_question(text):
            return _agree_interview(state, slots, when, now)
        # 插问（体检 / 住宿 / 地点）：先答，答完还停在邀约
        if kb_answer or looks_like_question(text):
            return _answer_side_question(state, stage, slots, text, kb_answer)
        if is_agree(text):
            return _agree_interview(state, slots, when, now)
        # 答非所问：换一种说法重问，不把同一句连发三遍
        slots["ask_retries"] = int(slots.get("ask_retries") or 0) + 1
        return FlowResult(reply=_interview_ask(slots), stage=stage, slots=slots)

    if stage == STAGE_COLLECT:
        _absorb(slots, text, strict_name=True)
        prompt = _collect_prompt(slots)
        if not prompt:
            result = _book(slots, when, now)
            state["stage"] = result.stage
            return result
        if not (slots.get("name") or slots.get("phone")):
            # 一个字段都没给：可能是在问事，先答再要一次
            answered = _answer_side_question(state, stage, slots, text, kb_answer)
            if answered.parts:
                return answered
        return FlowResult(reply=prompt, stage=STAGE_COLLECT, slots=slots)

    # 未知阶段：兜底回到问城市
    state["stage"] = STAGE_ASK_CITY
    return FlowResult(reply=_city_ask(slots), stage=STAGE_ASK_CITY, slots=slots)


def _collect_prompt(slots: dict[str, Any]) -> str:
    """collect 的第一次问必须一次要两个；只缺一个时才单独追。"""
    has_name = bool(str(slots.get("name") or ""))
    has_phone = bool(str(slots.get("phone") or ""))
    if has_name and has_phone:
        return ""
    if has_name:
        return _collect_ask("phone")
    if has_phone:
        return _collect_ask("name")
    return _collect_ask()


def _agree_interview(
    state: dict[str, Any],
    slots: dict[str, Any],
    when: datetime,
    now: datetime | None = None,
) -> FlowResult:
    """客户答应来：姓名手机都在就直接约成，缺一个就进 collect 只要缺的那个。"""
    slots["interview_agreed"] = True
    state["stage"] = STAGE_COLLECT
    prompt = _collect_prompt(slots)
    if prompt:
        return FlowResult(reply=prompt, stage=STAGE_COLLECT, slots=slots)
    result = _book(slots, when, now)
    state["stage"] = result.stage
    return result


def _answer_side_question(
    state: dict[str, Any],
    stage: str,
    slots: dict[str, Any],
    text: str,
    kb_answer: str | None,
) -> FlowResult:
    """插问分支：命中知识库就答，没命中就兜底并交回原话给上层记账。"""
    if kb_answer:
        return FlowResult(
            reply="",
            parts=[kb_answer, _faq_retry(stage, slots)],
            stage=stage,
            slots=slots,
        )
    if looks_like_question(text):
        return FlowResult(
            reply="",
            parts=["这个我确认一下，稍后回你", _faq_retry(stage, slots)],
            stage=stage,
            slots=slots,
            unknown_question=text,
        )
    # 含糊的一句（「嗯」「哦」）：只把该问的重问一次，不记未知问题
    followup = _faq_retry(stage, slots)
    state["stage"] = stage
    return FlowResult(reply=followup, stage=stage, slots=slots)

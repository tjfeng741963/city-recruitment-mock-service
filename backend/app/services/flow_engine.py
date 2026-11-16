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

from .flow_graph import entry_node, node_body, pick_next
from .question_topics import is_non_wage_cost_question

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

# 岗位话术的 stage 取值（4222 config.position_scripts 的冻结契约）。
# 与流程 stage 同名是巧合：这些是「话术挂在哪个时点」，不是会话阶段。
SCRIPT_STAGE_GREET = "greet"
SCRIPT_STAGE_SEND_INFO = "send_info"
SCRIPT_STAGE_ASK_INTERVIEW = "ask_interview"
SCRIPT_STAGE_BOOKED = "booked"
SCRIPT_STAGE_UNANSWERED = "unanswered"

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
# 2026-11-15 真实聊天记录复盘：「宿舍几人间」「多大年龄能做」「一天上几个小时」
# 「体检费谁出」都因为不含标记词被判成陈述句，直接掉进「答非所问 → 再邀约」。
_QUESTION_MARKS = (
    "?", "？", "吗", "呢", "多少", "怎么", "怎样", "能不能", "可不可以",
    "行不行", "有没有", "要不要", "是不是", "什么", "几点", "多久", "几号", "哪里", "在哪",
    "多大", "几个", "几天", "几人间", "几岁", "几小时", "可不可以",
    "几天休", "包不包", "扣不扣", "管不管",
)

# 姓名抽取时要排掉的词：两个汉字的常用词太多，不排就会把「手机」当人名
_NAME_STOPWORDS = {
    "广州", "深圳", "东莞", "番禺", "天河", "白云", "龙华", "宝安", "龙岗", "长安", "虎门",
    "手机", "电话", "号码", "联系", "方式", "微信", "你好", "在吗", "可以", "没有", "明天",
    "今天", "后天", "男生", "女生", "普工", "面试", "工厂", "我们", "我是", "名字", "姓名",
    # P1-3：纯确认词/时段词/日期词不得入 name（「确认」「下午吧」曾被当成姓名）
    "确认", "好的", "好嘞", "行吧", "嗯嗯", "上午", "下午", "晚上", "早上", "中午",
    "大后天", "上午吧", "下午吧", "晚上吧", "好的呢", "可以的",
}

# 姓名候选里出现这些字样直接否掉（覆盖组合词，如「下午两点吧」）
_NAME_BANNED_SUBSTR = ("上午", "下午", "晚上", "早上", "中午", "明天", "今天", "后天",
                       "确认", "手机", "电话", "号码", "面试", "工厂", "报名", "登记",
                       "注册", "咨询", "了解", "想",
                       # P1-5：改期口语句被当成姓名（实测「能改天吗」被登记成姓名）
                       "改天", "改期", "改到", "提前", "晚点", "推后", "推迟", "有事",
                       # P1-6：问句里的名词被当成姓名（「工资多少」→ 姓名=工资多少）
                       "工资", "多少", "几", "钱", "上班", "时间", "地点", "线路", "收到",
                       "谢谢", "在吗", "你好", "在不在")
# 语气尾巴：带这些结尾的 token 是口语应答不是人名
_NAME_TAIL_CHARS = ("吧", "呀", "呢", "嘛", "啊", "哈", "哦", "噢", "了", "的", "呗", "啦")


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
    # 本轮内容来源：script=运营话术 / card=代码拼卡 / fact=岗位事实 /
    # collect=代码生成的必填资料提示 / kb=知识库原文直答 / 空串=其他。
    # 给审核循环（flow_llm.review_loop）区分「话术只能过或打回渲染层」用。
    source: str = ""
    # 本轮诊断信息，只用于事后复盘，**不下发客户端**（不进 to_dict）。
    # 灰度测试要求「每条回复都能查到为什么这么回」，所以在这里攒，
    # 由 api_flow 一并写进 EVENT_REPLY 的 body。
    trace: dict[str, Any] = field(default_factory=dict)

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
        # 节点化编排：当前所在的节点 key。空串 = 还没进节点图（老会话 / 没配节点），
        # 此时 step() 继续按 stage 走原有 if/elif 分支，行为与改造前完全一致。
        "node": "",
    }


# ── 抽取 ──────────────────────────────────────────────
# 运行时城市/区县表，由 api_flow 每轮从 4222 注入（GET /api/v1/agent/cities）。
# 硬编码别名只覆盖最早对接的 3 个城市；运营在后台新建的城市靠这张表才认得出来。
# [(别名, 城市名), ...]，长别名排前面，避免「广州市」被「广州」先吃掉。
_REMOTE_PLACES: ContextVar[list[tuple[str, str]]] = ContextVar(
    "remote_places", default=[]
)

# 后台「周边城市设置」配的关系：{城市: [周边城市, ...]}。
# 主城查不到岗位时按这份列表再查一次，解决「东莞没单 → 推广州」这种真实场景。
_REMOTE_NEIGHBORS: ContextVar[dict[str, list[str]]] = ContextVar(
    "remote_neighbors", default={}
)


def set_remote_cities(items: list[dict[str, Any]] | None) -> None:
    """注入后台维护的城市与区县。失败时传空列表，退回硬编码别名。"""
    places: list[tuple[str, str]] = []
    neighbors: dict[str, list[str]] = {}
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
        raw_neighbors = item.get("neighbors")
        if isinstance(raw_neighbors, list):
            clean = [str(n or "").strip() for n in raw_neighbors]
            clean = [n for n in clean if n and n != city]
            if clean:
                neighbors[city] = clean
    places.sort(key=lambda pair: len(pair[0]), reverse=True)
    _REMOTE_PLACES.set(places)
    _REMOTE_NEIGHBORS.set(neighbors)


def neighbors_of(city: str) -> list[str]:
    """该城市配置的周边城市；没配返回空列表。"""
    return list(_REMOTE_NEIGHBORS.get().get(str(city or "").strip(), []))


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
        if not (2 <= len(token) <= 4) or token in _NAME_STOPWORDS:
            continue
        # P1-3 守卫：时段/日期/确认字样与语气尾巴都不是人名
        if token.endswith(_NAME_TAIL_CHARS):
            continue
        if any(word in token for word in _NAME_BANNED_SUBSTR):
            continue
        return token
    return ""


def extract_name(text: str, strict: bool = False) -> str:
    """抽姓名。

    strict=False 只认明确线索（「我叫张三」）——问城市那一轮把「广州」当人名的坑踩过。
    strict=True 才敢把光秃秃的「张三」当名字，用在 collect 阶段。
    """
    # 显式称谓模式（「王先生」「李女士」）在任何阶段都算明确姓名线索
    match = re.search(r"[\u4e00-\u9fa5]{1,3}(?:先生|女士|小姐)", text or "")
    if match:
        return match.group(0)
    for cue in ("我叫", "名字叫", "姓名叫", "姓名是", "我是"):
        if cue in text:
            name = _name_token(text.split(cue, 1)[1])
            if name:
                return name
    return _name_token(text) if strict else ""


def extract_age(text: str) -> int | None:
    match = re.search(r"(\d{2})\s*(?:岁|周岁)", text)
    return int(match.group(1)) if match else None


# 纯打招呼/确认收到的话：不是「答应面试」，只是礼貌开场。
# 默认边里含「好」，不排掉的话客户回一句「你好」会被当成同意，直接跳到要姓名电话。
_BARE_GREETING = ("你好", "您好", "在吗", "在不在", "在么", "收到", "谢谢")


def _is_bare_greeting(text: str) -> bool:
    value = (text or "").strip().strip("，,。.！!~～ ")
    return value in _BARE_GREETING


def is_agree(text: str) -> bool:
    if any(word in text for word in _DISAGREE):
        return False
    if looks_like_question(text) or _is_bare_greeting(text):
        return False
    # 长句只认客户本人明确承诺来面试；不能去掉长度限制后仅凭「去/可以」
    # 把朋友、条件句或尚未决定的计划都登记成同意。
    if any(word in text for word in ("如果", "要是", "可能", "考虑", "不一定", "再看", "的话")):
        return False
    value = (text or "").strip().strip("，,。.！! ")
    if re.fullmatch(
        r"(?:(?:可以|好的|没问题)[，, ]*)?我(?:准备|打算|决定)?"
        r"(?:大后天|后天|明天|今天|周[一二三四五六日天]|星期[一二三四五六日天])?"
        r"(?:早上|上午|中午|下午|晚上)?(?:会|要|就|可以|准备|打算|决定|愿意|能)?"
        r"(?:过去|过来|去|来|到)[^，,。.!！?？\n]{0,30}面试",
        value,
    ):
        return True
    # 「好几号到？」这种长句里的「好」不算答应，短句才算
    return len(text) <= 12 and any(word in text for word in _AGREE)


# P2-7：长句表态（「行 这个可以 明天下午面试」）也是同意面试。
# 宽松判定：明确同意词 + 面试/到场意向，且不含第三方/条件/疑问信号。
_STRONG_AGREE = ("可以", "好的", "好呀", "好啊", "好嘞", "行", "没问题", "方便", "能来",
                 "嗯", "ok", "OK", "Ok", "准时", "确认")
_CONSENT_BLOCKERS = ("朋友", "同事", "别人", "亲戚", "家人", "如果", "要是", "可能",
                     "考虑", "不一定", "再看", "的话", "有空", "领导")
_CONSENT_INTENT = ("面试", "过去", "过来", "到厂", "到场", "上班")


def agrees_to_interview(text: str) -> bool:
    """同意面试的完整判定：短句沿用 is_agree，长句表态也接得住。"""
    if is_agree(text):
        return True
    value = (text or "").strip()
    if not value or len(value) > 30:
        return False
    if looks_like_question(value) or _is_bare_greeting(value) or is_disagree(value):
        return False
    if any(word in value for word in _CONSENT_BLOCKERS):
        return False
    return (
        any(word in value for word in _STRONG_AGREE)
        and any(word in value for word in _CONSENT_INTENT)
    )


# P0-2：拒绝词句里混着意向/登记/询问信号时不判拒（「算了 就这个吧 怎么面试」）。
_REFUSAL_REGISTER_SIGNALS = ("登记", "报名", "就这个", "这个吧", "怎么面试", "怎么报名",
                             "怎么过去", "怎么去", "再来")
_REFUSAL_ASK_SIGNALS = ("想了解", "工资", "多少钱", "工价", "待遇", "薪资", "福利")


def mixed_refusal(text: str) -> bool:
    """拒绝词命中，但句子里同时有意向/登记/询问信号 → 不是真拒绝。"""
    if not is_disagree(text):
        return False
    return (
        any(s in text for s in _REFUSAL_REGISTER_SIGNALS)
        or any(s in text for s in _REFUSAL_ASK_SIGNALS)
    )


# done 复活时必须排除的纯确认/应答词：这些不是面试意向（「收到」「好的」不算）
_BARE_CONFIRM = ("好", "好的", "好嘞", "好吧", "行", "行吧", "可以", "可以的", "确认",
                 "嗯", "嗯嗯", "哦", "噢", "哦哦", "要", "要得", "中", "同意", "没问题",
                 "收到", "谢谢", "嗯呢", "好的呢")


def _is_bare_confirm(text: str) -> bool:
    value = (text or "").strip().strip("，,。.！!？?~～ ")
    return value in _BARE_CONFIRM


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


# 本轮设备的岗位级硬编码话术（api_flow 每轮注入 set_position_scripts）。
# 放 ContextVar 而不是函数参数：send_info_parts / _interview_ask / _book 这些
# 函数在状态机深处被调用，层层加参数会把签名污染到所有测试。
_POSITION_SCRIPTS: ContextVar[list[dict[str, Any]]] = ContextVar(
    "position_scripts", default=[]
)


def set_position_scripts(scripts: list[dict[str, Any]] | None) -> None:
    """注入本轮设备的岗位话术，失败（拉不到）传空列表即回退原逻辑。"""
    _POSITION_SCRIPTS.set(list(scripts or []))


def _stage_script(slots: dict[str, Any], stage: str) -> str:
    """取某个时点的岗位话术并渲染；没命中返回空串。

    延迟导入 device_scripts：它反向依赖本模块的 INTERVIEW_WINDOW，
    模块级互相 import 会成环。
    """
    scripts = _POSITION_SCRIPTS.get()
    if not scripts:
        return ""
    from .device_scripts import pick_position_script, render_script

    script = pick_position_script(scripts, int(slots.get("position_id") or 0), stage)
    if not script:
        return ""
    job = _job_of(slots)
    window = ""
    if stage == SCRIPT_STAGE_BOOKED and slots.get("interview_period"):
        window = str(slots.get("interview_window") or "")
    return render_script(
        str(script.get("content") or ""), job, window or interview_window_of(job)
    ).strip()


# ── 话术一次性（scripted_sent）───────────────────────────────────────
# greet / send_info / booked：整个会话只发一次；ask_interview：首次用话术，
# 之后由智能体/轮换说法接管。发过即记账在 slots["scripted_sent"]，该时点
# 此后永不命中，由后续来源（事实卡 → 知识库 → 智能体）接管。
# send_info 用 "send_info:<position_id>" 记账：客户换城市/换岗位允许重发
# 新岗位的卡，同一岗位只发一次。


def _script_sent_key(stage: str, slots: dict[str, Any]) -> str:
    if stage == SCRIPT_STAGE_SEND_INFO:
        return f"send_info:{int(slots.get('position_id') or 0)}"
    return stage


def _script_sent(slots: dict[str, Any], stage: str) -> bool:
    """该时点的话术是否已经发过（只读，不记账）。"""
    sent = slots.get("scripted_sent")
    return isinstance(sent, dict) and bool(sent.get(_script_sent_key(stage, slots)))


def _one_shot_script(slots: dict[str, Any], stage: str) -> str:
    """一次性话术：未发过 → 渲染并记账；发过 → 返回空串（由后续来源接管）。"""
    sent = slots.get("scripted_sent")
    if not isinstance(sent, dict):
        sent = {}
        slots["scripted_sent"] = sent
    key = _script_sent_key(stage, slots)
    if sent.get(key):
        return ""
    text = _stage_script(slots, stage)
    if text:
        sent[key] = True
    return text


def pin_position(slots: dict[str, Any], job: dict[str, Any]) -> int:
    """发卡这一刻把岗位 id 钉进 slots（来源：4222 岗位项的 position_id）。

    不从 job_index 事后推算：岗位列表会重排/换城，index 指向的可能已经不是
    客户看到的那一个；钉住 id，后续话术和知识库硬过滤才对得准同一个岗。
    返回钉住后的 position_id（缺失或无效时为 0）。
    """
    # 换岗必须替换整套身份；新岗位缺字段时不能沿用上家工厂的 id。
    for key in ("position_id", "employer_id", "location_id"):
        value = (job or {}).get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            slots[key] = value
        else:
            # slot_set 事件只记录仍在字典里的键，写 0 才能在下轮回放时清掉旧值。
            slots[key] = 0
    # 岗位事实快照：客户后续插问「工资/年龄/班次/吃住/地点」时，答案就在这份
    # 快照里——直接用它答，绝不进知识库（global 层条目没有厂归属，会答成
    # 别家厂的工价，2026-11-14 多情景实测即此）。
    # 体检/纹身等动态字段也属于本岗事实；仅保存可渲染的标量字段。
    snapshot = {
        key: str(value).strip()
        for key, value in (job or {}).items()
        if (
            isinstance(value, (str, int, float)) and not isinstance(value, bool)
            and key not in ("position_id", "employer_id", "location_id")
        )
    }
    snapshot = {k: v for k, v in snapshot.items() if v}
    slots["job_snapshot"] = snapshot
    try:
        return int(slots.get("position_id") or 0)
    except (TypeError, ValueError):
        return 0


def jobs_for_city(city: str) -> list[dict[str, str]]:
    """统一取岗位入口：只认本轮注入的远端岗位，查不到返回空列表。"""
    city = str(city or "")
    return _REMOTE_JOBS.get().get(city, [])


def remote_job_cities() -> list[str]:
    """本轮注入了远端岗位的城市（给 LLM 简报合并用）。"""
    return list(_REMOTE_JOBS.get().keys())


def _jobs_of(slots: dict[str, Any]) -> list[dict[str, str]]:
    return jobs_for_city(str(slots.get("city") or ""))


def distinct_places(slots: dict[str, Any]) -> list[str]:
    """当前城市/工厂下岗位的面试地点（基地）去重清单，按岗位顺序。"""
    places: list[str] = []
    for job in _jobs_of(slots):
        place = str(job.get("place") or "").strip()
        if place and place not in places:
            places.append(place)
    return places


def select_position_by_place(slots: dict[str, Any], text: str) -> bool:
    """客户报基地/面试地点（「陈村」「陈村基地」）时钉到对应岗位。

    地铁号一个工厂下多个基地（陈村/竹料），岗位卡按 place 区分。只在
    ask_city 或首句问过地点后用；抽不到地点就保持原岗位，不乱换。
    """
    value = (text or "").strip()
    if not value:
        return False
    for index, job in enumerate(_jobs_of(slots)):
        place = str(job.get("place") or "").strip()
        if not place:
            continue
        base = re.sub(r"(基地|中心|站|厂区|园区|分部)$", "", place)
        if place in value or (len(base) >= 2 and base in value):
            slots["job_index"] = index
            pin_position(slots, job)
            return True
    return False


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


_INTERVIEW_PERIODS = {"早上": "上午", "上午": "上午", "下午": "下午", "晚上": "晚上"}

# P1-4/P3-8：口语改口（「那就下午两点吧」「上午要上班」）里不能当场次选择的信号
_PERIOD_NOISE = re.compile(
    r"上班|加班|没空|有事|忙|朋友|别人|同事|亲戚|家人|领导|如果|要是|可能|考虑"
    r"|不一定|再看|的话|有空|改天|再说|问问|了解一下"
)

_CN_HOUR = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _time_point_hour(text: str) -> int | None:
    """从「两点 / 14:30 / 9点」里取具体时间点的小时数；没有返回 None。"""
    value = text or ""
    match = re.search(r"(\d{1,2})(?:点|:|：)", value)
    if match:
        hour = int(match.group(1))
        return hour if 0 <= hour < 24 else None
    match = re.search(r"([零一二两三四五六七八九十]+)点", value)
    if match:
        cn = match.group(1)
        if cn == "十":
            return 10
        if "十" in cn:
            head, _, tail = cn.partition("十")
            hour = _CN_HOUR.get(head, 0) * 10 + _CN_HOUR.get(tail, 0)
            return hour if 0 <= hour < 24 else None
        if cn in _CN_HOUR:
            return _CN_HOUR[cn]
    return None


def remember_interview_period(slots: dict[str, Any], text: str) -> bool:
    """只从本人确认或收集阶段的时段短答取偏好，不从班次问题取。

    P1-4/P3-8：口语改口（「那就下午两点吧」）也必须覆盖旧 period——
    问句、拒绝、带条件/第三方/忙碌信号的句子不当作场次选择。
    """
    value = (text or "").strip().strip("，,。.！! ")
    matched = bool(is_agree(value) or re.fullmatch(
        r"(?:我)?(?:大后天|后天|明天|今天)?(?:早上|上午|下午|晚上)(?:去|来|过去)?(?:面试)?(?:可以|方便)?", value
    ))
    if not matched:
        value = (text or "").strip().strip("，,。.！!？? ")
        if (
            not value or len(value) > 20 or looks_like_question(value)
            or is_disagree(value) or _PERIOD_NOISE.search(value)
        ):
            return False
    found = re.findall(r"早上|上午|下午|晚上", value)
    if len(set(_INTERVIEW_PERIODS[word] for word in found)) == 1:
        slots["interview_period"] = _INTERVIEW_PERIODS[found[0]]
        return True
    hour = _time_point_hour(value)
    if hour is not None:
        slots["interview_period"] = "上午" if hour < 12 else "下午" if hour < 18 else "晚上"
        return True
    return False


def _preferred_interview_window(job: dict[str, Any], period: str) -> tuple[str, int, int] | None:
    """从岗位配置的数字时间段选场次；无法确认就不编一个默认时间。"""
    for match in re.finditer(
        r"(?P<label>上午|早上|下午|晚上)?\s*(?P<h>\d{1,2})(?:[:：](?P<m>\d{2}))?点?\s*"
        r"(?:-|~|～|—|至|到)\s*(?P<end_label>上午|下午|晚上)?\s*"
        r"(?P<eh>\d{1,2})(?:[:：](?P<em>\d{2}))?点?", interview_window_of(job)
    ):
        hour, minute = int(match['h']), int(match['m'] or 0)
        end_hour, end_minute = int(match['eh']), int(match['em'] or 0)
        label = _INTERVIEW_PERIODS.get(match['label'] or "", "")
        end_label = match['end_label'] or label
        if label in {"下午", "晚上"} and 1 <= hour < 12:
            hour += 12
        if end_label in {"下午", "晚上"} and 1 <= end_hour < 12:
            end_hour += 12
        if not (0 <= hour < 24 and 0 <= end_hour < 24 and 0 <= minute < 60 and 0 <= end_minute < 60):
            continue
        actual = "上午" if hour < 12 else "下午" if hour < 18 else "晚上"
        if actual != period or (end_hour, end_minute) <= (hour, minute):
            continue
        return f"{period}{hour:02d}:{minute:02d}-{end_hour:02d}:{end_minute:02d}", hour, minute
    return None


def _published_windows(job: dict[str, Any]) -> str:
    """岗位公布的可用场次清单（「上午09:00-12:00、下午14:30-17:00」）。"""
    windows: list[str] = []
    for match in re.finditer(
        r"(?P<label>上午|早上|下午|晚上)?\s*(?P<h>\d{1,2})(?:[:：](?P<m>\d{2}))?点?\s*"
        r"(?:-|~|～|—|至|到)\s*(?P<end_label>上午|下午|晚上)?\s*"
        r"(?P<eh>\d{1,2})(?:[:：](?P<em>\d{2}))?点?", interview_window_of(job)
    ):
        hour, minute = int(match['h']), int(match['m'] or 0)
        end_hour, end_minute = int(match['eh']), int(match['em'] or 0)
        label = _INTERVIEW_PERIODS.get(match['label'] or "", "")
        end_label = match['end_label'] or label
        if label in {"下午", "晚上"} and 1 <= hour < 12:
            hour += 12
        if end_label in {"下午", "晚上"} and 1 <= end_hour < 12:
            end_hour += 12
        if not (0 <= hour < 24 and 0 <= end_hour < 24 and 0 <= minute < 60 and 0 <= end_minute < 60):
            continue
        if (end_hour, end_minute) <= (hour, minute):
            continue
        actual = "上午" if hour < 12 else "下午" if hour < 18 else "晚上"
        text = f"{actual}{hour:02d}:{minute:02d}-{end_hour:02d}:{end_minute:02d}"
        if text not in windows:
            windows.append(text)
    return "、".join(windows)


_PERIOD_ANCHOR = {"早上": 8, "上午": 9, "下午": 14, "晚上": 19}


def _closest_period(job: dict[str, Any], desired: str) -> str:
    """客户确认接受时，选与原意图最接近的已公布场次；没有公布时段返回空串。"""
    desired = _INTERVIEW_PERIODS.get(desired, desired)
    anchor = _PERIOD_ANCHOR.get(desired, 9)
    best, best_gap = "", None
    for period in ("上午", "下午", "晚上"):
        selected = _preferred_interview_window(job, period)
        if selected is None:
            continue
        gap = abs(selected[1] - anchor)
        if best_gap is None or gap < best_gap:
            best, best_gap = period, gap
    return best


def _first_published_window(job: dict[str, Any]) -> tuple[str, int, int] | None:
    """岗位公布的第一场（按上午/下午/晚上顺序）。客户没挑场次时用它定时刻。"""
    for period in ("上午", "下午", "晚上"):
        selected = _preferred_interview_window(job, period)
        if selected is not None:
            return selected
    return None


# 冲突追问的三种说法：同一个客户连问 4 次时不能把这句原样复读 4 遍
# （2026-11-15 复测：上午/下午冲突时逐字相同连发 4 次，客户以为机器人卡死）。
_PERIOD_CONFLICT_ASK = (
    "这个岗位的面试时间是：{published}。暂时无法确认{period}场，可选场次：{options}。哪个已公布的时段方便？",
    "目前只有{published}这一场，{period}场确实安排不了。要不就这场？你回「可以」我马上给你登记。",
    "再确认一下：{published}，这是这个岗位唯一在招的场次。能来的话回我一声，名额我先给你留着。",
)


def _period_conflict_text(
    slots: dict[str, Any], job: dict[str, Any], period: str, window: str
) -> str:
    options = _published_windows(job) or window
    slots["period_conflict"] = int(slots.get("period_conflict") or 0) + 1
    index = min(slots["period_conflict"], len(_PERIOD_CONFLICT_ASK)) - 1
    return _PERIOD_CONFLICT_ASK[index].format(
        published=options, period=period, options=options
    )


_SECTION_HEAD = re.compile(r"^【[^】]{1,12}】")
# 媒体标记不是段标题：【图片:厂门.jpg】 行必须跟着上一段走，
# 否则客户端会收到一个「只有标记、没有文字」的段（纯媒体段虽然能发，
# 但和文字拆成两条会让「文字说了发图」和「图」对不上）。
_MEDIA_HEAD = re.compile(r"^【(?:图片|视频)\s*[:：]")


def _starts_section(line: str) -> bool:
    value = str(line or "").strip()
    return bool(_SECTION_HEAD.match(value)) and not _MEDIA_HEAD.match(value)


def split_script_sections(text: str) -> list[str]:
    """把一段运营话术切成多条消息。

    为什么需要：运营在「岗位话术」里写的是【用人要求】【上班时间】【工资待遇】
    这样分好段的长文，客户端按 parts 逐条发送、条目之间有 2 秒间隔，看起来才是
    「一条一条发」。以前整段作为**一条**消息发出（2026-11-15 线上实测：三段要求
    糊成一坨），客户体验和人工客服对不上。

    切分规则（保守，宁可少切不乱切）：
      1. 以空行分段（运营最自然的写法）
      2. 以行首【标题】另起一段（没有空行时也能切开）
      3. 段内不拆句、不改字——工价一个字都不能动
      4. 只有一段时原样返回，不会把一句话拆散
    """
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    sections: list[str] = []
    for block in re.split(r"\n\s*\n", raw):
        block = block.strip("\n")
        if not block.strip():
            continue
        # 没有空行时，行首【标题】也要另起一段（媒体标记除外，它跟着上一段）
        current: list[str] = []
        for line in block.split("\n"):
            if _starts_section(line) and current and _starts_section(current[0]):
                sections.append("\n".join(current).strip())
                current = [line]
            else:
                current.append(line)
        if current:
            sections.append("\n".join(current).strip())
    return [section for section in sections if section.strip()]


def split_by_section_heads(text: str) -> list[str]:
    """只按行首【标题】切，**不按空行切**。

    给「模型组织的回复」用：模型经常把运营素材里的【用人要求】【上班时间】
    【工资待遇】塞进一条回复里，得拆开发；但模型自己的正文也会用空行分段，
    按空行切会把正常回复拆成碎片。标题明确出现 2 个以上才动手。
    """
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    sections: list[str] = []
    current: list[str] = []
    for line in raw.split("\n"):
        if _starts_section(line) and current and any(_starts_section(x) for x in current):
            sections.append("\n".join(current).strip())
            current = [line]
        else:
            current.append(line)
    if current:
        sections.append("\n".join(current).strip())
    sections = [section for section in sections if section.strip()]
    return sections if len(sections) > 1 else [raw]


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
    # 发卡：这一刻客户「选定」了岗位，把岗位 id 钉进 slots（后续话术/KB 都用它）
    pin_position(slots, job)
    scripted = _one_shot_script(slots, SCRIPT_STAGE_SEND_INFO)
    if scripted:
        # 岗位话术命中：按段落拆成多条发，模型不参与（工价一个字都不能被改写）。
        # 媒体标记【图片:x】原样留在正文里，客户端据此发图——切分只按空行/【标题】，
        # 标记永远留在段内，不会被拆断。
        # 单轮单源：只发话术这一段，不再拼一句邀约——邀约属于 ask_interview
        # 时点，由下一轮的追问（话术一次/智能体换说法）接管。
        return split_script_sections(scripted) or [scripted]
    when = when or next_interview(now, _day_offset_of(slots))
    day = day_label(when, now)
    part1 = "\n".join(_job_card_lines(job))
    part2 = f"面试地点：{job.get('place', '')}\n面试时间：{day} {interview_window_of(job)}"
    part3 = _interview_ask(slots)
    # 主城没单、按后台「周边城市设置」取到隔壁城市的岗：必须先说清楚在哪，
    # 否则客户以为是本地的，到面试地点才发现跨城。
    asked = str(slots.get("city") or "")
    job_city = str(job.get("city") or "")
    if asked and job_city and asked != job_city:
        part1 = f"{asked}这边暂时没有合适的厂，{job_city}有岗，过去方便的话可以安排。\n{part1}"
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
                # 值自带标签时不再套一层：4222 把地铁线路写进了 welfare_text
                # （src/modules/agent/profile.routes.ts），照抄会变成
                # 「吃住：安排线路：广东城际全线路」这种两层标签的怪句子。
                own = re.match(r"^([\u4e00-\u9fa5]{2,6})[:：]", value)
                lines.append(value if own and own.group(1) != label else f"{label}：{value}")
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
            # 值自带标签（「安排线路：…」被写进 welfare_text）时不再套「吃住：」
            own = re.match(r"^([\u4e00-\u9fa5]{2,6})[:：]", value)
            lines.append(value if own and own.group(1) != label else f"{label}：{value}")
    return lines


def _looks_subway(job: dict[str, Any]) -> bool:
    text = f"{job.get('factory_name') or ''}{job.get('job_title') or ''}"
    return "地铁" in text or "安检" in text


def _day_offset_of(slots: dict[str, Any]) -> int:
    """客户说的「后天」记在 slots 里；没说就是默认的明天。"""
    try:
        value = slots.get("interview_day_offset")
        return int(value) if value is not None else 1
    except (TypeError, ValueError):
        return 1


def _interview_ask(slots: dict[str, Any] | None = None) -> str:
    """邀约问句。话术一次性：首次用设备配置的 ask_interview 话术，之后由
    轮换说法接管，不重复原句原话术（答非所问由智能体/变体换说法追问）。

    连续追问时换说法，不把同一句连发三遍。
    2026-11-13 实测：客户答非所问，系统把同一句「这两天能不能过来面试」
    连发了 3 次。这里按重问次数轮换，第 3 次之后再回到第一句。
    """
    slots = slots or {}
    scripted = _one_shot_script(slots, SCRIPT_STAGE_ASK_INTERVIEW)
    if scripted:
        return scripted
    retries = int(slots.get("ask_retries") or 0)
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
    window = str(slots.get("interview_window") or interview_window_of(job))
    # P2-5 五要素：地方 + 工厂 + 姓名 + 电话 + 面试时间
    place = str(job.get("place") or "")
    factory = _factory(job) if job else ""
    if place and factory:
        where = f"在{place}的{factory}面试"
    else:
        where = f"在{place or factory}面试" if (place or factory) else "面试"
    detail = f"{day} {window} {where}"
    head = f"好嘞，登记好了：{who}，{detail}。" if who else f"好嘞，{detail}。"
    return [head, "期待你来面试，到了联系我。"]


def _faq_retry(stage: str, slots: dict[str, Any]) -> str:
    if stage == STAGE_COLLECT:
        return _collect_prompt(slots) or _interview_ask(slots)
    return _interview_ask(slots)


# ── 主流程 ────────────────────────────────────────────
def _absorb(slots: dict[str, Any], text: str, strict_name: bool = False) -> None:
    """顺手把客户自报的档案字段记下来（问城市那一轮也常一起报）。"""
    if strict_name and remember_interview_period(slots, text):
        strict_name = False
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


def acknowledge_contact_update(slots: dict[str, Any], text: str) -> str:
    """已约客户补发/更正姓名电话：记进 slots 并返回「已更新」话术，没变化返回空串。

    只在整句确实带手机号或明确姓名线索时才动档案——否则「工资多少」会被
    strict_name 抽成姓名「工资多少」并覆盖旧资料（2026-11-15 实测）。
    """
    phone = extract_phone(text)
    explicit_name = extract_name(text, strict=False)
    if not phone and not explicit_name:
        return ""
    before = (str(slots.get("name") or ""), str(slots.get("phone") or ""))
    _absorb(slots, text, strict_name=bool(explicit_name))
    after = (str(slots.get("name") or ""), str(slots.get("phone") or ""))
    if after != before and all(after):
        return f"收到，资料我更新好了：{after[0]} {after[1]}，面试安排不变，到了联系我。"
    return ""


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
    # 来源标记：send_info_parts 即将命中一次性话术时这轮是「运营话术」，
    # 审核循环据此放行原文案（B 无权改写）。判断要赶在 _one_shot_script 记账之前。
    scripted_now = bool(_stage_script(slots, SCRIPT_STAGE_SEND_INFO)) and not _script_sent(
        slots, SCRIPT_STAGE_SEND_INFO
    )
    return FlowResult(
        reply="",
        parts=send_info_parts(slots, when, now),
        stage=STAGE_ASK_INTERVIEW,
        slots=slots,
        source="script" if scripted_now else "card",
    )


def _book(
    slots: dict[str, Any],
    when: datetime,
    now: datetime | None = None,
    text: str = "",
) -> FlowResult:
    job = _job_of(slots)
    window = interview_window_of(job)
    period = str(slots.get("interview_period") or "")
    if period:
        selected = _preferred_interview_window(job, period)
        if selected is None:
            # P0-1/P1-4：冲突时客户改口的新时段优先覆盖；纯确认类就就近接受
            # 岗位公布的场次（在回复里明说实际时间），绝不永久卡死。
            remember_interview_period(slots, text)
            period = str(slots.get("interview_period") or "")
            selected = _preferred_interview_window(job, period) if period else None
            if selected is None and _is_bare_confirm(text):
                closest = _closest_period(job, period)
                if closest:
                    slots["interview_period"] = closest
                    period = closest
                    selected = _preferred_interview_window(job, period)
            if selected is None:
                return FlowResult(
                    reply=_period_conflict_text(slots, job, period, window),
                    stage=STAGE_COLLECT, slots=slots, source="collect",
                )
        window, hour, minute = selected
        when = when.replace(hour=hour, minute=minute)
    else:
        # 客户没挑场次：日期按默认，时刻必须是岗位公布的第一场，
        # 不能留 09:00 却对外说「14:00-16:00」（档案推送/到店提醒会对不上）。
        first = _first_published_window(job)
        if first is not None:
            when = when.replace(hour=first[1], minute=first[2])
    pin_position(slots, job)
    slots["interview_at"] = when.isoformat()
    slots["interview_window"] = window
    slots["interview_place"] = job.get("place", "")
    slots["interview_agreed"] = True
    slots["booked"] = True
    # 约好后的确认话术（面试地点在这里）：命中设备配置的 booked 话术就用它，
    # 一次性记账（整个会话只发一次；发过或没配都用代码拼的默认确认语）。
    # 两种情况都不经过模型。
    booked = _one_shot_script(slots, SCRIPT_STAGE_BOOKED)
    parts = [booked] if booked else _done_parts(slots, when, now)
    if period and booked and window not in booked:
        # 保留运营材料和媒体，只补上当前实际选中的场次。
        parts.insert(0, f"面试时间：{day_label(when, now)} {window}。")
    # 面试通知（点③）：后台在 base_sections.interview_notice 里写的是
    # 「先发前两条，回复了再发后三条」这类分条注意事项，以前全链路没人读它，
    # 客户约上了却收不到任何面试通知。这里在确认语之后按段落补发，整会话一次。
    notice = _interview_notice_parts(slots, job, window)
    if notice:
        slots["interview_notice_sent"] = True
        parts = [*parts, *notice]
    return FlowResult(
        reply="",
        parts=parts,
        stage=STAGE_DONE,
        slots=slots,
        finished=True,
        action=ACTION_BOOK,
        # 运营预约话术由渲染层定稿，审核不得再改写地点或媒体标记。
        source="script" if booked else "fact" if period else "",
    )


_RESCHEDULE_INTENT = ("改", "换", "调", "推迟", "推后", "顺延", "提前", "晚点", "早点",
                      "迟到", "晚到", "来不及", "赶不上", "有事")


def _interview_notice_parts(
    slots: dict[str, Any], job: dict[str, Any], window: str = ""
) -> list[str]:
    """约成后的面试通知：取岗位/后台配置的 notice 模板，渲染后按段拆开。

    为什么要有：客户约上面试后，运营在后台「面试通知模板」里写好注意事项
    （带什么证件、几点到、找谁），实际一条都没发出去。这段和岗位卡一样属于
    运营原文，占位符由代码替换，模型不参与改写。
    """
    if slots.get("interview_notice_sent"):
        return []
    template = str((job or {}).get("interview_notice") or "").strip()
    if not template:
        return []
    from .device_scripts import render_script

    rendered = render_script(template, job or {}, window or interview_window_of(job or {}))
    return split_script_sections(rendered)


def _reschedule_day(value: str) -> int | None:
    """改期句里的目标日期：优先取「改到/换到/推迟到」后面的那个词。

    「我明天有事，能改后天吗」里同时有明天和后天，取错就把客户改到明天了。
    """
    match = re.search(r"(?:改|换|调|推迟|顺延|推)(?:到|成|为)?\s*(大后天|后天|明天|今天)", value)
    if match:
        return extract_day_offset(match.group(1))
    found = re.findall(r"大后天|后天|明天|今天", value)
    return extract_day_offset(found[-1]) if found else None


def reschedule_interview(state: dict[str, Any], text: str, now: datetime | None = None) -> FlowResult | None:
    """已约客户要求改时间/改日期：识别口语改期，改不成就说清可选场次。

    2026-11-15 真实聊天记录复盘：人工客服对「我明天有事，能改后天吗」「能改到
    下午吗」「我晚点到」一律说「可以」，然后给硬截止并重发面试通知。原来的实现
    只认「面试改到后天下午」这一句机器话，真实说法 8 句里 7 句改不了，还会被
    「改天行不行」判成流失。
    """
    slots = state.setdefault("slots", {})
    if not slots.get("booked"):
        return None
    value = (text or "").strip().strip("，,。.！!？?~～ ")
    if not value or not any(word in value for word in _RESCHEDULE_INTENT):
        return None
    # 改的是联系方式/资料，不是时间：「电话改成139…」以前会被当改期吞掉。
    if re.search(r"电话|手机|号码|姓名|名字|微信|身份证", value):
        return None
    # 只是迟到/晚到，不是改预约：安抚 + 让他到了说一声，不动日期场次。
    if ("晚点" in value or "迟到" in value or "晚到" in value) and not any(
        word in value for word in ("改", "换", "调", "推迟", "顺延", "提前")
    ):
        return FlowResult(
            reply="可以，路上注意安全，到了给我发个消息，我在这边等你。",
            stage=STAGE_DONE, slots=slots, finished=True, source="fact",
        )
    offset = _reschedule_day(value)
    period_word = ""
    match = re.search(r"(?:改|换|调|推迟|顺延)(?:到|成|为)?\s*(早上|上午|下午|晚上)", value)
    if match:
        period_word = match.group(1)
    else:
        found = re.findall(r"早上|上午|下午|晚上", value)
        period_word = found[-1] if found else ""
    if not period_word:
        hour = _time_point_hour(value)
        if hour is not None:
            period_word = "上午" if hour < 12 else ("下午" if hour < 18 else "晚上")
    period = _INTERVIEW_PERIODS.get(period_word, "")
    if offset is None and not period:
        # 只说了「改天/能改吗」：问清哪天哪个时段，绝不因此判流失。
        # 但「我改主意了」「换了工作」这类不是改期，交回上层处理。
        if not re.search(r"改天|改期|换一天|改时间|推迟|提前|顺延|哪天|改到|换个时间", value):
            return None
        return FlowResult(
            reply="可以改，你想改到哪天、哪个时段？我按岗位公布的场次给你重新安排。",
            stage=STAGE_DONE, slots=slots, finished=True, source="fact",
        )
    # 只有成功选到岗位现有场次才能改原预约，失败时保留原日期/场次/完成状态。
    updated = dict(slots)
    if period:
        updated["interview_period"] = period
    if offset is not None:
        updated["interview_day_offset"] = offset
        when = next_interview(now, offset)
    else:
        try:
            when = datetime.fromisoformat(str(slots["interview_at"]))
        except (KeyError, ValueError):
            return None
    result = _book(updated, when, now, text=text)
    if result.stage != STAGE_DONE:
        return FlowResult(reply=result.reply, stage=STAGE_DONE, slots=slots, finished=True, source="fact")
    same = all(updated.get(key) == slots.get(key) for key in ("interview_at", "interview_window"))
    slots.update(updated)
    result.slots = slots
    if same:
        result.action = None
    return result


def explicit_city_change(
    state: dict[str, Any], text: str, now: datetime | None = None,
) -> FlowResult | None:
    """未预约客户明确换城：重选岗位并重新问意向，不继承旧岗的同意。"""
    slots = state.setdefault("slots", {})
    if state.get("stage") not in {STAGE_SEND_INFO, STAGE_ASK_INTERVIEW, STAGE_COLLECT} or slots.get("booked"):
        return None
    city = extract_city(text)
    if not city or not slots.get("city") or city == slots.get("city"):
        return None
    value = (text or "").strip().strip("，,。.！!？? ")
    # 只接明确的自报/改去城市；朋友所在城市、否定句不作为客户的新选择。
    if not re.fullmatch(
        rf"(?:我在|我想去|我要去|我去|我想在|换到|改去|想去|去)?{re.escape(city)}(?:市)?(?:找工作|找厂|上班|工作)?",
        value,
    ):
        return None
    slots.update({"city": city, "job_index": 0, "interview_offer_sent": False,
                  "interview_agreed": False, "booked": False,
                  "interview_at": "", "interview_place": "", "interview_window": "", "interview_period": ""})
    pin_position(slots, {})
    result = enter_info_result(slots, next_interview(now, _day_offset_of(slots)), now)
    state["stage"] = result.stage
    state["node"] = result.stage
    return result


def step(
    state: dict[str, Any],
    text: str,
    now: datetime | None = None,
    kb_answer: str | None = None,
    graph: dict[str, Any] | None = None,
) -> FlowResult:
    """推进一轮对话。state 会被就地更新，返回值同时带上新 state。

    `kb_answer` 是调用方（api_flow）先查知识库拿到的答案：本模块不碰数据库，
    保证纯函数可单测。为 None 表示没命中。

    `graph` 是节点图（flow_graph.load_graph 的返回值）。给了就按节点图的边决定
    下一步；没给（老调用方 / 测试 / 设备没配节点）就继续走下面写死的 if/elif，
    行为与改造前完全一致——这是「改造不改变行为」的保证。
    """
    text = (text or "").strip()
    stage = str(state.get("stage") or STAGE_ASK_CITY)
    slots: dict[str, Any] = state.setdefault("slots", {})
    state["turns"] = int(state.get("turns") or 0) + 1
    rescheduled = reschedule_interview(state, text, now)
    if rescheduled is not None:
        return rescheduled
    if stage == STAGE_DONE:
        # P0-2：done 不是黑洞——客户再报姓名/电话/登记意向时复活继续登记
        revived = revive_from_done(state, text, now)
        if revived is not None:
            return revived
        # 已约客户补发/更正姓名电话：记下来并明确回「已更新」，不再重复邀约。
        if slots.get("booked"):
            ack = acknowledge_contact_update(slots, text)
            if ack:
                return FlowResult(reply=ack, stage=STAGE_DONE, slots=slots,
                                  finished=True, source="fact")
        # 已约/已结束后客户还在问事（「面试到底在哪儿啊」）时不能空回复：
        # a_step 在 done 分支自己答，但确定兜底路径（本函数）以前直接返回
        # reply=""，客户端只能发一条空消息，客户看到的是机器人「装死」。
        if looks_like_question(text):
            fact = _job_fact_answer(slots, text)
            if fact:
                return FlowResult(reply="", parts=[fact], stage=STAGE_DONE,
                                  slots=slots, finished=True, source="fact")
            if kb_answer:
                return FlowResult(reply=kb_answer, stage=STAGE_DONE, slots=slots,
                                  finished=True, source="kb")
            if slots.get("booked"):
                # 问的事答不上也不能装死：把已约信息再说一遍，客户至少知道
                # 该去哪个基地、哪个时段（「我到了找谁」这类问题尤其如此）。
                when_txt = "，".join(
                    x for x in (str(slots.get("interview_window") or ""),
                                str(slots.get("interview_place") or "")) if x
                )
                extra = f"（{when_txt}）" if when_txt else ""
                return FlowResult(
                    reply=f"你之前已经约好面试啦{extra}，到了直接联系我就行~"
                          "有其他想了解的也随时问我。",
                    stage=STAGE_DONE, slots=slots, finished=True, source="fact",
                )
        return FlowResult(reply="", stage=STAGE_DONE, slots=slots, finished=True)
    # 客户说了「后天/明天/今天」就按他的来，没说才用默认的明天
    day_offset = extract_day_offset(text)
    if day_offset is not None:
        slots["interview_day_offset"] = day_offset
    when = next_interview(now, _day_offset_of(slots))

    changed = explicit_city_change(state, text, now)
    if changed is not None:
        return changed

    # 首轮 greet 已发卡时仍是 send_info；拒绝也必须先于材料 FAQ 和节点路由。
    if (
        (stage in (STAGE_ASK_INTERVIEW, STAGE_COLLECT) or
         (stage == STAGE_SEND_INFO and slots.get("interview_offer_sent")))
        and not slots.get("booked") and is_disagree(text) and not looks_like_question(text)
    ):
        # P0-2：拒绝词句里混着意向/登记/询问信号时不判拒，走正常分支
        handled = _handle_mixed_refusal(state, slots, text, stage, when, now, kb_answer)
        if handled is not None:
            return handled
        return _decline_interview(state, slots)

    # 明确同意优先于节点的材料 FAQ；greet 发完卡仍在 send_info 也须能接住。
    if (
        (stage == STAGE_ASK_INTERVIEW or
         (stage == STAGE_SEND_INFO and slots.get("interview_offer_sent")))
        and agrees_to_interview(text)
    ):
        remember_interview_period(slots, text)
        _absorb(slots, text)
        return _agree_interview(state, slots, when, now, text=text)

    # ── 节点化编排 ──────────────────────────────────────────────────────
    # 有节点图且当前节点能走出去，就按图的边决定下一步；走不出去（没配边、
    # 或节点图里根本没这个节点）就落到下面的写死分支兜底。
    #
    # 为什么放在 done 之后：done 是「结束」语义，节点图里也有 done 节点，
    # 但「已经结束」的会话不该被任何边重新拉起，这是硬约束。
    # 当前节点：优先用显式记录的 node，没有就用当前 stage。
    # 为什么必须兜到 stage：node 没有对应的事件类型，project() 回放后永远是空串，
    # 拿空串去查图会每轮都退回 entry 节点——地铁号（入口 ask_city）永远走不出
    # 问城市，工厂号（入口 send_info）永远在重发岗位卡。
    # 默认节点的 node_key 与 stage 常量同名（见 029_flow_nodes.sql），所以 stage 可直接当 node。
    node = str(state.get("node") or "") or stage
    routed = _route_by_graph(graph, node, text, slots, state, when, kb_answer)
    if routed is not None:
        return routed
    # ────────────────────────────────────────────────────────────────────

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
        # 首句问过地点时客户会答「陈村基地」：不按地点选岗就永远发 jobs[0]，
        # 陈村客户收到竹料的卡。
        select_position_by_place(slots, text)
        _absorb(slots, text)
        result = enter_info_result(slots, when, now)
        state["stage"] = result.stage
        return result

    if stage == STAGE_SEND_INFO:
        _absorb(slots, text)
        # 岗位卡已经发过（首句 greet 直接发过 / 上一轮已发）：不能再整段重发一遍。
        # 2026-11-14 实测：新好友收到岗位卡后问「多少钱」，系统把整张卡又发了一次，
        # 客户连收两遍同样的岗位信息，真正问的问题一个字没答。
        # 这时的正确动作是：先答客户问的（KB），没命中就推进到面试邀约。
        if slots.get("interview_offer_sent"):
            state["stage"] = STAGE_ASK_INTERVIEW
            return _answer_side_question(
                state, STAGE_ASK_INTERVIEW, slots, text, kb_answer
            )
        result = enter_info_result(slots, when, now)
        state["stage"] = result.stage
        return result

    if stage == STAGE_ASK_INTERVIEW:
        _absorb(slots, text)
        # 拒绝优先：客户说「这两天不行」里也含「行」，顺序反了就会误约
        # 已约客户不走拒绝：api_flow 的 done 重激活可能把他带回本阶段，
        # 「改天行不行」以前在这里被判流失，预约直接作废（2026-11-15 实测）。
        if is_disagree(text) and not slots.get("booked"):
            # P0-2：混着登记/询问信号的拒绝词句不判拒
            handled = _handle_mixed_refusal(state, slots, text, stage, when, now, kb_answer)
            if handled is not None:
                return handled
            slots["recruit_status"] = "disqualified"
            state["stage"] = STAGE_DONE
            return FlowResult(
                reply=_gave_up_text(),
                stage=STAGE_DONE,
                slots=slots,
                finished=True,
                action=ACTION_GAVE_UP,
            )
        if agrees_to_interview(text) and not looks_like_question(text):
            return _agree_interview(state, slots, when, now, text=text)
        # 插问（体检 / 住宿 / 地点）：先答，答完还停在邀约
        if kb_answer or looks_like_question(text):
            return _answer_side_question(state, stage, slots, text, kb_answer)
        if agrees_to_interview(text):
            return _agree_interview(state, slots, when, now, text=text)
        # 答非所问：换一种说法重问，不把同一句连发三遍
        slots["ask_retries"] = int(slots.get("ask_retries") or 0) + 1
        return FlowResult(reply=_interview_ask(slots), stage=stage, slots=slots)

    if stage == STAGE_COLLECT:
        period_answer = remember_interview_period(slots, text)
        _absorb(slots, text, strict_name=not period_answer)
        prompt = _collect_prompt(slots)
        if not prompt:
            result = _book(slots, when, now, text=text)
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


def _route_by_graph(
    graph: dict[str, Any] | None,
    node: str,
    text: str,
    slots: dict[str, Any],
    state: dict[str, Any],
    when: datetime | None = None,
    kb_answer: str | None = None,
) -> FlowResult | None:
    """按节点图的边走一步；走不出去返回 None，由调用方回退到写死分支。

    返回 None 的三种情况（都必须回退，不能卡住流程）：
      * 没有节点图（老调用方 / 设备没配 / 没跑迁移）
      * 当前 node 为空且图里没有入口节点
      * 当前节点没有任何命中的出边

    这一层只决定「去哪个节点 + 说什么」。至于「进去之后要不要真发消息」
    （比如 send_info 要按城市查岗位），仍交给下面原有的函数：
    enter_info_result / _agree_interview / _book —— 它们才持有业务规则。
    """
    if not graph:
        return None
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    if not nodes:
        return None

    current = node or str(graph.get("entry") or "")
    if not current:
        return None

    # 拒绝优先，必须早于选边。
    # 默认边里的「可以,行,好,去」太宽，客户回「不行」也会命中「行」被当成答应，
    # 直接跳去要姓名电话（与 stage 分支的「拒绝优先」规则冲突）。这里提前拦。
    if current == STAGE_ASK_INTERVIEW and is_disagree(text) and not slots.get("booked"):
        # P0-2：混着登记/询问信号的拒绝词句不判拒
        handled = _handle_mixed_refusal(
            state, slots, text, STAGE_ASK_INTERVIEW, when, None, kb_answer)
        if handled is not None:
            state["node"] = handled.stage
            return handled
        slots["recruit_status"] = "disqualified"
        state["stage"] = STAGE_DONE
        state["node"] = STAGE_DONE
        return FlowResult(
            reply=_gave_up_text(),
            stage=STAGE_DONE,
            slots=slots,
            finished=True,
            action=ACTION_GAVE_UP,
        )

    # 侧问优先于路由：客户问事（问工价/面试几点/带什么）时先答，不推进节点。
    #
    # 为什么必须在 pick_next 之前：默认边的关键词很宽（ask_interview → collect
    # 那条含「几点」），客户问「几点面试」会被当成答应面试，直接跳到要姓名电话，
    # 刚查到的面试时间一个字都没说（2026-11-14 实测）。
    # ask_city 不拦截：「深圳有厂吗」这类必须先抽城市，答完再问就丢了城市线索。
    if current != STAGE_ASK_CITY and (kb_answer or looks_like_question(text)):
        # 报名字/报号码不算问事：「我叫张三」「13800138000」里没有问句意图
        if not extract_phone(text) and not extract_name(text):
            answered = _answer_side_question(state, current, slots, text, kb_answer)
            if answered.parts:
                return answered

    target = pick_next(edges, current, text, slots)
    if not target:
        return None

    # 走边之后的状态：节点变、stage 跟着节点走（stage 仍用于档案推送等旧逻辑）
    state["node"] = target
    config_body = node_body(nodes, target)
    when = when or next_interview(None, _day_offset_of(slots))

    # send_info / done 这些节点有硬业务规则（岗位数据、面试时间由代码算），
    # 不能只照抄配置正文——交给原函数，正文只作为补充。
    if target == STAGE_SEND_INFO:
        # 城市必须在这里抽一次：地铁号入口是 ask_city，客户答「深圳」正好走这条边，
        # 如果只交给 enter_info_result，slots.city 还是空 → 查不到岗位 → 回
        # 「已记下，你找的厂」，下一轮还是空城市，永远走不出去（2026-11-14 实测）。
        city = extract_city(text) or str(slots.get("city") or "")
        if not city:
            # 还不知道城市就发不了岗位卡（也不知道发哪个城市的）。
            # 这里的 always 边只代表「该进发信息这一步了」，不代表「城市已经问到」——
            # 客户第一句是「你好」时必须先问城市，不能回「已记下，你找的厂」。
            # node 也要跟着回拨：上面已经把 node 设成 send_info 了，不回拨的话
            # 下一轮会带着「已经发过卡」的假状态继续走。
            state["node"] = STAGE_ASK_CITY
            state["stage"] = STAGE_ASK_CITY
            return FlowResult(reply=_city_ask(slots), stage=STAGE_ASK_CITY, slots=slots)
        slots["city"] = city
        slots.setdefault("job_index", 0)
        select_position_by_place(slots, text)
        _absorb(slots, text)
        result = enter_info_result(slots, when, None)
        state["stage"] = result.stage
        if config_body:
            result.parts = [config_body, *result.parts]
            result.reply = "\n".join(result.parts)
        return result

    if target == STAGE_DONE:
        # 拒绝优先：走 done 的原因可能是「答应」，也可能是「不去了/算了」。
        # 后者绝不能被 _book 登记成已约（2026-11-14 实测：回「不去」被回了
        # 「好嘞，登记好了」并推了 book_interview）。与 stage 分支的规则保持一致。
        if is_disagree(text) and not slots.get("booked"):
            # P0-2：混着登记/询问信号的拒绝词句不判拒
            handled = _handle_mixed_refusal(
                state, slots, text, STAGE_ASK_INTERVIEW, when, None, kb_answer)
            if handled is not None:
                state["node"] = handled.stage
                return handled
            slots["recruit_status"] = "disqualified"
            state["stage"] = STAGE_DONE
            return FlowResult(
                reply=_gave_up_text(),
                stage=STAGE_DONE,
                slots=slots,
                finished=True,
                action=ACTION_GAVE_UP,
            )
        _absorb(slots, text)
        # 姓名手机没齐就约不成：collected 边只看 phone，客户只报号码不报姓名时
        # 会被直接登记成已约。缺字段就退回 collect 继续要。
        missing = _collect_prompt(slots)
        if missing:
            state["stage"] = STAGE_COLLECT
            state["node"] = STAGE_COLLECT
            return FlowResult(reply=missing, stage=STAGE_COLLECT, slots=slots)
        result = _book(slots, when, None, text=text)
        state["stage"] = result.stage
        state["node"] = result.stage
        if config_body and result.stage == STAGE_DONE:
            result.parts = [config_body, *result.parts]
            result.reply = "\n".join(result.parts)
        return result

    if target == STAGE_COLLECT:
        # 客户在这一轮常常顺手报了姓名/手机（「行，张三 13800138000」）。
        # 不抽就进 collect，会再问一遍刚给过的字段（2026-11-14 实测）。
        _absorb(slots, text, strict_name=True)
        state["stage"] = STAGE_COLLECT
        prompt = _collect_prompt(slots)
        if not prompt:
            result = _book(slots, when, None, text=text)
            state["stage"] = result.stage
            state["node"] = result.stage
            return result
        reply = config_body or prompt
        return FlowResult(reply=reply, stage=STAGE_COLLECT, slots=slots)

    if target == STAGE_ASK_INTERVIEW:
        state["stage"] = STAGE_ASK_INTERVIEW
        _absorb(slots, text)
        # 同意与否的判断规则在引擎里（拒绝优先），节点正文只替换「怎么问」
        if is_disagree(text):
            slots["recruit_status"] = "disqualified"
            state["stage"] = STAGE_DONE
            state["node"] = STAGE_DONE
            return FlowResult(
                reply=_gave_up_text(),
                stage=STAGE_DONE,
                slots=slots,
                finished=True,
                action=ACTION_GAVE_UP,
            )
        # 纯打招呼（「你好」「收到」）不是同意：默认边关键词里有「好」，
        # 不排掉会被当成答应，直接跳过面试邀约去要姓名电话（2026-11-14 实测）。
        if _is_bare_greeting(text) or looks_like_question(text):
            reply = config_body or _interview_ask(slots)
            return FlowResult(reply=reply, stage=STAGE_ASK_INTERVIEW, slots=slots)
        if agrees_to_interview(text):
            result = _agree_interview(state, slots, when, None, text=text)
            state["node"] = STAGE_COLLECT if result.stage == STAGE_COLLECT else result.stage
            return result
        # 答非所问：换说法重问，不把同一句连发三遍（与 stage 分支同规则）
        slots["ask_retries"] = int(slots.get("ask_retries") or 0) + 1
        reply = config_body or _interview_ask(slots)
        return FlowResult(reply=reply, stage=STAGE_ASK_INTERVIEW, slots=slots)

    if target == STAGE_ASK_CITY:
        state["stage"] = STAGE_ASK_CITY
        city = extract_city(text) or str(slots.get("city") or "")
        if city:
            slots["city"] = city
        reply = config_body or _city_ask(slots)
        return FlowResult(reply=reply, stage=STAGE_ASK_CITY, slots=slots)

    # 自定义节点（运营自己加的）：只发配置正文，stage 保持不前进
    if config_body:
        return FlowResult(reply=config_body, stage=str(state.get("stage") or ""), slots=slots)

    return None


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


def _decline_interview(state: dict[str, Any], slots: dict[str, Any]) -> FlowResult:
    slots.update({"recruit_status": "disqualified", "interview_agreed": False, "booked": False})
    state["stage"] = STAGE_DONE
    state["node"] = STAGE_DONE
    return FlowResult(reply=_gave_up_text(), stage=STAGE_DONE, slots=slots,
                      finished=True, action=ACTION_GAVE_UP, source="fact")


def _handle_mixed_refusal(
    state: dict[str, Any],
    slots: dict[str, Any],
    text: str,
    stage: str,
    when: datetime,
    now: datetime | None,
    kb_answer: str | None,
) -> FlowResult | None:
    """拒绝词句里混着意向信号时的分流：登记意向→收资料；询问意向→答事实。

    纯拒绝返回 None，由调用方走原放弃分支。
    """
    if not is_disagree(text):
        return None
    # 「改天行不行 / 能改天吗」是想换个时间，不是不来了：
    # 直接判 disqualified 会把还能救的客户丢掉（2026-11-15 真实对话复盘）。
    if ("改天" in text or "改期" in text or "换一天" in text) and looks_like_question(text):
        return FlowResult(
            reply="可以，你哪天方便过来？我按你说的日期给你登记。",
            stage=stage, slots=slots, source="collect",
        )
    if any(s in text for s in _REFUSAL_REGISTER_SIGNALS):
        remember_interview_period(slots, text)
        _absorb(slots, text, strict_name=True)
        day_offset = extract_day_offset(text)
        if day_offset is not None:
            slots["interview_day_offset"] = day_offset
        when = next_interview(now, _day_offset_of(slots))
        return _agree_interview(state, slots, when, now, text=text)
    if any(s in text for s in _REFUSAL_ASK_SIGNALS):
        return _answer_side_question(state, stage, slots, text, kb_answer)
    return None


def revive_from_done(
    state: dict[str, Any], text: str, now: datetime | None = None
) -> FlowResult | None:
    """done/disqualified 黑洞复活（P0-2）。

    结束状态的客户再发消息时，检测到姓名/电话/面试意向 → 清掉 disqualified
    回到 collect 继续登记；纯确认/应答（「收到」「好的」）保持原静默收尾。
    """
    slots = state.setdefault("slots", {})
    if slots.get("booked"):
        return None
    value = (text or "").strip().strip("，,。.！!？?~～ ")
    if not value or _is_bare_greeting(text) or _is_bare_confirm(text):
        return None
    phone = extract_phone(text)
    name = extract_name(text, strict=True)
    wants_interview = (
        any(s in text for s in _REFUSAL_REGISTER_SIGNALS) or agrees_to_interview(text)
    )
    if not (phone or name or wants_interview):
        return None
    slots.pop("recruit_status", None)
    slots["interview_agreed"] = True
    remember_interview_period(slots, text)
    _absorb(slots, text, strict_name=True)
    day_offset = extract_day_offset(text)
    if day_offset is not None:
        slots["interview_day_offset"] = day_offset
    when = next_interview(now, _day_offset_of(slots))
    state["stage"] = STAGE_COLLECT
    state["node"] = STAGE_COLLECT
    return _agree_interview(state, slots, when, now, text=text)


def _agree_interview(
    state: dict[str, Any],
    slots: dict[str, Any],
    when: datetime,
    now: datetime | None = None,
    text: str = "",
) -> FlowResult:
    """客户答应来：姓名手机都在就直接约成，缺一个就进 collect 只要缺的那个。"""
    slots["interview_agreed"] = True
    state["stage"] = STAGE_COLLECT
    prompt = _collect_prompt(slots)
    if prompt:
        return FlowResult(reply=prompt, stage=STAGE_COLLECT, slots=slots, source="collect")
    result = _book(slots, when, now, text=text)
    state["stage"] = result.stage
    return result


_JOB_FACT_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # (快照字段, 触发词)。顺序即优先级：一句话问多个字段时取先命中的。
    # 2026-11-15 真实聊天记录复盘补齐：面试时间/宿舍/体检/保险/日结/纹身/身高/
    # 证件这些字段 4222 早就下发了，之前一个触发词都没配，客户问就变「确认一下」。
    ("wage_text", ("工资", "工价", "多少钱", "薪资", "待遇", "多少钱一天", "多少钱一个月",
                   "多少钱一小时", "一小时多少", "一天多少", "怎么算", "纯工价")),
    ("interview_time", ("面试时间", "什么时候面试", "几点面试", "面试几点", "明天几点到",
                        "什么时候可以面试", "明天能面试", "可以面试吗")),
    ("hours_text", ("几个小时", "几个钟", "班次", "上班时间", "几点上班", "长白班", "两班倒",
                    "工时", "上班几个小时")),
    ("rest_text", ("月休", "休息几天", "几天休", "休假", "一个月几天休息")),
    ("age_text", ("年龄", "几岁", "多大", "岁数", "限制吗", "超龄")),
    ("welfare_text", ("吃住", "住宿", "包吃", "包住", "福利", "吃怎么", "包不包吃")),
    ("dorm_text", ("几人间", "有空调", "热水器", "住的地方", "宿舍怎么样")),
    # 地铁岗位的线路信息（4222 有时写进 welfare_text，有时写进 line_text/note）
    ("line_text", ("线路", "哪条线", "安排哪")),
    # 体检/社保/证件属于「政策口径」，必须走按岗位配好的 FAQ：岗位里的
    # medical_text 只写「要体检」，不代表报价，抢答会把工价/要求冒充成金额。
    ("advance_text", ("日结", "预支", "借支", "压工资", "几号发工资", "发工资")),
    ("tattoo_policy", ("纹身", "刺青", "花臂")),
    ("height_text", ("身高", "多高")),
    ("ethnicity_policy", ("民族", "少数民族")),
    ("place", ("在哪", "地址", "地点", "哪里面试", "哪儿", "怎么走")),
    ("job_title", ("做什么", "什么工作", "干什么的", "什么岗位", "招什么")),
)

_FACT_LABELS = {
    "wage_text": "工价",
    "hours_text": "班次",
    "rest_text": "月休",
    "age_text": "年龄要求",
    "interview_time": "面试时间",
    "welfare_text": "吃住",
    "dorm_text": "住宿",
    "line_text": "安排线路",
    "medical_text": "体检",
    "insurance_text": "保险",
    "advance_text": "发薪/预支",
    "tattoo_policy": "纹身要求",
    "height_text": "身高要求",
    "ethnicity_policy": "民族要求",
    "cert_text": "证件要求",
    "place": "地点",
    "job_title": "岗位",
    "factory_name": "工厂",
}


def _age_range(age_text: str) -> tuple[int, int] | None:
    """从「18-45岁」「16到43岁」里取年龄区间。"""
    numbers = re.findall(r"\d{2}", age_text or "")
    if len(numbers) >= 2:
        low, high = int(numbers[0]), int(numbers[1])
        return (low, high) if low <= high else (high, low)
    return None


def _age_in_text(text: str) -> int | None:
    """从「我52了」「52岁」里取客户自报年龄。"""
    match = re.search(r"(\d{2})\s*(?:岁|周岁)", text or "")
    if match:
        return int(match.group(1))
    match = re.search(r"我\s*(?:今年)?\s*(\d{2})(?!\d)", text or "")
    return int(match.group(1)) if match else None


def _job_fact_answer(slots: dict[str, Any], text: str) -> str:
    """客户插问岗位事实时，直接用「已钉住岗位」的数据回答。

    为什么不走知识库：客户刚看完这家厂的岗位卡，问「工资多少」问的就是这家厂。
    global 层的 FAQ 条目没有厂归属，按关键词命中谁就用谁的答案——实测把别家厂
    的「转正175/班」发给了地铁安检的客户。岗位数据答不了的（纹身/体检这类）
    才落到知识库，而那类条目本来就该按雇主作用域配置。
    """
    # “体检多少钱”“体检费从工资扣吗”不能因包含钱/工资而发工价表。
    # 费用政策交给对应的本岗FAQ；没有材料时沿用缺字段待确认路径。
    snapshot = slots.get("job_snapshot") if isinstance(slots.get("job_snapshot"), dict) else {}
    if not snapshot:
        return ""
    lowered = str(text or "")
    # “体检多少钱”“体检费从工资扣吗”不能因包含钱/工资而发工价表，也不能拿
    # medical_text（写的是「要不要体检」）充当报价——金额只在按岗位配好的
    # FAQ 里，没配就承认要确认。这条规则有专门用例守着，别改。
    if is_non_wage_cost_question(lowered):
        return ""
    # 客户自报年龄（「我52了还能去吗」）：直接跟岗位年龄上限比，别装傻。
    asked_age = _age_in_text(lowered)
    if asked_age is not None and re.search(r"岁|年龄|还能|能做|可以去|可以不|行不行|要吗", lowered):
        age_text = str(snapshot.get("age_text") or "").strip()
        limits = _age_range(age_text)
        if age_text and limits:
            if limits[0] <= asked_age <= limits[1]:
                return f"年龄要求：{age_text}，{asked_age} 岁没问题。"
            return f"年龄要求：{age_text}，{asked_age} 岁超了，我帮你看看别的岗位？"
    for field, patterns in _JOB_FACT_PATTERNS:
        if not any(p in lowered for p in patterns):
            continue
        value = str(snapshot.get(field) or "").strip()
        if field == "welfare_text" and value and not re.search(
            r"吃|住|宿舍|餐|饭|补贴|伙食", value
        ):
            # 这个字段填的其实是线路（「安排线路：广东城际全线路」），
            # 不是吃住：先用独立住宿字段答，没有就交给知识库，绝不冒充吃住。
            dorm = str(snapshot.get("dorm_text") or "").strip()
            if dorm:
                return f"住宿：{dorm}"
            continue
        if not value:
            continue
        if field == "age_text":
            asked = _age_in_text(lowered)
            limits = _age_range(value)
            if asked and limits and not (limits[0] <= asked <= limits[1]):
                return f"年龄要求：{value}，{asked} 岁超了，我帮你看看别的岗位？"
        return f"{_FACT_LABELS[field]}：{value}"
    return ""


def _answer_side_question(
    state: dict[str, Any],
    stage: str,
    slots: dict[str, Any],
    text: str,
    kb_answer: str | None,
) -> FlowResult:
    """插问分支：先看已钉岗位的事实（上下文优先），再落知识库，都没答上就兜底记账。"""
    job_fact = _job_fact_answer(slots, text)
    if job_fact:
        # 上下文能答的绝不过 KB：既不会串厂，也不用「确认一下」吊着客户。
        return FlowResult(
            reply="",
            parts=[job_fact],
            stage=stage,
            slots=slots,
            source="fact",
        )
    if kb_answer:
        # 答上了就只答，不再追加「能不能过来面试」。
        # 2026-11-14 实测：客户连问 5 个问题，每条答复后面都挂着一句邀约，
        # 客户看到的是「你答了，但一直在催我去面试」。配置了 ask_interview
        # 话术之后这句更显眼（固定台词反复出现），必须去掉。
        return FlowResult(
            reply="",
            parts=[kb_answer],
            stage=stage,
            slots=slots,
            source="kb",
        )
    if looks_like_question(text):
        # 同一个问题连问三次不能收到三句一模一样的话（2026-11-15 实测：
        # 「要押金吗」连问三次，客户收到三条逐字相同的「确认一下」）。
        tries = int(slots.get("faq_retries") or 0) + 1
        slots["faq_retries"] = tries
        head = (
            "这个我确认一下，稍后回你"
            if tries == 1
            else "这个我得跟厂里再核实一下，确认好马上回你"
            if tries == 2
            else "这个问题我已经记下了，核实完第一时间发你"
        )
        return FlowResult(
            reply="",
            parts=[head, _faq_retry(stage, slots)],
            stage=stage,
            slots=slots,
            unknown_question=text,
        )
    # 含糊的一句（「嗯」「哦」）：只把该问的重问一次，不记未知问题
    followup = _faq_retry(stage, slots)
    state["stage"] = stage
    return FlowResult(reply=followup, stage=stage, slots=slots)


def align_reply_with_slots(reply: str, slots: dict[str, Any]) -> str:
    """回复里的日期/时段说法与 slots 冲突时按 slots 改写（P2-6）。

    客户说了「后天上午」而 slots 记的是 day_offset=2/period=上午，模型嘴上的
    「明天」一律从 slots 重渲染；没记过的槽位不动。
    """
    out = str(reply or "")
    offset = slots.get("interview_day_offset")
    if isinstance(offset, int) and not isinstance(offset, bool):
        label = {0: "今天", 1: "明天", 2: "后天", 3: "大后天"}.get(offset)
        if label:
            for word, word_offset in _DAY_WORDS:
                if word_offset != offset and word in out:
                    out = out.replace(word, label)
    period = str(slots.get("interview_period") or "")
    if period:
        for word, canonical in _INTERVIEW_PERIODS.items():
            if canonical != period and word in out:
                out = out.replace(word, period)
    return out

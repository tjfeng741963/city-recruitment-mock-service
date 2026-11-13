"""LLM 驱动的招聘对话（单决策点）。

一轮对话只有**一次**模型调用：回什么、分几条、要不要发岗位卡/图片视频、
要不要收尾，全部由模型决定。代码只保留事实护栏：

1. 素材包：当前阶段、slots（含已约状态）、该城市岗位（1 条主推全字段 +
   其余岗位名称简表）、知识库命中原文、可用媒体清单、已发过的内容摘要
2. 数字护栏：回复里的工价/年龄/时间/地址必须能在素材里找到原文，
   找不到的分句剔除；剔空了就回退素材原文（flow_engine 的确定性话术）
3. 媒体护栏：只允许清单内的【图片:x】【视频:x】，清单外的标记直接删掉
4. 三段同源：岗位介绍的三段（岗位/地点时间/邀约）必须来自同一条主推岗位，
   混入其他岗位的工价/地点/年龄 → 整轮回退主推岗位的素材原文
5. 已约硬规则：slots.booked 为真时禁止再推销岗位；模型仍发岗位卡 → 丢弃

模型不可用（没配 key / 超时 / 返回乱码）才退到 flow_engine 的确定性状态机。
那条兜底路径仍会自动发岗位信息——没有模型时，总得有人把事实说给客户。
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .flow_engine import (
    ACTION_BOOK,
    ACTION_GAVE_UP,
    ACTION_HANDOFF,
    INTERVIEW_WINDOW,
    PROFILE_KEYS,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    STAGE_KB,
    STAGE_SEND_INFO,
    FlowResult,
    day_label,
    job_media_markers,
    jobs_for_city,
    looks_like_question,
    next_interview,
    send_info_parts,
    step as fallback_step,
)
from .llm_provider import ChatMessage, LLMProvider

ALLOWED_STAGES = {
    STAGE_ASK_CITY,
    STAGE_SEND_INFO,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
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

# 这一轮由你决定
回什么、分几条（parts）、要不要发岗位信息 / 图片视频、要不要收尾，全部你自己判断。
系统不会替你发任何话，只提供素材和事实护栏。

# 聊天目标（跟客户的节奏走，别硬推）
1. 先问客户投递的是哪个城市
2. 有城市后，把这一条主推岗位介绍清楚：岗位事实 → 地点时间 → 邀约，三段
3. 客户有兴趣，问「这两天能不能过来面试」
4. 客户答应，一次要姓名 + 手机号
5. 姓名手机齐了，确认面试时间地点，收尾

# 说话方式（很重要）
- 像微信上聊天的真人：短句、口语，可以用「哈」「嗯」「好嘞」
- 一次只说一件事，别把几个问题堆一起
- 客户问什么就先答什么，答完再自然接回你该问的
- 不要复读上一轮，不要每句都「您好」「请问」

# 事实护栏（违反了系统会整段丢弃）
- **不许编数字**。工价、年龄、时间、地址只能照抄「本轮素材」原文，不能改、不能推算
  （19 元/小时 不许说成 20 元；18-50 岁 不许写成 18-45 岁；地址不许换一个字）
- 素材里没有的细节（体检报销、住宿条件等）就说「我确认一下，稍后回你」，不要猜
- 图片 / 视频只能引用「可用媒体」清单里的名称，格式【图片:名称】【视频:名称】；
  清单是空的就一个标记都不要发
- 岗位介绍的三段（岗位 / 地点时间 / 邀约）必须来自**同一条主推岗位**，
  不许把别的岗位的工价、地点、年龄混进来；其余岗位只提名称，不报数字
- **客户已经约好面试**：只答疑 / 确认 / 改约，绝不再推销岗位、不再发招工卡和邀约

# 输出格式（只输出 JSON，不要代码块，不要多余文字）
{"reply": "整段回复", "parts": ["第一条", "第二条"], "stage": "ask_city|send_info|ask_interview|collect|done",
 "slots": {"city": "", "job_index": 0},
 "profile": {"name": "", "phone": "", "province": "", "city": "", "district": "", "age": null, "notes": ""},
 "action": null, "finished": false}

- reply 是 parts 用换行拼起来；只发一条时 parts 可以不写
- profile 客户说到才填，没说到就留空；phone 照客户原话抄，不要改格式
- action 只能是 null / "book_interview" / "gave_up" / "handoff"
- 姓名和手机号都拿到 → action="book_interview"，finished=true
- 客户说这两天来不了 / 不去了 → action="gave_up"，finished=true
"""

# 媒体标记：清单外的名称必须被删掉
_MEDIA_FULL = re.compile(r"【(?:图片|视频):[^】]+】")
_MEDIA_NAME = re.compile(r"【(图片|视频):([^】]+)】")

# 数字护栏：工价 / 年龄 / 时间 / 日期 / 月休
_NUMBER_PATTERNS = (
    re.compile(r"\d+(?:\.\d+)?\s*元(?:/小时|/天|/月|每小时)?"),
    re.compile(r"\d+\s*[-~～至到]\s*\d+\s*岁"),
    re.compile(r"\d+\s*岁"),
    re.compile(r"\d{1,2}\s*[:：]\s*\d{2}"),
    re.compile(r"\d{1,2}\s*点(?:半|\d{1,2}\s*分)?"),
    re.compile(r"\d{1,2}\s*月\s*\d{1,2}\s*[日号]"),
    re.compile(r"月休\s*\d+"),
)

# 地址护栏：带行政区/道路/社区后缀的地点必须能在素材里找到
# （不校验「几号」这种纯数字：会和「11月9号」这类日期撞车，道路名已能覆盖地址）
_ADDRESS_PATTERNS = (
    re.compile(r"[\u4e00-\u9fa5]{2,12}(?:大道|路|街|镇|区|村|社区|工业园|工业区|附近)"),
)
# 问句里的「哪个区 / 哪条街」是在提问，不是地址断言
_ADDRESS_STOP = ("哪个", "哪条", "哪里", "哪个区", "哪个镇", "哪个村")

# 岗位卡特征：已约客户收到这些就是在被重复推销
_JOB_CARD_LABELS = ("厂名", "工价", "班次", "年龄", "吃住")

_WS = re.compile(r"\s+")


@dataclass
class Material:
    """本轮交给模型的事实素材。护栏只认这份素材，不认模型记忆。"""

    stage: str
    slots: dict[str, Any]
    when: datetime
    text: str = ""
    city: str = ""
    primary: dict[str, str] = field(default_factory=dict)
    other_jobs: list[dict[str, str]] = field(default_factory=list)
    kb_body: str = ""
    kb_repeat: bool = False
    script: str = ""
    sent_summary: str = ""
    media: list[str] = field(default_factory=list)
    booked: bool = False


def build_material(
    state: dict[str, Any],
    text: str = "",
    now: datetime | None = None,
    *,
    kb_body: str = "",
    kb_repeat: bool = False,
    script: str = "",
    sent_summary: str = "",
) -> Material:
    """把这一轮模型能看到的全部事实整理成素材包。

    岗位只给 1 条主推的完整字段；其余岗位只给名称，避免模型混用事实
    （三段一致的根因就是「手上同时有三条岗位的全部数字」）。
    """
    slots = state.get("slots") or {}
    city = str(slots.get("city") or "")
    jobs = list(jobs_for_city(city)) if city else []
    index = int(slots.get("job_index") or 0)
    primary = jobs[min(max(index, 0), len(jobs) - 1)] if jobs else {}
    others = [job for i, job in enumerate(jobs) if job is not primary]

    media: list[str] = []
    for marker in _MEDIA_FULL.findall(kb_body or ""):
        if marker not in media:
            media.append(marker)
    # 已约客户不再发岗位媒体（工作视频/面试点图也是招工推销的一部分）
    if not slots.get("booked"):
        for marker in job_media_markers(primary, city):
            if marker not in media:
                media.append(marker)

    return Material(
        stage=str(state.get("stage") or STAGE_ASK_CITY),
        slots=slots,
        when=next_interview(now),
        text=text or "",
        city=city,
        primary=primary,
        other_jobs=others,
        kb_body=kb_body or "",
        kb_repeat=kb_repeat,
        script=script or "",
        sent_summary=sent_summary or "",
        media=media,
        booked=bool(slots.get("booked")),
    )


def _job_block(job: dict[str, str]) -> str:
    title = str(job.get("job_title") or "")
    kind = title.split(" ")[-1] if " " in title else title
    factory = str(job.get("factory_name") or title.split(" ")[0])
    return "\n".join(
        [
            f"厂名：{factory}（{kind}）",
            f"工价：{job.get('wage_text', '')}",
            f"班次：{job.get('hours_text', '')}",
            f"年龄：{job.get('age_text', '')}",
            f"吃住：{job.get('welfare_text', '')}",
            f"地点：{job.get('place', '')}",
        ]
    )


def _material_text(mat: Material) -> str:
    """素材包的文本形态：系统提示的一部分，也是数字/地址护栏的原文出处。"""
    if mat.primary:
        job_block = "主推岗位（唯一可报数字的岗位）\n" + _job_block(mat.primary)
    elif mat.city:
        job_block = "主推岗位：该城市暂无岗位数据。不要编岗位，跟客户说「帮你问问」。"
    else:
        job_block = "主推岗位：还不知道城市。先问城市，不要提任何具体岗位。"

    if mat.other_jobs:
        names = "\n".join(
            f"- [#{i}] {job.get('job_title') or job.get('factory_name') or ''}"
            for i, job in enumerate(mat.other_jobs, start=1)
        )
        other_block = (
            f"其余岗位：还有 {len(mat.other_jobs)} 个（只可提名称/数量，"
            f"不要报工价、地址、年龄等任何数字；客户想看某个就在 slots.job_index "
            f"填对应 # 序号，系统下一轮会换成它的完整素材）\n{names}"
        )
    else:
        other_block = "其余岗位：没有"

    interview_block = (
        f"默认面试时间：{day_label(mat.when)}{INTERVIEW_WINDOW}，"
        f"地点：{mat.primary.get('place', '') or mat.slots.get('interview_place', '') or '未定'}。"
        "客户明确说别的时间，以客户为准。"
        if mat.primary
        else "面试时间：暂无岗位，不要报具体时间地点。"
    )

    if mat.kb_body:
        kb_block = "知识库命中原文（客户问的问题有答案，可直接照抄；数字也算事实）\n" + mat.kb_body
        if mat.kb_repeat:
            kb_block += "\n（这条以前已经发过：不要再整段重发，只答新增问题或按需重发媒体）"
    else:
        kb_block = "知识库命中原文：无。不确定的就说「我确认一下，稍后回你」。"

    media_block = (
        "\n".join(
            f"- {m.group(1)}：{m.group(2)}"
            for m in (_MEDIA_NAME.match(x) for x in mat.media)
            if m
        )
        or "（空，本轮禁止输出任何【图片:】【视频:】标记）"
    )

    return "\n\n".join(
        [
            "# 本轮素材（事实唯一来源）",
            job_block,
            other_block,
            interview_block,
            kb_block,
            f"运营话术素材（可参考语气，数字仍以岗位素材为准）\n{mat.script or '（无）'}",
            f"可用媒体（只能用清单里的名称）\n{media_block}",
            f"已经发过的内容（别重复）\n{mat.sent_summary or '（无）'}",
        ]
    )


def _system_prompt(mat: Material) -> str:
    parts = [SYSTEM_PROMPT, _material_text(mat)]
    if mat.booked:
        when_txt = "，".join(
            x
            for x in (
                str(mat.slots.get("interview_window") or ""),
                str(mat.slots.get("interview_place") or ""),
            )
            if x
        )
        parts.append(
            "# 本会话已约好面试\n"
            f"客户已经约好面试{f'（{when_txt}）' if when_txt else ''}。\n"
            "这一轮绝对禁止再推销岗位、再发岗位卡/工价/招工信息/面试邀约。\n"
            "只能做三件事：回答客户的问题、确认已约信息、客户要改约就说明帮他改。"
        )
    return "\n\n".join(parts)


def build_messages(
    state: dict[str, Any],
    text: str,
    now: datetime | None = None,
    material: Material | None = None,
) -> list[ChatMessage]:
    """surface 投影：最近几轮 + 当前已知信息 + 本轮素材，不给全量历史。"""
    when = now or datetime.now().astimezone()
    mat = material or build_material(state, text, now=when)
    slots = {k: v for k, v in (mat.slots or {}).items() if v}
    recent = (state.get("history") or [])[-8:]

    transcript = "\n".join(
        f"{'客户' if item['role'] == 'customer' else '你'}：{item['text']}"
        for item in recent
    )
    context = (
        f"当前阶段：{mat.stage}\n"
        f"已知信息：{json.dumps(slots, ensure_ascii=False)}\n"
        f"是否已约好面试：{'是' if mat.booked else '否'}\n"
        f"最近对话：\n{transcript or '（还没有）'}\n\n"
        f"客户刚说：{text}"
    )
    return [
        ChatMessage(role="system", content=_system_prompt(mat)),
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
    jobs = jobs_for_city(str(slots.get("city") or ""))
    if not jobs:
        return {}
    index = int(slots.get("job_index") or 0)
    return jobs[min(max(index, 0), len(jobs) - 1)]


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


def _split_parts(reply: str) -> list[str]:
    """模型返回的空行分段 → parts。老客户端只看 reply，新客户端逐条发。"""
    parts = [chunk.strip() for chunk in re.split(r"\n{2,}", reply or "") if chunk.strip()]
    return parts or ([reply.strip()] if reply.strip() else [])


# ── 事实护栏 ──────────────────────────────────────────
def _norm(value: Any) -> str:
    return _WS.sub("", str(value or ""))


def _corpus(mat: Material) -> str:
    """本轮所有可引用的事实原文。数字/地址只能从这里取。"""
    values: list[str] = []
    if mat.primary:
        for key in (
            "factory_name",
            "job_title",
            "wage_text",
            "hours_text",
            "age_text",
            "welfare_text",
            "place",
        ):
            values.append(str(mat.primary.get(key) or ""))
    values.extend(
        [
            mat.text,
            mat.kb_body,
            mat.script,
            mat.city,
            INTERVIEW_WINDOW,
            day_label(mat.when),
            day_label(mat.when).replace("日", "号"),
            str(mat.slots.get("interview_at") or ""),
            str(mat.slots.get("interview_place") or ""),
            str(mat.slots.get("interview_window") or ""),
            str(mat.slots.get("province") or ""),
            str(mat.slots.get("district") or ""),
        ]
    )
    return _norm(" ".join(values))


def _numbers_ok(segment: str, corpus: str) -> bool:
    for pattern in _NUMBER_PATTERNS:
        for match in pattern.findall(segment):
            token = _norm(match)
            if token and token not in corpus:
                return False
    return True


def _known_places(mat: Material) -> list[str]:
    values = [
        mat.primary.get("place") if mat.primary else "",
        mat.slots.get("interview_place"),
        mat.slots.get("district"),
        mat.slots.get("province"),
        mat.city,
    ]
    return [_norm(v) for v in values if len(_norm(v)) >= 2]


def _addresses_ok(segment: str, mat: Material) -> bool:
    """分句里的地点断言必须在素材里：要么整段能找到，要么素材地点原文被包含。"""
    if any(word in segment for word in _ADDRESS_STOP):
        return True
    corpus = _corpus(mat)
    places = _known_places(mat)
    for pattern in _ADDRESS_PATTERNS:
        for match in pattern.findall(segment):
            token = _norm(match)
            if not token:
                continue
            if token in corpus:
                continue
            # 「在番禺南村…附近」「面试地点在…」会把连接词带进来，看素材地点是否被包含
            if any(place in token for place in places):
                continue
            return False
    return True


def _job_fact_hits(segment: str, job: dict[str, str]) -> int:
    """分句命中了该岗位几个「独有事实」（工价/地点/年龄）。

    福利、班次多个岗位常常一样，拿来判同源会误伤，不纳入。
    """
    text = _norm(segment)
    hits = 0
    for key in ("wage_text", "place", "age_text"):
        value = _norm(job.get(key) or "")
        if len(value) >= 2 and value in text:
            hits += 1
    return hits


def _leaks_other_job(segment: str, mat: Material) -> bool:
    """三段同源：分句里出现其他岗位的工价/地点/年龄 → 视为混用。"""
    return any(_job_fact_hits(segment, job) for job in mat.other_jobs)


def _is_job_sale(segment: str, mat: Material) -> bool:
    """这条分句是不是在推销岗位（已约客户不该收到）。

    知识库原文里的答句不算推销：客户问工资/地点，照知识库回答是「答疑」，
    不在「不要再推销」的禁止范围内（2026-11-13 反面案例：已约客户又被发招工卡）。
    """
    text = _norm(segment)
    kb = _norm(mat.kb_body)
    if kb and len(text) >= 4 and text in kb:
        return False
    if any(re.match(rf"\s*{label}\s*[:：]", segment) for label in _JOB_CARD_LABELS):
        return True
    wage = _norm(mat.primary.get("wage_text") or "")
    factory = _norm(mat.primary.get("factory_name") or "")
    if wage and wage in text and factory and factory in text:
        return True
    return bool(wage and wage in text and any(w in segment for w in ("在招", "招聘", "名额", "过来面试")))


def _segment_ok(segment: str, mat: Material) -> bool:
    if not _numbers_ok(segment, _corpus(mat)):
        return False
    if not _addresses_ok(segment, mat):
        return False
    if _leaks_other_job(segment, mat):
        return False
    if mat.booked and _is_job_sale(segment, mat):
        return False
    return True


_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;\n])")


def _guard_part(part: str, mat: Material) -> str:
    """逐句校验：违规的句子剔除，其余保留（保住模型自然措辞）。"""
    kept: list[str] = []
    for segment in _SENTENCE_SPLIT.split(part):
        if segment.strip() and _segment_ok(segment, mat):
            kept.append(segment)
    return "".join(kept).strip()


def _filter_media(part: str, mat: Material) -> str:
    allowed = set(mat.media)

    def _keep(match: re.Match[str]) -> str:
        return match.group(0) if match.group(0) in allowed else ""

    return _MEDIA_FULL.sub(_keep, part).strip()


def _parts_of(data: dict[str, Any]) -> list[str]:
    raw = data.get("parts")
    if isinstance(raw, list):
        parts = [str(p).strip() for p in raw if str(p or "").strip()]
        if parts:
            return parts
    return _split_parts(str(data.get("reply") or ""))


def _job_info_present(parts: list[str], mat: Material) -> bool:
    """这三段里有没有真的把主推岗位说出去（决定 offer_sent 是否置位）。"""
    if not mat.primary:
        return False
    text = _norm("\n".join(parts))
    factory = _norm(mat.primary.get("factory_name") or "")
    wage = _norm(mat.primary.get("wage_text") or "")
    place = _norm(mat.primary.get("place") or "")
    return bool(factory and factory in text and (wage in text or place in text))


def _booked_confirm(slots: dict[str, Any]) -> str:
    """已约客户、模型又只发了岗位卡时的最小事实兜底（不是常规话术分支）。"""
    when_txt = "，".join(
        x
        for x in (
            str(slots.get("interview_window") or ""),
            str(slots.get("interview_place") or ""),
        )
        if x
    )
    return "你之前已经约好面试啦" + (
        f"（{when_txt}），到时候直接联系我就行~有其他想了解的也随时问我。"
        if when_txt
        else "，到时候直接联系我就行~有其他想了解的也随时问我。"
    )


def _fallback_result(
    state: dict[str, Any],
    text: str,
    now: datetime | None,
    slots: dict[str, Any],
    action: str | None = None,
) -> FlowResult:
    """模型输出被护栏清空 → 回退素材原文（确定性话术）。"""
    if slots.get("booked"):
        reply = _booked_confirm(slots)
        return FlowResult(
            reply=reply,
            parts=[reply],
            stage=STAGE_DONE,
            slots=slots,
            finished=True,
            action=action,
        )
    probe = copy.deepcopy(state)
    probe["stage"] = str(state.get("stage") or STAGE_ASK_CITY)
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


def apply_result(
    state: dict[str, Any],
    data: dict[str, Any],
    text: str = "",
    now: datetime | None = None,
    material: Material | None = None,
) -> FlowResult:
    """把模型输出落成状态：回复归模型，事实与边界归代码。"""
    slots: dict[str, Any] = state.setdefault("slots", {})
    slots.update(_clean_slots(data.get("slots")))
    # 档案沿用同一份槽位，只是来源不同（模型单独给的 profile 对象）
    slots.update(_clean_profile(data.get("profile")))
    when = next_interview(now)
    # 模型这一轮可能才把城市抽出来（a_step 建素材时还没有岗位）：
    # 落完槽位后按最新 slots 重建一次素材，护栏才能拿到本轮真实岗位
    mat = build_material(
        state,
        text,
        now=now,
        kb_body=material.kb_body if material else "",
        kb_repeat=material.kb_repeat if material else False,
        script=material.script if material else "",
        sent_summary=material.sent_summary if material else "",
    )
    mat.booked = bool(slots.get("booked"))

    stage = str(data.get("stage") or state.get("stage") or STAGE_ASK_CITY)
    if stage not in ALLOWED_STAGES:
        stage = str(state.get("stage") or STAGE_ASK_CITY)

    # kb 只是插问标签，不落成终态
    if stage == STAGE_KB:
        stage = str(state.get("stage") or STAGE_ASK_INTERVIEW)

    requested = stage
    action = data.get("action")
    action = action if action in (ACTION_BOOK, ACTION_GAVE_UP, ACTION_HANDOFF) else None
    finished = bool(data.get("finished")) or stage == STAGE_DONE

    # ① 媒体清单：清单外的标记直接删（模型看见什么才能发什么）
    raw_parts = [_filter_media(part, mat) for part in _parts_of(data)]
    # ② 事实护栏：数字/地址/三段同源/已约不推销
    parts: list[str] = []
    dropped = False
    for part in raw_parts:
        if not part:
            continue
        kept = _guard_part(part, mat)
        if kept:
            parts.append(kept)
        elif part.strip():
            dropped = True

    # 岗位介绍轮如果出现混用其他岗位的事实，整轮回退主推岗位的素材原文：
    # 三段必须同源，宁可发原文，也不发一条混了工价和地点的拼接话
    intro_turn = bool(
        mat.primary
        and not mat.booked
        and not slots.get("interview_offer_sent")
        and stage in (STAGE_SEND_INFO, STAGE_ASK_INTERVIEW)
    )
    if dropped and intro_turn:
        parts = send_info_parts(slots, when)

    # ③ 已发岗位标记：模型确实把主推岗位说出去了，才允许下一轮进邀约
    if not slots.get("booked") and _job_info_present(parts, mat):
        if not slots.get("interview_offer_sent"):
            slots["interview_offer_sent"] = True
            if stage == STAGE_SEND_INFO:
                stage = STAGE_ASK_INTERVIEW

    if slots.get("booked"):
        # 已约硬规则：不再推销、不能再约。只保留答疑/确认/改约的措辞
        action = None
        stage, finished = STAGE_DONE, True
    else:
        # 档案兜底：模型嘴上说约好了但没给姓名手机，按 collect 处理
        if stage in (STAGE_COLLECT, STAGE_DONE):
            slots["interview_agreed"] = True

        # 护栏：槽位没齐，不许往后跳
        ceiling = _max_stage(slots)
        if _STAGE_ORDER.get(stage, 0) > _STAGE_ORDER[ceiling]:
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

        if action == ACTION_BOOK and not slots.get("booked"):
            action = None
            stage, finished = STAGE_COLLECT, False

    if stage == STAGE_DONE and not finished:
        finished = True

    # ④ 模型想约但资料不齐：回复必须把缺的字段要回来（事实性纠偏，不是另起话术）
    if action is None and stage == STAGE_COLLECT and slots.get("booked") is not True:
        reply_joined = "\n".join(parts)
        if ("姓名" not in reply_joined) and (not slots.get("name") or not slots.get("phone")):
            probe = copy.deepcopy(state)
            probe["stage"] = STAGE_COLLECT
            probe["slots"] = dict(slots)
            ask = fallback_step(probe, text, now=now)
            parts = ask.parts or parts

    # ⑤ 空回复 / 护栏全剔：回退素材原文
    if not parts:
        return _fallback_result(state, text, now, slots, action)

    state["stage"] = stage
    return FlowResult(
        reply="",
        parts=parts,
        stage=stage,
        slots=slots,
        finished=finished,
        action=action,
    )


def _deterministic(
    state: dict[str, Any],
    text: str,
    now: datetime | None,
    kb_answer: str | None,
    mat: Material,
) -> FlowResult:
    """没有模型/模型挂了：确定性状态机兜底。已约客户不能再被推销岗位。"""
    if mat.booked:
        reply = kb_answer or _booked_confirm(mat.slots)
        return FlowResult(
            reply=reply,
            parts=[reply],
            stage=STAGE_DONE,
            slots=mat.slots,
            finished=True,
        )
    return fallback_step(state, text, now=now, kb_answer=kb_answer)


async def a_step(
    state: dict[str, Any],
    text: str,
    provider: LLMProvider | None,
    now: datetime | None = None,
    kb_answer: str | None = None,
    material: Material | None = None,
) -> FlowResult:
    """一个 turn：模型决定这一轮回什么；只有模型不可用时才走确定性兜底。"""
    mat = material or build_material(
        state, text, now=now, kb_body=kb_answer or ""
    )

    if provider is None:
        return _deterministic(state, text, now, kb_answer, mat)

    try:
        raw = await provider.complete(
            build_messages(state, text, now, material=mat),
            temperature=0.7,
            max_tokens=900,
        )
        data = _parse_json(raw)
    except Exception:  # noqa: BLE001  模型超时/返回乱码，不能让客户收不到话
        return _deterministic(state, text, now, kb_answer, mat)

    result = apply_result(state, data, text, now=now, material=mat)

    # 知识库没命中的提问：仍记一条给运营补话术（模型自由发挥不等于我们知道答案）
    if (
        not kb_answer
        and not result.unknown_question
        and mat.stage in (STAGE_ASK_INTERVIEW, STAGE_COLLECT)
        and looks_like_question(text)
    ):
        result.unknown_question = text
    return result


__all__ = [
    "a_step",
    "apply_result",
    "build_material",
    "build_messages",
    "Material",
    "SYSTEM_PROMPT",
]

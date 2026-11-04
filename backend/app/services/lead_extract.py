"""谈单状态抽取：让模型读最近几轮对话，判断谈到哪一步了。

为什么要单独一次 LLM 调用，而不是塞进回复生成里：

- 回复要"像人说话"，可以口语、可以省略；
- 抽取要"像表单"，必须输出严格 JSON、字段齐全、时间可解析。

两件事混在一个 prompt 里会互相干扰——之前回复被数字校验逼着重写就是例子。

抽取失败绝不影响发消息：调用方先发消息，发完再调这里。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Conversation
from ..models_lead import (
    ALL_STAGES,
    STAGE_ASKING,
    STAGE_BOOKED,
    STAGE_INTENT,
    STAGE_LABEL,
    STAGE_NEW,
    STAGE_ORDER,
    Lead,
    LeadEvent,
    utcnow,
)
from .llm_provider import ChatMessage, LLMProvider, LLMUnavailable

# 低于这个置信度一律不落库，宁可漏记也不要错记
MIN_CONFIDENCE = 0.65

# 约的时间不能早于"现在 - 6 小时"，否则不算约面（已经过去了）
PAST_TOLERANCE = timedelta(hours=6)

_LABELS = "\n".join(f"- {k}：{v}" for k, v in STAGE_LABEL.items())

SYSTEM_PROMPT = f"""你是招聘客服的谈单记录员。你的任务**不是回复客户**，而是阅读客服与客户的对话，
判断这次谈单进行到哪一步，并输出严格的 JSON。

## 状态定义

{_LABELS}

## 主流程

new → asking → intent → booked → interviewed → hired

分支：no_show（约了没来）、gave_up（客户不去了）、unsuitable（条件不符）、dormant（长期沉默）

## 判定要点（最重要）

**booked（已约面）必须同时满足三条，缺一条都不算：**

1. 客户表达了确定意愿：可以 / 行 / 去 / 好的 / 没问题（含"明天可以去面试吗"这种请求）
2. **有明确到日期的时间**：明天 / 后天 / 周一 / 11月5号 —— **不要求具体到几点**
   （招聘场景里"明天过来"就是约上了，钟点可以到厂再定）
3. 我方明确答应了：我们说"可以""能安排""行"，就算确认
   **后续追问年龄、要身份证、问住哪里，不影响已经成立的约面**

**只有时间没有答应、或只有意愿没有时间 → 一律判 intent。**

反例（都不能判 booked）：
- 客户说"有空我过去看看"，没有具体日期 → intent
- 我们说"你什么时候方便"，客户没回 → 保持原状态
- 客户说"你们在招什么"，只是打听 → asking

**时间的填法：**
- 知道日期但不知道钟点 → 填当天 09:00，并在 reason 里写明"具体钟点未定"
- 知道日期和钟点 → 照实填

**从客户话里抽信息：**
- 客户说"我32""今年40了"→ age
- 客户说"我在佛山"→ city
- 客户说"太远了""工资太低""我不去了"→ gave_up
- 客户说"我55了""女的可以吗（岗位限男）"→ unsuitable

**不允许倒退**：如果当前状态是 booked，除非客户明确说不去（gave_up）或改期，
否则不要退回 asking/intent。

## 输出格式

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：

{{
  "stage": "booked",
  "interview_at": "2026-11-05T09:00:00+08:00",
  "interview_place": "番禺立信电子厂",
  "job_title": "广州番禺电子厂普工",
  "age": null,
  "city": "广州",
  "intent": 4,
  "confidence": 0.86,
  "reason": "客户问明天能否面试，我方答可以并安排，双方确认明天"
}}

字段规则：
- stage 必须取上面 10 个之一
- interview_at：ISO 8601，带时区；**判 booked 时必填，判其他状态填 null**
- interview_place / job_title / city / age：没提到就 null，**不要编**
- intent：1-5 的整数，5 = 明确要来
- confidence：0-1 的小数，表示你对 stage 判断的把握
- reason：一句话说明依据，指明是哪几句话让你这么判

## 时间基准

今天的日期是 {{today}}（{{weekday}}），当前时间 {{now}}。
对话里说的"明天""后天""周一"都要以此为准。
如果最后一条客户消息不是今天发的，以那条消息的时间为准。"""


def _weekday_cn(d: datetime) -> str:
    return "周" + "一二三四五六日"[d.weekday()]


def build_messages(
    history: Sequence[dict[str, Any]],
    current_stage: str,
    *,
    now: datetime | None = None,
) -> list[ChatMessage]:
    """组装抽取用的消息。history 是 [{"role": "customer|agent", "text": "..."}]。"""
    ref = now or datetime.now(timezone.utc)
    local = ref.astimezone(timezone(timedelta(hours=8)))

    system = SYSTEM_PROMPT.replace("{today}", local.strftime("%Y-%m-%d")).replace(
        "{weekday}", _weekday_cn(local)
    ).replace("{now}", local.strftime("%H:%M"))

    lines: list[str] = []
    for item in history:
        role = "客户" if item.get("role") == "customer" else "客服"
        at = item.get("at")
        prefix = f"[{at}] " if at else ""
        lines.append(f"{prefix}{role}：{item.get('text') or ''}")

    user = (
        f"当前状态：{current_stage}（{STAGE_LABEL.get(current_stage, current_stage)}）\n\n"
        f"对话记录：\n" + "\n".join(lines if lines else ["（无）"])
    )
    return [ChatMessage(role="system", content=system), ChatMessage(role="user", content=user)]


def parse_json_loose(text: str) -> dict[str, Any] | None:
    """模型有时会包 ```json 或前后加解释，这里只截取第一个 { 到最后一个 }。"""
    if not text:
        return None
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _parse_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        # 模型常漏时区，按东八区理解
        dt = dt.replace(tzinfo=timezone(timedelta(hours=8)))
    return dt


def _to_naive_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def normalize(
    data: dict[str, Any],
    current_stage: str,
    *,
    now: datetime | None = None,
) -> tuple[dict[str, Any] | None, str]:
    """把模型输出规整成可信的记录。返回 (结果, 拒绝理由)。"""
    ref = now or datetime.now(timezone.utc)

    stage = str(data.get("stage") or "").strip().lower()
    if stage not in ALL_STAGES:
        return None, f"未知状态: {stage!r}"

    try:
        confidence = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence < MIN_CONFIDENCE:
        return None, f"置信度不足 {confidence:.2f} < {MIN_CONFIDENCE}"

    interview_at = _parse_dt(data.get("interview_at"))

    # 判 booked 却没有可解析的时间 -> 降级成 intent，绝不虚报约面
    note = ""
    if stage == STAGE_BOOKED:
        if interview_at is None:
            stage, note = STAGE_INTENT, "判了 booked 但时间不可解析，降级为 intent"
        elif interview_at < ref - PAST_TOLERANCE:
            stage, note = STAGE_INTENT, "时间已过去，不算约面，降级为 intent"

    # 不允许自动倒退（改了时间仍算 booked，不算倒退）
    cur = current_stage or STAGE_NEW
    if (
        stage in STAGE_ORDER
        and cur in STAGE_ORDER
        and STAGE_ORDER[stage] < STAGE_ORDER[cur]
    ):
        return None, f"拒绝倒退: {cur} -> {stage}"

    try:
        intent = int(data.get("intent") or 0)
    except (TypeError, ValueError):
        intent = 0
    intent = max(0, min(5, intent))

    age = data.get("age")
    try:
        age_val = int(age) if age is not None else None
    except (TypeError, ValueError):
        age_val = None
    if age_val is not None and not (16 <= age_val <= 70):
        age_val = None

    def _text(key: str, limit: int) -> str | None:
        val = data.get(key)
        if not isinstance(val, str):
            return None
        val = val.strip()
        return val[:limit] if val else None

    return (
        {
            "stage": stage,
            "interview_at": _to_naive_utc(interview_at) if stage == STAGE_BOOKED else None,
            "interview_place": _text("interview_place", 128),
            "job_title": _text("job_title", 128),
            "age": age_val,
            "city": _text("city", 32),
            "intent": intent,
            "confidence": round(confidence, 3),
            "reason": _text("reason", 255) or "",
            "note": note,
        },
        "",
    )


async def extract(
    provider: LLMProvider,
    history: Sequence[dict[str, Any]],
    current_stage: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """调一次模型做抽取。任何失败都返回 ok=False，调用方照常往下走。"""
    if not history:
        return {"ok": False, "reason": "没有对话内容"}
    if provider is None:
        return {"ok": False, "reason": "未配置大模型"}

    try:
        raw = await provider.complete(
            build_messages(history, current_stage, now=now)
        )
    except LLMUnavailable as exc:
        return {"ok": False, "reason": f"模型调用失败：{exc}"}

    data = parse_json_loose(raw)
    if data is None:
        return {"ok": False, "reason": f"模型输出不是 JSON：{raw[:80]!r}"}

    record, why = normalize(data, current_stage, now=now)
    if record is None:
        return {"ok": False, "reason": why}
    return {"ok": True, "record": record}


def _event_type(old_stage: str, new_stage: str, old_at, new_at) -> str:
    if new_stage == STAGE_BOOKED:
        if old_stage == STAGE_BOOKED and old_at and new_at and old_at != new_at:
            return "rescheduled"
        if old_stage != STAGE_BOOKED:
            return "scheduled"
    if new_stage == "no_show":
        return "no_show"
    return "stage_change"


async def observe(
    session: AsyncSession,
    conversation: Conversation,
    history: Sequence[dict[str, Any]],
    *,
    provider: LLMProvider | None,
    message_id: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """抽取并落库。同一条消息重复上报是幂等的。"""
    lead = (
        await session.execute(select(Lead).where(Lead.conversation_id == conversation.id))
    ).scalar_one_or_none()

    if lead is None:
        lead = Lead(conversation_id=conversation.id, stage=STAGE_NEW, updated_by="system")
        session.add(lead)
        await session.flush()

    if message_id and lead.last_message_id == message_id:
        return {"changed": False, "reason": "同一条消息已处理", "stage": lead.stage}

    result = await extract(provider, history, lead.stage, now=now)
    if not result.get("ok"):
        return {"changed": False, "reason": result.get("reason", "抽取失败"), "stage": lead.stage}

    rec = result["record"]
    new_stage = rec["stage"]
    old_stage = lead.stage
    old_at = lead.interview_at

    unchanged = new_stage == old_stage and rec["interview_at"] == old_at
    if unchanged:
        lead.last_message_id = message_id or lead.last_message_id
        return {"changed": False, "reason": "状态未变化", "stage": lead.stage}

    lead.stage = new_stage
    lead.interview_at = rec["interview_at"]
    lead.interview_place = rec["interview_place"] or lead.interview_place
    lead.job_title = rec["job_title"] or lead.job_title
    lead.age = rec["age"] if rec["age"] is not None else lead.age
    lead.city = rec["city"] or lead.city
    lead.intent = rec["intent"]
    lead.confidence = rec["confidence"]
    lead.pending_confirm = False
    lead.updated_by = "llm"
    lead.last_message_id = message_id or lead.last_message_id

    payload = {
        "interview_at": rec["interview_at"].isoformat() if rec["interview_at"] else None,
        "interview_place": rec["interview_place"],
        "job_title": rec["job_title"],
        "reason": rec["reason"],
        "confidence": rec["confidence"],
        "note": rec["note"],
    }
    session.add(
        LeadEvent(
            conversation_id=conversation.id,
            event_type=_event_type(old_stage, new_stage, old_at, rec["interview_at"]),
            from_stage=old_stage,
            to_stage=new_stage,
            payload=json.dumps(payload, ensure_ascii=False),
            source="llm",
            message_id=message_id,
        )
    )
    await session.commit()

    return {
        "changed": True,
        "from_stage": old_stage,
        "stage": new_stage,
        "interview_at": rec["interview_at"].isoformat() if rec["interview_at"] else None,
        "reason": rec["reason"],
        "confidence": rec["confidence"],
    }

"""会话日志的读写与状态投影。

状态不是存出来的，是从事件里算出来的：

    events[0..n] --project--> {stage, slots, history, actions}

这样做的好处（都是踩过的坑）：
- 客户投诉"为什么问我两次性别"，回放事件就能看到当时 stage 是什么
- 改流程逻辑后，老会话照样能投影出正确状态，不用迁移数据
- 接 LLM 时上下文直接取 history，不会因为覆盖写而丢掉前因
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models_flow import FlowEvent
from .flow_engine import PROFILE_KEYS, STAGE_ASK_CITY, new_state

EVENT_INBOUND = "inbound"
EVENT_REPLY = "reply"
EVENT_SLOT = "slot_set"
EVENT_STAGE = "stage_change"
EVENT_ACTION = "action"
EVENT_PROFILE = "profile"
EVENT_RESET = "reset"


def project(events: list[FlowEvent]) -> dict[str, Any]:
    """把事件流投影成当前状态。纯函数，可单测。"""
    state = new_state()
    history: list[dict[str, str]] = []
    actions: list[dict[str, Any]] = []
    for event in events:
        try:
            body = json.loads(event.body or "{}")
        except json.JSONDecodeError:
            continue
        if event.type == EVENT_RESET:
            state = new_state()
            history = []
            actions = []
        elif event.type == EVENT_INBOUND:
            history.append({"role": "customer", "text": str(body.get("text") or "")})
        elif event.type == EVENT_REPLY:
            history.append({"role": "agent", "text": str(body.get("text") or "")})
        elif event.type == EVENT_SLOT:
            key = str(body.get("key") or "")
            if key:
                state.setdefault("slots", {})[key] = body.get("value")
        elif event.type == EVENT_STAGE:
            state["stage"] = str(body.get("to") or STAGE_ASK_CITY)
        elif event.type == EVENT_PROFILE:
            # 档案和槽位同源：回放时两边都写上，/state 的 slots 与 profile 不会打架
            profile = state.setdefault("profile", {})
            slots = state.setdefault("slots", {})
            if isinstance(body, dict):
                for key, value in body.items():
                    if key in PROFILE_KEYS and value not in (None, ""):
                        profile[key] = value
                        slots[key] = value
        elif event.type == EVENT_ACTION:
            actions.append(body)
    state["history"] = history
    state["actions"] = actions
    state["turns"] = len([h for h in history if h["role"] == "customer"])
    return state


async def load_events(session: AsyncSession, session_key: str) -> list[FlowEvent]:
    rows = await session.execute(
        select(FlowEvent)
        .where(FlowEvent.session_key == session_key)
        .order_by(FlowEvent.seq, FlowEvent.id)
    )
    return list(rows.scalars())


async def append_events(
    session: AsyncSession, session_key: str, records: list[tuple[str, dict[str, Any]]]
) -> None:
    """追加事件。seq 从已有的最大值往后排，保证同会话内单调。"""
    rows = await session.execute(
        select(FlowEvent.seq)
        .where(FlowEvent.session_key == session_key)
        .order_by(FlowEvent.seq.desc())
        .limit(1)
    )
    seq = int(rows.scalar() or 0)
    for kind, body in records:
        seq += 1
        session.add(
            FlowEvent(
                session_key=session_key,
                seq=seq,
                type=kind,
                body=json.dumps(body, ensure_ascii=False),
            )
        )
    await session.commit()


def diff_slots(before: dict[str, Any], after: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """只记录变化的槽位，避免每轮写一堆重复事件。"""
    changes: list[tuple[str, dict[str, Any]]] = []
    for key, value in (after or {}).items():
        if before.get(key) != value:
            changes.append((EVENT_SLOT, {"key": key, "value": value}))
    return changes


def profile_of(slots: dict[str, Any]) -> dict[str, Any]:
    """从槽位里摘出档案字段（档案和业务槽位同源，不另存一份）。"""
    return {
        key: (slots or {}).get(key)
        for key in PROFILE_KEYS
        if (slots or {}).get(key) not in (None, "")
    }


def diff_profile(
    before: dict[str, Any], after_slots: dict[str, Any]
) -> list[tuple[str, dict[str, Any]]]:
    """只记本轮变了的档案键值；空值不记，免得把已有档案覆盖成空。"""
    changes = {
        key: value
        for key, value in profile_of(after_slots).items()
        if (before or {}).get(key) != value
    }
    return [(EVENT_PROFILE, changes)] if changes else []


def build_context(state: dict[str, Any], limit: int = 8) -> dict[str, Any]:
    """给 LLM 用的上下文：当前槽位 + 最近几轮对话。"""
    return {
        "stage": state.get("stage"),
        "slots": {k: v for k, v in (state.get("slots") or {}).items() if v},
        "recent": (state.get("history") or [])[-limit:],
    }

"""对话会话日志（append-only）。

参考 DeepSeek Harness 的 Session 设计：
- 每一轮只追加事件，不覆盖、不删除 → 可回放、可审计
- 当前状态（stage / 槽位）不是存下来的，而是**从头投影**出来的
- 后续要接 LLM 时，上下文 = 投影出的近期对话 + 当前槽位，而不是裸 history

事件类型：
    inbound      客户来消息
    reply        我方发出的回复
    slot_set     槽位被更新（body: {key, value}）
    stage_change 阶段推进（body: {from, to}）
    profile      档案字段变化（body: {key: value}，本轮只记变了的键）
    action       副作用（约面试 / 转人工）
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class FlowEvent(Base):
    __tablename__ = "flow_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    # 会话标识：用 4222 的 conversation_id（跨端唯一）
    session_key: Mapped[str] = mapped_column(String(64), index=True)
    # 单调递增，保证同一会话内顺序稳定
    seq: Mapped[int] = mapped_column(Integer, default=0, index=True)
    type: Mapped[str] = mapped_column(String(16), index=True)
    body: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )


__all__ = ["FlowEvent", "utcnow"]

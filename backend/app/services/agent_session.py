"""AgentSession：每个客户一个标准智能体上下文（session）。

借鉴 DeepSeek Harness 的 session/context 设计（只借思想，不引依赖）：
- 一个会话 = 一个**持久的轮次累积对象** [{role, content, ts}]，不是每次请求孤立处理：
  我方发出去的每一段（话术/卡片/追问）都是 assistant 轮次，客户每条消息是 user 轮次
- 压缩策略取最简版（compaction-basic 的思想）：只保留最近 N 条，更早的丢弃
- **打回的草稿不入上下文**——客户没收到的东西不存在，只入最终发出的

持久化复用 flow 会话的事件日志（flow_events，append-only，**不建新表**）：
- inbound 事件 → user 轮次（api_flow.flow_answer 每轮落库）
- reply 事件   → assistant 轮次（实际发出的文本，含话术/卡片段）
- reset 事件   → 上下文清空（与 stage/slots 投影同一条规则）
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from . import flow_session as store

# 最简压缩：上下文只保留最近 12 条轮次（约 6 个来回），更早的丢弃
TRANSCRIPT_LIMIT = 12


def _ts_of(event: Any) -> str:
    ts = getattr(event, "created_at", None)
    return ts.isoformat() if hasattr(ts, "isoformat") else ""


def build_transcript(events: list[Any]) -> list[dict[str, str]]:
    """事件流 → 轮次累积。纯函数，可单测。

    与 flow_session.project 的分工：project 算 stage/slots（业务状态），
    这里投影对话本身（智能体上下文）。同一条事件日志，两种读法。
    """
    transcript: list[dict[str, str]] = []
    for event in events:
        if event.type == store.EVENT_RESET:
            transcript.clear()
            continue
        try:
            body = json.loads(event.body or "{}")
        except json.JSONDecodeError:
            continue
        if event.type == store.EVENT_INBOUND:
            text = str(body.get("text") or "").strip()
            if text:
                transcript.append(
                    {"role": "user", "content": text, "ts": _ts_of(event)}
                )
        elif event.type == store.EVENT_REPLY:
            text = str(body.get("text") or "").strip()
            if text:
                transcript.append(
                    {"role": "assistant", "content": text, "ts": _ts_of(event)}
                )
    return transcript


def surface(
    transcript: list[dict[str, str]], limit: int | None = None
) -> list[dict[str, str]]:
    """压缩投影：只保留最近 limit 条轮次（超出丢弃，不做摘要）。"""
    keep = int(limit or TRANSCRIPT_LIMIT)
    if len(transcript) <= keep:
        return list(transcript)
    return list(transcript[-keep:])


async def load_transcript(
    session: AsyncSession, session_key: str, limit: int | None = None
) -> list[dict[str, str]]:
    """从事件日志读某客户的上下文；空会话 → []。"""
    events = await store.load_events(session, session_key)
    return surface(build_transcript(events), limit)


def transcript_lines(transcript: list[dict[str, str]]) -> str:
    """给 Prompt 的投影：「客户：…／你：…」逐轮排列。"""
    return "\n".join(
        f"{'客户' if item['role'] == 'user' else '你'}：{item['content']}"
        for item in transcript
    )

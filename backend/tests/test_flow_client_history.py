"""flow/answer 的客户端聊天记录上下文（agent_session.merge_client_history）。

2026-11-16：服务端投影只有经 /flow/answer 转发的轮次，键鼠人工回复、
补发都不在 events 里。客户端现在把本地最近对话随请求带上，服务端以它
为准构建 LLM/KB 上下文；老客户端不带 → 退回事件投影（向后兼容）。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.api_flow import FlowAnswerIn
from app.services import agent_session

SERVER = [
    {"role": "user", "content": "你好", "ts": "t1"},
    {"role": "assistant", "content": "你好，想找哪里的厂", "ts": "t2"},
]

CLIENT = [
    {"role": "customer", "text": "你好", "at": "11-16 16:00"},
    {"role": "agent", "text": "你好，想找哪里的厂"},
    {"role": "manual", "text": "这行角色不认识，应被丢弃"},
    {"role": "customer", "text": "   "},
    {"role": "customer", "text": "广州有没有厂"},
]


def test_client_history_takes_precedence_and_is_normalized():
    merged = agent_session.merge_client_history(SERVER, CLIENT)
    assert merged == [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好，想找哪里的厂"},
        {"role": "user", "content": "广州有没有厂"},
    ]


def test_empty_client_history_falls_back_to_server_projection():
    for empty in (None, [], [{"role": "customer", "text": ""}]):
        assert agent_session.merge_client_history(SERVER, empty) == SERVER


def test_client_history_is_surfaced_to_transcript_limit():
    rows = [{"role": "customer", "text": f"m{i}"} for i in range(30)]
    merged = agent_session.merge_client_history([], rows)
    assert len(merged) == agent_session.TRANSCRIPT_LIMIT
    assert merged[-1]["content"] == "m29"


def test_request_model_accepts_history_and_rejects_oversize():
    payload = FlowAnswerIn(
        session_key="S:1", text="hi",
        history=[{"role": "customer", "text": "你好"}],
    )
    assert payload.history[0]["text"] == "你好"
    with pytest.raises(ValidationError):
        FlowAnswerIn(session_key="S:1", text="hi", history=[{"role": "customer", "text": "x"}] * 41)

"""把知识库没答上来的原话推给 4222（前端知识库页读的是 4222 的库）。

与 profile_push 同一套约定：
- 8090 不直连 4222 的数据库，走服务间 HTTP，令牌复用 X-Profile-Token
- 尽力而为：没配 token 直接不发，任何异常都吞掉——记不上一条未知问题，
  不能让客户连那句兜底话都收不到
- 去重放在 4222 侧做（同 question 归一化后累加 occurrence_count），
  8090 只负责把原话原样送过去
"""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:4222/api/v1/agent/unknown-questions"
TIMEOUT = 2.0


def normalize_question(text: str) -> str:
    """归一化：去掉首尾空白、折叠连续空白、去掉结尾的问号。

    「 体检要花钱吗 ？」和「体检要花钱吗」是同一条，不该记两遍。
    """
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    return cleaned.rstrip("?？。.!！~ ")


def _headers(token: str) -> dict[str, str]:
    return {"X-Profile-Token": token, "Content-Type": "application/json"}


async def record(
    text: str,
    device_code: str = "",
    session_key: str = "",
) -> bool:
    """记一条未知问题。成功 True，其余一律 False（不抛异常）。"""
    question = normalize_question(text)
    if not question:
        return False
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return False
    body: dict[str, Any] = {"question": question}
    if device_code:
        body["device_code"] = device_code
    if session_key:
        body["external_conversation_id"] = session_key
    url = os.getenv("FLOW_UNKNOWN_QUESTIONS_URL", DEFAULT_URL)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(url, json=body, headers=_headers(token))
        return 200 <= resp.status_code < 300
    except Exception:  # noqa: BLE001  4222 挂了不能连累客户回复
        return False


__all__ = ["normalize_question", "record"]

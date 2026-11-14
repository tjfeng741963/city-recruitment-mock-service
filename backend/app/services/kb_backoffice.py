"""后台知识库匹配（8090 → 4222 GET /api/v1/agent/kb-match）。

为什么要有这一层：网页「知识管理 → 知识库」写的是 4222 的 knowledge_items，
而回复链路读的是本库的 kb_entry / kb_faq，两边没有任何同步。运营在页面上
填的知识，过去对 AI 回复完全无效——用户输入了、存了，但没人用。

这里在「kb_faq 未命中 + kb_placeholder 未命中」之后兜一层：
调用 4222 的匹配接口，命中就把正文当答案用。

失败语义与 job_lookup 一致：任何异常返回 None，上层照常走兜底话术，
不会因为 4222 挂了就不回复。
"""

from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_MATCH_URL = "http://127.0.0.1:4222/api/v1/agent/kb-match"
TIMEOUT = 3.0


async def _fetch_match(text: str, city: str, token: str, url: str) -> dict[str, Any] | None:
    """只在这一层碰网络，测试 monkeypatch 这里。"""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            url,
            params={"text": text, "city": city},
            headers={"X-Profile-Token": token},
        )
        resp.raise_for_status()
        data = resp.json()
    hit = data.get("hit") if isinstance(data, dict) else None
    return hit if isinstance(hit, dict) else None


async def lookup_backoffice(text: str, city: str = "") -> dict[str, Any] | None:
    """按客户原话查网页后台填的知识条目。命中返回 {id,title,content}。"""
    query = (text or "").strip()
    if not query:
        return None
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return None
    url = os.getenv("FLOW_KB_MATCH_URL", DEFAULT_MATCH_URL)
    try:
        return await _fetch_match(query, (city or "").strip(), token, url)
    except Exception:  # noqa: BLE001  超时/4222 挂了/返回乱码：等同于没命中
        return None


__all__ = ["lookup_backoffice", "DEFAULT_MATCH_URL", "TIMEOUT"]

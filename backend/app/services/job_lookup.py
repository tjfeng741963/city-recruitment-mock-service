"""按城市向 4222 查真实岗位（docs/对齐-配置分发与按设备话术.md §3/§5）。

- 数据源：GET /api/v1/agent/jobs?city=（4222 侧做城市别名归一，这里只透传）
- 鉴权：X-Profile-Token（复用 FLOW_PROFILE_TOKEN，与档案推送同一通道）
- 60s 内存缓存：同城 60s 内只发一次请求；token 为空/超时(3s)/异常 → 返回 []
- 失败也按空结果缓存，避免 4222 挂掉时每个请求都白等 3s
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

DEFAULT_JOBS_URL = "http://127.0.0.1:4222/api/v1/agent/jobs"
TIMEOUT = 3.0
CACHE_TTL = 60.0

# {city: (过期时刻 monotonic, items)}
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def clear_cache() -> None:
    """测试用：清空缓存，保证用例互不串数据。"""
    _cache.clear()


async def _fetch_items(city: str, token: str, url: str) -> list[dict[str, Any]]:
    """发一次真实请求。只在这层碰网络，测试 monkeypatch 这里。"""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            url, params={"city": city}, headers={"X-Profile-Token": token}
        )
        resp.raise_for_status()
        data = resp.json()
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


async def lookup_jobs(city: str) -> list[dict[str, Any]]:
    """按城市查岗位。任何失败都返回 []，由上层走「已记下，帮你问问」话术。"""
    city = str(city or "").strip()
    if not city:
        return []
    now = time.monotonic()
    cached = _cache.get(city)
    if cached and now < cached[0]:
        return cached[1]
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return []
    url = os.getenv("FLOW_JOBS_URL", DEFAULT_JOBS_URL)
    try:
        items = await _fetch_items(city, token, url)
    except Exception:  # noqa: BLE001  超时/4222 挂了/返回乱码：一律空结果
        items = []
    # 字段齐全的排前面：占位/空壳岗位往往什么都没填，别让它们抢第一位
    items = sorted(items, key=lambda j: (
        not str(j.get("wage_text") or "").strip(),
        not str(j.get("factory_name") or "").strip(),
    ))
    # 全空字段岗位直接剔除——发出去就是「：，，，。」
    filled = [j for j in items if any(
        str(j.get(k) or "").strip() for k in ("wage_text", "hours_text", "welfare_text")
    )]
    if filled:
        items = filled
    else:
        # 远端全是空壳岗位 → 返回空，上层走「帮你问问」话术
        items = []
    _cache[city] = (time.monotonic() + CACHE_TTL, items)
    return items


__all__ = ["lookup_jobs", "clear_cache", "DEFAULT_JOBS_URL", "TIMEOUT", "CACHE_TTL"]

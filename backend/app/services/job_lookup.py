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
DEFAULT_CITIES_URL = "http://127.0.0.1:4222/api/v1/agent/cities"
TIMEOUT = 3.0
CACHE_TTL = 60.0

# {city: (过期时刻 monotonic, items)}
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

# 城市清单缓存：(过期时刻 monotonic, items)
_cities_cache: tuple[float, list[dict[str, Any]]] | None = None


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


async def _fetch_cities(token: str, url: str) -> list[dict[str, Any]]:
    """城市清单。同样只在这一层碰网络。"""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(url, headers={"X-Profile-Token": token})
        resp.raise_for_status()
        data = resp.json()
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


async def lookup_cities() -> list[dict[str, Any]]:
    """后台在招的城市与区县，给「客户说地名」这一步用。

    过去城市识别是 flow_engine 里硬编码的广州/深圳/东莞，运营在后台新建北京
    也认不出来，客户说「我要找北京的工作」直接被当成没说城市。这里改成读库。
    任何失败都返回 []，上层退回硬编码别名，不至于一个字都识别不出。
    """
    global _cities_cache
    now = time.monotonic()
    if _cities_cache and now < _cities_cache[0]:
        return _cities_cache[1]
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return []
    url = os.getenv("FLOW_CITIES_URL", DEFAULT_CITIES_URL)
    try:
        items = await _fetch_cities(token, url)
    except Exception:  # noqa: BLE001  超时/4222 挂了/返回乱码：退回硬编码别名
        items = []
    _cities_cache = (time.monotonic() + CACHE_TTL, items)
    return items


async def lookup_jobs(city: str, vertical_hint: str = "") -> list[dict[str, Any]]:
    """按城市查岗位。任何失败都返回 []，由上层走「已记下，帮你问问」话术。

    `vertical_hint` 是客户这轮明确说的品类（factory / subway）。2026-11-13 实测：
    客户说「我是去工厂，不是去安检」，系统还在推地铁——因为下面的「只推地铁」
    是全局开关，客户说什么都不影响。客户一开口说工厂，开关就不再生效。
    """
    city = str(city or "").strip()
    if not city:
        return []
    hint = vertical_hint if vertical_hint in ("factory", "subway") else ""
    cache_key = f"{city}|{hint}"
    now = time.monotonic()
    cached = _cache.get(cache_key)
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
    # 「只推地铁」是 2026-11-12 运营的阶段性指令。只在客户没表态时生效：
    # 客户明确说去工厂就不过滤，明确说做地铁就强制过滤。
    if hint == "subway":
        filled = _only_subway(filled) or filled
    elif hint == "factory":
        factory_only = [j for j in filled if not _is_subway(j)]
        filled = factory_only or filled
    elif _only_subway_enabled():
        filled = _only_subway(filled) or filled
    if filled:
        items = filled
    else:
        # 远端全是空壳岗位 → 返回空，上层走「帮你问问」话术
        items = []
    _cache[cache_key] = (time.monotonic() + CACHE_TTL, items)
    return items


def _is_subway(job: dict[str, Any]) -> bool:
    text = f"{job.get('factory_name') or ''}{job.get('job_title') or ''}"
    return "地铁" in text or "安检" in text


def _only_subway(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [job for job in jobs if _is_subway(job)]


def _only_subway_enabled() -> bool:
    return os.getenv("FLOW_ONLY_SUBWAY", "1").strip() == "1"


# 客户这几类说法表示「我要工厂」，不能被地铁过滤掉
FACTORY_HINTS = ("工厂", "厂里", "进厂", "普工", "车间", "流水线", "焊工", "叉车")
SUBWAY_HINTS = ("地铁", "安检")


def vertical_hint_of(text: str) -> str:
    """从客户这句话判断他要哪个品类。判断不出来返回空串。"""
    value = text or ""
    if any(word in value for word in FACTORY_HINTS):
        return "factory"
    if any(word in value for word in SUBWAY_HINTS):
        return "subway"
    return ""


__all__ = [
    "lookup_jobs",
    "lookup_cities",
    "vertical_hint_of",
    "clear_cache",
    "DEFAULT_JOBS_URL",
    "DEFAULT_CITIES_URL",
    "TIMEOUT",
    "CACHE_TTL",
]

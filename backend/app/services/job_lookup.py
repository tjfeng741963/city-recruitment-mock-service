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


async def lookup_jobs(
    city: str,
    vertical_hint: str = "",
    device_scope: str = "",
) -> list[dict[str, Any]]:

    """按城市查岗位。任何失败都返回 []，由上层走「已记下，帮你问问」话术。

    品类口径优先级（2026-11-13 合并：设备绑定优先，客户用词兜底）：
      1. device_scope —— 网页按设备下发的 job_scope（subway / all），最权威：
         地铁号就是地铁号，不能因为客户随口说「工厂」就串味。
      2. vertical_hint —— 客户这轮明确说的品类（factory / subway）。
         2026-11-13 实测：客户说「我是去工厂，不是去安检」，系统还在推地铁。
      3. 都没给 → 环境变量 FLOW_ONLY_SUBWAY 的阶段性默认。
    """
    city = str(city or "").strip()
    if not city:
        return []
    hint = vertical_hint if vertical_hint in ("factory", "subway") else ""
    scope = device_scope if device_scope in ("subway", "all") else ""
    # 缓存键必须带口径：同城在设备级/客户级/默认三种口径下结果不同，
    # 混用会把工厂岗漏发给地铁号（反之亦然）。
    cache_key = f"{city}|{scope}|{hint}"
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
    # 口径判定：设备绑定 > 客户用词 > 环境变量默认。
    # 设备级最先——地铁号就是地铁号，不能被客户随口一句「工厂」带跑偏。
    if scope == "all":
        pass                                    # 设备明确不限，谁都不过滤
    elif scope == "subway":
        filled = _only_subway(filled) or filled
    elif hint == "subway":
        filled = _only_subway(filled) or filled
    elif hint == "factory":
        factory_only = [j for j in filled if not _is_subway(j)]
        filled = factory_only or filled
    elif _only_subway_enabled():
        # 2026-11-12 运营阶段性指令「暂时按地铁的来」；客户没表态时才生效
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

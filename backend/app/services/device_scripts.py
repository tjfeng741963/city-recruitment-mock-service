"""按设备话术：从 4222 的 config 接口拉设备绑定的话术并做占位符渲染。

契约（docs/对齐-配置分发与按设备话术.md §1/§5）：
- GET /api/v1/bridge/devices/:code/config → {"version", "scripts": [{stage, city, title, content}]}
- 鉴权沿用服务间通道 X-Profile-Token（复用 FLOW_PROFILE_TOKEN）
- 话术选择顺序：config.scripts 命中 → 知识库 kb_entry → 模型生成
- 命中时 content 里的 {{factory}} {{wage}} {{place}} {{window}} 由代码替换，
  整段直接作为 parts 发给客户，不过模型——防止模型改数字
"""

from __future__ import annotations

import os
import time
import re
from typing import Any

import httpx

from .flow_engine import INTERVIEW_WINDOW

DEFAULT_CONFIG_URL = "http://127.0.0.1:4222/api/v1/bridge/devices/{device_code}/config"
TIMEOUT = 3.0
CACHE_TTL = 60.0

# {device_code: (过期时刻 monotonic, scripts)}
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
# {device_code: (过期时刻 monotonic, factory_name/city/job_scope)}
_meta_cache: dict[str, tuple[float, dict[str, str]]] = {}

EMPTY_META: dict[str, Any] = {
    "factory_name": "", "city": "",
    "vertical_id": 0, "employer_id": 0, "location_id": 0, "position_id": 0,
    "vertical_code": "factory",
    # 设备级岗位口径（subway / all / 空串=跟随环境变量默认）
    "job_scope": "",
}


def clear_cache() -> None:
    """测试用：清空缓存。"""
    _cache.clear()
    _meta_cache.clear()


async def _fetch_scripts(device_code: str, token: str, url: str) -> list[dict[str, Any]]:
    """发一次真实请求。只在这层碰网络，测试 monkeypatch 这里。"""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(url, headers={"X-Profile-Token": token})
        resp.raise_for_status()
        data = resp.json()
    scripts = data.get("scripts") if isinstance(data, dict) else None
    if not isinstance(scripts, list):
        return []
    return [item for item in scripts if isinstance(item, dict)]


async def fetch_scripts(device_code: str) -> list[dict[str, Any]]:
    """拉某设备绑定的话术。任何失败都返回 []，不影响主流程。"""
    device_code = str(device_code or "").strip()
    if not device_code:
        return []
    now = time.monotonic()
    cached = _cache.get(device_code)
    if cached and now < cached[0]:
        return cached[1]
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return []
    url = os.getenv("FLOW_CONFIG_URL", DEFAULT_CONFIG_URL).format(device_code=device_code)
    try:
        scripts = await _fetch_scripts(device_code, token, url)
    except Exception:  # noqa: BLE001  超时/4222 挂了：没有 config 话术就走原逻辑
        scripts = []
    _cache[device_code] = (time.monotonic() + CACHE_TTL, scripts)
    return scripts


def _normalize_meta(data: Any) -> dict[str, Any]:
    """config 响应 → 工厂/城市/品类/招工方/岗位口径。

    知识库 v3 起多了 vertical_id / employer_id / location_id / position_id
    （docs/知识库方案-流程驱动-20261113.md §3.7）：绑了 id 走 kb_faq 硬过滤，
    没绑（0）退回按 factory_name 匹配的旧路径。

    job_scope 是本轮新增的设备级口径：subway 只推地铁/安检，all 不过滤，
    空串 = 跟随环境变量默认。脏值一律当空，避免一个错字把工厂岗全下架。
    """
    if not isinstance(data, dict):
        return dict(EMPTY_META)

    def as_int(value: Any) -> int:
        # bool 是 int 的子类，显式排除，免得 True 被当成 1 号品类
        return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0

    scope = str(data.get("job_scope") or "").strip().lower()
    return {
        "factory_name": str(data.get("factory_name") or ""),
        "city": str(data.get("city") or ""),
        "vertical_id": as_int(data.get("vertical_id")),
        "employer_id": as_int(data.get("employer_id")),
        "location_id": as_int(data.get("location_id")),
        "position_id": as_int(data.get("position_id")),
        # 品类 code：工厂设备查 faq-factory-v1，地铁设备查 faq-subway-v1
        "vertical_code": str(data.get("vertical_code") or "factory"),
        "job_scope": scope if scope in ("subway", "all") else "",
    }


async def _fetch_meta(device_code: str, token: str, url: str) -> dict[str, Any]:
    """发一次真实请求。只在这层碰网络，测试 monkeypatch 这里。"""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(url, headers={"X-Profile-Token": token})
        resp.raise_for_status()
        return _normalize_meta(resp.json())


async def fetch_device_meta(device_code: str) -> dict[str, Any]:
    """拉设备绑定的工厂/城市/品类/招工方。

    GET config（X-Profile-Token，60s 缓存与 fetch_scripts 同款写法），
    任何失败都回空值（通配），流程不中断——4222 挂了顶多做不了知识库过滤，
    不能挡住回复。
    """
    device_code = str(device_code or "").strip()
    if not device_code:
        return dict(EMPTY_META)
    now = time.monotonic()
    cached = _meta_cache.get(device_code)
    if cached and now < cached[0]:
        return cached[1]
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return dict(EMPTY_META)
    url = os.getenv("FLOW_CONFIG_URL", DEFAULT_CONFIG_URL).format(device_code=device_code)
    try:
        meta = await _fetch_meta(device_code, token, url)
    except Exception:  # noqa: BLE001  超时/4222 挂了：按通配走原逻辑
        meta = dict(EMPTY_META)
    _meta_cache[device_code] = (time.monotonic() + CACHE_TTL, meta)
    return meta


def pick_script(scripts: list[dict[str, Any]], stage: str, city: str) -> dict[str, Any] | None:
    """三级匹配：stage+city 精确 → stage 命中且话术 city 为空（通配）→ 仅 stage。

    config 本身就是按设备下的，所以 device 维度不用再比。
    """
    stage = str(stage or "")
    city = str(city or "").strip()
    candidates = [s for s in (scripts or []) if str(s.get("stage") or "") == stage]
    if city:
        for script in candidates:
            if str(script.get("city") or "").strip() == city:
                return script
    for script in candidates:
        if not str(script.get("city") or "").strip():
            return script
    # 城市对不上就不命中：广州的话术发给东莞客户是事故（2026-11-11 模拟实测）
    return None


def render_script(content: str, job: dict[str, Any], window: str = INTERVIEW_WINDOW) -> str:
    """占位符由代码替换（岗位数据为空就替换成空串，绝不把 {{x}} 发给客户）。"""
    job = job or {}
    mapping = {
        "{{factory}}": str(job.get("factory_name") or ""),
        "{{wage}}": str(job.get("wage_text") or ""),
        "{{place}}": str(job.get("place") or ""),
        "{{window}}": str(window or ""),
    }
    # 岗位数据里的任意键都能当占位符（{{job_title}} {{hours_text}} {{age_text}}…）
    for key, value in job.items():
        mapping.setdefault("{{%s}}" % key, str(value or ""))
    text = str(content or "")
    for key, value in mapping.items():
        text = text.replace(key, value)
    # 兜底：没匹配上的占位符一律清空，绝不把 {{x}} 发给客户
    text = re.sub(r"\{\{[a-zA-Z0-9_]+\}\}", "", text)
    return text


__all__ = [
    "fetch_takeover",
    "fetch_scripts",
    "fetch_device_meta",
    "pick_script",
    "render_script",
    "clear_cache",
    "DEFAULT_CONFIG_URL",
    "TIMEOUT",
    "CACHE_TTL",
]

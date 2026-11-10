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


def clear_cache() -> None:
    """测试用：清空缓存。"""
    _cache.clear()


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
    return candidates[0] if candidates else None


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
    "fetch_scripts",
    "pick_script",
    "render_script",
    "clear_cache",
    "DEFAULT_CONFIG_URL",
    "TIMEOUT",
    "CACHE_TTL",
]

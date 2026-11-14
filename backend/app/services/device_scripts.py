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
    # 设备绑定的工厂（4222 config 下发）：只用于展示/调试与透传，
    # 真正的岗位过滤由 4222 按 device_code 做，这里不做二次裁切。
    "factory_ids": [],
    "factories": [],
    # 岗位级硬编码话术（4222 config 下发，见 fetch_position_scripts）：
    # 按 position_id + stage 索引，命中就整段直发，不让模型改写
    "position_scripts": [],
}


def _empty_meta() -> dict[str, Any]:
    """空 meta 的独立副本：列表字段不能共用同一个对象，否则一处 append 污染全局。"""
    meta = dict(EMPTY_META)
    meta["factory_ids"] = []
    meta["factories"] = []
    meta["position_scripts"] = []
    return meta


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

    factory_ids / factories 是设备绑定的工厂清单（4222 新增下发）。
    只做宽松清洗：非 list → []，元素非 int / 非 dict 的丢掉，绝不抛异常——
    这两个字段一旦解析失败挡住整条 meta，知识库过滤和岗位口径会一起失效。

    position_scripts 是岗位级硬编码话术（4222 config 新增）：
    [{position_id, stage, title, content, media:[{name,kind,sha256}]}]。
    stage 固定取 greet / send_info / ask_interview / booked / unanswered。
    同样只做宽松清洗：一条坏话术只丢它自己，不能连累其它岗位的话术。
    """
    if not isinstance(data, dict):
        return _empty_meta()

    def as_int(value: Any) -> int:
        # bool 是 int 的子类，显式排除，免得 True 被当成 1 号品类
        return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0

    def as_ids(value: Any) -> list[int]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, int) and not isinstance(item, bool)]

    def as_factories(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [
            {"id": item.get("id"), "name": str(item.get("name") or "")}
            for item in value
            if isinstance(item, dict)
        ]

    def as_media(value: Any) -> list[dict[str, str]]:
        if not isinstance(value, list):
            return []
        return [
            {
                "name": str(item.get("name") or ""),
                "kind": str(item.get("kind") or ""),
                "sha256": str(item.get("sha256") or ""),
            }
            for item in value
            if isinstance(item, dict)
        ]

    def as_position_scripts(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        scripts: list[dict[str, Any]] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            stage = str(item.get("stage") or "").strip()
            content = str(item.get("content") or "")
            # 没 stage 或没正文的条目发出去就是空气（还挡住了正常回退），直接丢
            if not stage or not content.strip():
                continue
            scripts.append(
                {
                    "position_id": as_int(item.get("position_id")),
                    "stage": stage,
                    "title": str(item.get("title") or ""),
                    "content": content,
                    "media": as_media(item.get("media")),
                }
            )
        return scripts

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
        "factory_ids": as_ids(data.get("factory_ids")),
        "factories": as_factories(data.get("factories")),
        "position_scripts": as_position_scripts(data.get("position_scripts")),
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
        return _empty_meta()
    now = time.monotonic()
    cached = _meta_cache.get(device_code)
    if cached and now < cached[0]:
        return cached[1]
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return _empty_meta()
    url = os.getenv("FLOW_CONFIG_URL", DEFAULT_CONFIG_URL).format(device_code=device_code)
    try:
        meta = await _fetch_meta(device_code, token, url)
    except Exception:  # noqa: BLE001  超时/4222 挂了：按通配走原逻辑
        meta = _empty_meta()
    _meta_cache[device_code] = (time.monotonic() + CACHE_TTL, meta)
    return meta


async def fetch_position_scripts(device_code: str) -> list[dict[str, Any]]:
    """按设备拉「岗位级硬编码话术」（config.position_scripts）。

    与 fetch_device_meta 共用同一份 config 响应和 60s 缓存，所以这里不额外打网络：
    meta 里已经解析好 position_scripts（_normalize_meta），取出来即可。
    任何失败都返回 []，上层回退到原逻辑（知识库/模型），绝不影响回复。
    """
    meta = await fetch_device_meta(device_code)
    scripts = meta.get("position_scripts") if isinstance(meta, dict) else None
    return list(scripts) if isinstance(scripts, list) else []


def pick_position_script(
    scripts: list[dict[str, Any]], position_id: int | None, stage: str
) -> dict[str, Any] | None:
    """按 position_id + stage 精确匹配；只允许回退到「通用条目」(position_id=0)。

    三级匹配：
      1. position_id 一致且 stage 一致 → 这个岗位的话术
      2. 否则用通用条目（position_id=0，适用于所有岗位）
      3. 都没有 → None（调用方走原逻辑，不得空回复）

    **绝不回退到「别家岗位」的话术**：2026-11-14 实测，一条挂在南昌岗位上的
    话术被套给了广州客户（渲染时还用广州的数据填充占位符），客户会收到
    「广州地铁安检在招安检员 / 南昌的面试地点」这种事实错配。
    没有精确匹配就该走知识库或模型，而不是借别人的文案。

    position_id 为 0/None 时（客户还没选定岗位，如加好友首句）只走第 2 级。
    """
    stage_name = str(stage or "")
    candidates = [s for s in (scripts or []) if str(s.get("stage") or "") == stage_name]
    if not candidates:
        return None

    def pid_of(script: dict[str, Any]) -> int:
        value = script.get("position_id")
        if isinstance(value, bool):
            return 0
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    pid = pid_of({"position_id": position_id}) if position_id is not None else 0
    if pid:
        for script in candidates:
            if pid_of(script) == pid:
                return script
    for script in candidates:
        if pid_of(script) == 0:
            return script
    return None


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
    """占位符由代码替换（岗位数据为空就替换成空串，绝不把 {{x}} 发给客户）。

    【图片:名称】/【视频:名称】这类媒体标记**原样保留**：客户端靠它发图，
    这里既不转义也不过滤。
    """
    job = job or {}
    mapping = {
        "{{factory}}": str(job.get("factory_name") or ""),
        "{{wage}}": str(job.get("wage_text") or ""),
        # 冻结契约里吃住写的是 {{welfare}}，岗位字段叫 welfare_text
        "{{welfare}}": str(job.get("welfare_text") or ""),
        "{{place}}": str(job.get("place") or ""),
        "{{window}}": str(window or ""),
    }
    # 岗位数据里的任意键都能当占位符（{{job_title}} {{hours_text}} {{age_text}}…）
    for key, value in job.items():
        mapping.setdefault("{{%s}}" % key, str(value or ""))
    text = str(content or "")
    for key, value in mapping.items():
        text = text.replace(key, value)
    # 单花括号兜底：后台编辑框里手打 {factory} 的概率不低（模板语法习惯不同），
    # 只认双花括号会出现「客户收到 {factory} 在招 {job_title}」这种事故。
    # 只替换 mapping 里已知的键名，不碰正文里其他花括号。
    for key, value in mapping.items():
        name = key.strip("{}")
        text = text.replace("{%s}" % name, value)
    # 兜底：没匹配上的占位符一律清空，绝不把 {{x}} 发给客户
    text = re.sub(r"\{\{[a-zA-Z0-9_]+\}\}", "", text)
    return text


__all__ = [
    "fetch_takeover",
    "fetch_scripts",
    "fetch_device_meta",
    "fetch_position_scripts",
    "pick_script",
    "pick_position_script",
    "render_script",
    "clear_cache",
    "DEFAULT_CONFIG_URL",
    "TIMEOUT",
    "CACHE_TTL",
]

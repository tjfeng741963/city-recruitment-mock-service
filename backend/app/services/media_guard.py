"""媒体标记的确定性白名单校验；白名单只由本轮可信素材构造。"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

# 宽匹配用于删除坏标记；合法协议与客户端一致：ASCII 冒号、名称不超过 80 字。
_MARKER = re.compile(r"【(?:图片|视频)\s*[:：][^】]*】")
_VALID = re.compile(r"【(图片|视频):([^】]{1,80})】")


def _key(marker: str) -> tuple[str, str] | None:
    if not isinstance(marker, str):
        return None
    match = _VALID.fullmatch(marker)
    if not match:
        return None
    name = match.group(2).strip()
    if not name or any(char in name for char in ("/", "\\", "\n", "\r")) or ".." in name:
        return None
    return match.group(1), name


def markers_in(text: str) -> list[str]:
    if not isinstance(text, str):
        return []
    keys = dict.fromkeys(key for marker in _MARKER.findall(text) if (key := _key(marker)))
    return [f"【{kind}:{name}】" for kind, name in keys]


def markers_from_refs(refs: Any) -> list[str]:
    """4222 已解析的 media 引用；不按扩展名猜类型，也不借其他岗位的素材。"""
    if not isinstance(refs, list):
        return []
    markers: list[str] = []
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("kind") not in ("image", "video"):
            continue
        name = ref.get("name")
        if not isinstance(name, str):
            continue
        kind = "图片" if ref["kind"] == "image" else "视频"
        marker = f"【{kind}:{name.strip()}】"
        if _key(marker) and marker not in markers:
            markers.append(marker)
    return markers


def filter_parts(parts: Iterable[str], allowed: Iterable[str]) -> list[str]:
    """只移除未授权标记，保留正文、有效媒体和消息分段。"""
    keys = {key for marker in allowed if (key := _key(marker)) is not None}
    cleaned: list[str] = []
    for part in parts:
        value = _MARKER.sub(lambda match: match.group(0) if _key(match.group(0)) in keys else "", part)
        if value != part:
            value = value.strip()
        if value.strip():
            cleaned.append(value)
    return cleaned

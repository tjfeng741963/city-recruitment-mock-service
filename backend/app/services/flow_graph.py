"""节点图：按设备+板块读取 flow_nodes / flow_edges，并判断一条边是否命中。

设计约束：
1. **纯函数优先**。`match_edge` 和 `pick_next` 不碰数据库，参数就是节点/边列表，
   方便单测；只有 `load_graph` 读库。
2. **拉不到就回退**。没有节点图（没跑迁移、设备没配）时返回空图，
   调用方（flow_engine）继续走原来的 if/elif 分支——绝不因为缺配置就不回话。
3. **设备级覆盖板块级**。同一 node_key 同时存在设备专属和板块模板时，设备优先。
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# 边条件类型。intent 目前按 keyword 处理，留作将来接语义判断。
CONDITION_ALWAYS = "always"
CONDITION_KEYWORD = "keyword"
CONDITION_REGEX = "regex"
CONDITION_COLLECTED = "collected"
CONDITION_INTENT = "intent"


def match_edge(edge: dict[str, Any], text_value: str, slots: dict[str, Any]) -> bool:
    """这条边在当前这轮输入下是否命中。

    keyword 走「任一关键词包含」；regex 用 re.search；collected 看槽位非空；
    always 恒真。任何异常（正则写错）一律当不命中——配置错误不该让流程崩。
    """
    kind = str(edge.get("condition_type") or CONDITION_ALWAYS)
    value = str(edge.get("condition_value") or "")
    payload = text_value or ""

    if kind == CONDITION_ALWAYS:
        return True
    if kind in (CONDITION_KEYWORD, CONDITION_INTENT):
        words = [w.strip() for w in value.split(",") if w.strip()]
        return any(word in payload for word in words)
    if kind == CONDITION_REGEX:
        try:
            return bool(re.search(value, payload))
        except re.error:
            return False
    if kind == CONDITION_COLLECTED:
        key = value.strip()
        return bool(str(slots.get(key) or "").strip())
    return False


def pick_next(
    edges: list[dict[str, Any]],
    from_node: str,
    text_value: str,
    slots: dict[str, Any],
) -> str | None:
    """按 priority 升序找第一条命中的边，返回目标节点；都不命中返回 None。

    调用方拿到 None 时继续走原有引擎逻辑（知识库兜底 / 重问），
    不会因为节点图没配全而卡死。
    """
    candidates = [e for e in edges if str(e.get("from_node") or "") == from_node]
    candidates.sort(key=lambda e: int(e.get("priority") or 100))
    for edge in candidates:
        if match_edge(edge, text_value, slots):
            return str(edge.get("to_node") or "") or None
    return None


def entry_node(nodes: list[dict[str, Any]]) -> str | None:
    """入口节点 key。多个 is_entry=1 时取 sort_order 最小的。"""
    entries = [n for n in nodes if int(n.get("is_entry") or 0) == 1]
    if not entries:
        return None
    entries.sort(key=lambda n: int(n.get("sort_order") or 0))
    return str(entries[0].get("node_key") or "") or None


def node_body(nodes: list[dict[str, Any]], node_key: str) -> str:
    """取某节点配的话术正文；没配返回空串（由调用方回退到 device_scripts）。"""
    for node in nodes:
        if str(node.get("node_key") or "") == node_key:
            return str(node.get("body") or "")
    return ""


async def load_graph(
    session: AsyncSession,
    device_code: str = "",
    vertical_code: str = "",
) -> dict[str, Any]:
    """读某设备在某个板块下的节点图。

    设备级（device_code 非空）覆盖板块级（device_code=''）：同一 node_key
    两处都有时用设备那条。返回 {"nodes": [...], "edges": [...], "entry": key|None}。
    读失败或没配时返回空图，调用方回退到原有逻辑。
    """
    scope_params = {
        "vertical_code": vertical_code or "",
        "device_code": device_code or "",
    }
    try:
        node_rows = (
            await session.execute(
                text(
                    "SELECT node_key, title, body, media, is_entry, sort_order, device_code "
                    "FROM flow_nodes "
                    "WHERE status='enabled' AND vertical_code=:vertical_code "
                    "  AND (device_code='' OR device_code=:device_code) "
                    "ORDER BY (device_code<>'') DESC, sort_order, id"
                ),
                scope_params,
            )
        ).mappings().all()
        edge_rows = (
            await session.execute(
                text(
                    "SELECT from_node, to_node, condition_type, condition_value, priority, device_code "
                    "FROM flow_edges "
                    "WHERE status='enabled' AND vertical_code=:vertical_code "
                    "  AND (device_code='' OR device_code=:device_code) "
                    "ORDER BY (device_code<>'') DESC, priority, id"
                ),
                scope_params,
            )
        ).mappings().all()
    except Exception:  # noqa: BLE001  没跑迁移 / 表不存在：当作没配节点
        return {"nodes": [], "edges": [], "entry": None}

    # 设备级覆盖：同一 node_key 先出现的是设备专属（上面按 device_code<>'' 排序）
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in node_rows:
        key = str(row["node_key"] or "")
        if key in seen:
            continue
        seen.add(key)
        nodes.append(dict(row))

    edges: list[dict[str, Any]] = [dict(row) for row in edge_rows]

    return {"nodes": nodes, "edges": edges, "entry": entry_node(nodes)}


__all__ = [
    "CONDITION_ALWAYS",
    "CONDITION_KEYWORD",
    "CONDITION_REGEX",
    "CONDITION_COLLECTED",
    "CONDITION_INTENT",
    "match_edge",
    "pick_next",
    "entry_node",
    "node_body",
    "load_graph",
]

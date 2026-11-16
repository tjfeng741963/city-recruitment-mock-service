"""把 Node SQLite 里的知识库与节点配置同步到 Python 侧数据库。

背景：4222（Node）与 8090（Python）是**两个库**。Node 用 ``data/app.sqlite``，
8090 用 ``APP_DATABASE_URL``（生产 PostgreSQL）。KB v3 的品类 / 位置 / 招工方 /
场景问答，以及节点化编排的 flow_nodes / flow_edges，全都写在 Node 那侧，
8090 一条都读不到——`kb_faq.lookup()` 永远命中不了，`load_graph()` 永远回空图。

本脚本把 SQLite 作为**唯一事实来源**，单向灌进 Python 库。

三条硬约束（迁移期不破坏线上）：

1. **只增不改**。已存在的行一律跳过，绝不覆盖。运营在后台改过的话术不会被
   Node 侧的旧值冲掉。
2. **默认 dry-run**。不加 ``--apply`` 只打印将要做什么，一行不写。
3. **不删任何东西**。Node 侧没有而 Python 侧多出来的旧数据保持原样。

跑法（在 ``backend/`` 下）::

    uv run python -m scripts.sync_kb_from_node              # 预演
    uv run python -m scripts.sync_kb_from_node --apply      # 真正写入

``--sqlite`` 可指定源文件，默认取仓库根目录的 ``data/app.sqlite``。
"""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal

DEFAULT_SQLITE = Path(__file__).resolve().parents[2] / "data" / "app.sqlite"

# 同步顺序：被引用的先来（vertical → location → employer → alias → kb_faq）
TABLES = ("vertical", "location", "employer", "employer_alias", "kb_faq",
          "flow_nodes", "flow_edges")

# 知识库表：迁过去只是"数据可读"，回复逻辑不变（kb_faq 没命中就回落旧路径）
KB_TABLES = ("vertical", "location", "employer", "employer_alias", "kb_faq")

# 节点表：迁过去就等于**开启节点路由**——load_graph() 一读到节点，
# step() 里 _route_by_graph 立刻生效，会话不再走写死的五阶段。
# 所以默认不迁，必须显式 --include-flow，且要在节点图和话术都验收过之后再开。
FLOW_TABLES = ("flow_nodes", "flow_edges")


def _parse_dt(raw: Any) -> datetime | None:
    """SQLite 的 TEXT 时间 → 带时区 datetime。解析不了就返回 None（用列默认值）。

    兼容 ``2026-11-14 01:38:00`` 和 ``2026-11-14T01:38:00+08:00`` 两种写法。
    """
    value = str(raw or "").strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _read_sqlite(path: Path) -> dict[str, list[dict[str, Any]]]:
    """只读打开源库，把七张表全部读进内存（数据量在千行级，够小）。"""
    if not path.exists():
        raise SystemExit(f"源库不存在：{path}")
    # mode=ro：保证脚本永远不会写坏 4222 正在用的库
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        out: dict[str, list[dict[str, Any]]] = {}
        for name in TABLES:
            try:
                rows = conn.execute(f'SELECT * FROM "{name}"').fetchall()
            except sqlite3.OperationalError:
                rows = []      # 该表还没建（没跑对应迁移），当空处理
            out[name] = [dict(row) for row in rows]
        return out
    finally:
        conn.close()


class Sync:
    """一次同步过程的状态：统计 + 两侧 id 映射。"""

    def __init__(self, apply: bool) -> None:
        self.apply = apply
        self.inserted: dict[str, int] = {name: 0 for name in TABLES}
        self.skipped: dict[str, int] = {name: 0 for name in TABLES}
        self.notes: list[str] = []
        # sqlite id → python id（各表各一份，跨表引用靠它们翻译）
        self.vertical: dict[int, int] = {}
        self.location: dict[int, int] = {}
        self.employer: dict[int, int] = {}

    def note(self, message: str) -> None:
        self.notes.append(message)


async def _scalar(session: AsyncSession, sql: str, params: dict[str, Any]) -> Any:
    return (await session.execute(text(sql), params)).scalar()


async def _sync_vertical(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    for row in rows:
        existing = await _scalar(
            session,
            "SELECT id FROM vertical WHERE tenant_id=:t AND code=:c",
            {"t": row.get("tenant_id", 1), "c": row.get("code")},
        )
        if existing:
            s.vertical[int(row["id"])] = int(existing)
            s.skipped["vertical"] += 1
            continue
        if s.apply:
            pid = await _scalar(
                session,
                "INSERT INTO vertical(tenant_id,code,name,config_json,sort_order,status,"
                "created_at,updated_at) VALUES(:t,:c,:n,:cfg,:so,:st,:ca,:ua) RETURNING id",
                {
                    "t": row.get("tenant_id", 1), "c": row.get("code"),
                    "n": row.get("name", ""), "cfg": row.get("config_json") or "{}",
                    "so": int(row.get("sort_order") or 0),
                    "st": row.get("status") or "enabled",
                    "ca": _parse_dt(row.get("created_at")),
                    "ua": _parse_dt(row.get("updated_at")),
                },
            )
            s.vertical[int(row["id"])] = int(pid)
        else:
            # dry-run 也要登记映射，后续表才能算出父 id（负数标记「尚未真正入库」）
            s.vertical[int(row["id"])] = -int(row["id"])
        s.inserted["vertical"] += 1


async def _sync_location(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    """位置是树，父节点必须先落库才能拿到 id。按深度排序后逐层插。"""
    by_id = {int(row["id"]): row for row in rows}

    def depth(node_id: int, guard: int = 0) -> int:
        row = by_id.get(node_id)
        if not row or guard > 10:
            return 0
        parent = row.get("parent_id")
        return 0 if parent is None else 1 + depth(int(parent), guard + 1)

    for row in sorted(rows, key=lambda r: depth(int(r["id"]))):
        parent_sql = row.get("parent_id")
        parent_id = s.location.get(int(parent_sql)) if parent_sql is not None else None
        # 按「层级 + 名称 + 父」认人：同名不同区的位置（如两个「石楼」）不会串
        existing = await _scalar(
            session,
            "SELECT id FROM location WHERE level=:l AND name=:n "
            "AND parent_id IS NOT DISTINCT FROM :p",
            {"l": row.get("level"), "n": row.get("name"), "p": parent_id},
        )
        if existing:
            s.location[int(row["id"])] = int(existing)
            s.skipped["location"] += 1
            continue
        if s.apply:
            pid = await _scalar(
                session,
                "INSERT INTO location(parent_id,level,name,code,lat,lng,address,walk_guide,"
                "image_key,status,data_json,created_at,updated_at) "
                "VALUES(:p,:l,:n,:c,:lat,:lng,:addr,:walk,:img,:st,:dj,:ca,:ua) RETURNING id",
                {
                    "p": parent_id, "l": row.get("level"), "n": row.get("name"),
                    "c": row.get("code") or "", "lat": row.get("lat"), "lng": row.get("lng"),
                    "addr": row.get("address") or "", "walk": row.get("walk_guide") or "",
                    "img": row.get("image_key") or "", "st": row.get("status") or "enabled",
                    "dj": row.get("data_json") or "{}",
                    "ca": _parse_dt(row.get("created_at")),
                    "ua": _parse_dt(row.get("updated_at")),
                },
            )
            s.location[int(row["id"])] = int(pid)
        else:
            s.location[int(row["id"])] = -int(row["id"])
        s.inserted["location"] += 1


async def _sync_employer(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    for row in rows:
        existing = await _scalar(
            session,
            "SELECT id FROM employer WHERE tenant_id=:t AND employer_code=:c",
            {"t": row.get("tenant_id", 1), "c": row.get("employer_code")},
        )
        if existing:
            s.employer[int(row["id"])] = int(existing)
            s.skipped["employer"] += 1
            continue
        vertical_id = s.vertical.get(int(row.get("vertical_id") or 0))
        location_id = s.location.get(int(row.get("location_id") or 0))
        if s.apply:
            pid = await _scalar(
                session,
                "INSERT INTO employer(tenant_id,vertical_id,employer_code,display_name,"
                "short_name,location_id,status,data_json,created_at,updated_at) "
                "VALUES(:t,:v,:c,:d,:sn,:loc,:st,:dj,:ca,:ua) RETURNING id",
                {
                    "t": row.get("tenant_id", 1), "v": vertical_id,
                    "c": row.get("employer_code"), "d": row.get("display_name") or "",
                    "sn": row.get("short_name") or "", "loc": location_id,
                    "st": row.get("status") or "enabled", "dj": row.get("data_json") or "{}",
                    "ca": _parse_dt(row.get("created_at")),
                    "ua": _parse_dt(row.get("updated_at")),
                },
            )
            s.employer[int(row["id"])] = int(pid)
        else:
            s.employer[int(row["id"])] = -int(row["id"])
        s.inserted["employer"] += 1


async def _sync_alias(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    for row in rows:
        employer_id = s.employer.get(int(row.get("employer_id") or 0))
        if employer_id is None:
            # 父招工方没同步到：别名必然悬空，跳过并记一条，免得静默丢数据
            s.skipped["employer_alias"] += 1
            s.note(f"employer_alias 跳过「{row.get('alias')}」：其招工方未同步")
            continue
        if employer_id < 0 and not s.apply:
            # dry-run：父行还没真正入库，id 是负占位，无法查重，直接算新增
            s.inserted["employer_alias"] += 1
            continue
        existing = await _scalar(
            session,
            "SELECT id FROM employer_alias WHERE employer_id=:e AND alias=:a",
            {"e": employer_id, "a": row.get("alias")},
        )
        if existing:
            s.skipped["employer_alias"] += 1
            continue
        if s.apply:
            await session.execute(
                text(
                    "INSERT INTO employer_alias(employer_id,alias,weight) "
                    "VALUES(:e,:a,:w)"
                ),
                {"e": employer_id, "a": row.get("alias"), "w": int(row.get("weight") or 0)},
            )
        s.inserted["employer_alias"] += 1


async def _sync_kb_faq(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    """场景问答。position 作用域的 66 条要跳过——Python 侧没有 service_positions 表，
    岗位 id 无从映射；而且设备 /config 也不下发 position_id，这批本来就命中不了。
    """
    for row in rows:
        scope = str(row.get("scope_level") or "global")
        if row.get("scope_position_id") is not None:
            s.skipped["kb_faq"] += 1
            continue
        vertical_id = (
            s.vertical.get(int(row["vertical_id"])) if row.get("vertical_id") else None
        )
        employer_id = (
            s.employer.get(int(row["scope_employer_id"]))
            if row.get("scope_employer_id") else None
        )
        location_id = (
            s.location.get(int(row["scope_location_id"]))
            if row.get("scope_location_id") else None
        )
        if s.apply:
            existing = await _scalar(
                session,
                "SELECT id FROM kb_faq WHERE tenant_id=:t AND question=:q "
                "AND scope_level=:sl AND vertical_id IS NOT DISTINCT FROM :v "
                "AND scope_employer_id IS NOT DISTINCT FROM :e "
                "AND scope_location_id IS NOT DISTINCT FROM :l",
                {
                    "t": row.get("tenant_id", 1), "q": row.get("question"),
                    "sl": scope, "v": vertical_id, "e": employer_id, "l": location_id,
                },
            )
            if existing:
                s.skipped["kb_faq"] += 1
                continue
            await session.execute(
                text(
                    "INSERT INTO kb_faq(tenant_id,vertical_id,scope_level,scope_location_id,"
                    "scope_employer_id,question,keywords,answer,media,priority,status,"
                    "template_item_id,created_at,updated_at) "
                    "VALUES(:t,:v,:sl,:loc,:e,:q,:kw,:a,:m,:p,:st,:ti,:ca,:ua)"
                ),
                {
                    "t": row.get("tenant_id", 1), "v": vertical_id, "sl": scope,
                    "loc": location_id, "e": employer_id, "q": row.get("question"),
                    "kw": row.get("keywords") or "[]", "a": row.get("answer") or "",
                    "m": row.get("media") or "[]", "p": int(row.get("priority") or 0),
                    "st": row.get("status") or "enabled",
                    "ti": row.get("template_item_id"),
                    "ca": _parse_dt(row.get("created_at")),
                    "ua": _parse_dt(row.get("updated_at")),
                },
            )
        s.inserted["kb_faq"] += 1


async def _sync_flow_nodes(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    for row in rows:
        if s.apply:
            existing = await _scalar(
                session,
                "SELECT id FROM flow_nodes WHERE tenant_id=:t AND device_code=:d "
                "AND vertical_code=:v AND node_key=:k",
                {
                    "t": row.get("tenant_id", 1), "d": row.get("device_code") or "",
                    "v": row.get("vertical_code") or "", "k": row.get("node_key"),
                },
            )
            if existing:
                s.skipped["flow_nodes"] += 1
                continue
            await session.execute(
                text(
                    "INSERT INTO flow_nodes(tenant_id,device_code,vertical_code,node_key,"
                    "title,body,media,is_entry,status,sort_order,data_json,created_at,updated_at) "
                    "VALUES(:t,:d,:v,:k,:ti,:b,:m,:ie,:st,:so,:dj,:ca,:ua)"
                ),
                {
                    "t": row.get("tenant_id", 1), "d": row.get("device_code") or "",
                    "v": row.get("vertical_code") or "", "k": row.get("node_key"),
                    "ti": row.get("title") or "", "b": row.get("body") or "",
                    "m": row.get("media") or "", "ie": int(row.get("is_entry") or 0),
                    "st": row.get("status") or "enabled",
                    "so": int(row.get("sort_order") or 0),
                    "dj": row.get("data_json") or "{}",
                    "ca": _parse_dt(row.get("created_at")),
                    "ua": _parse_dt(row.get("updated_at")),
                },
            )
        s.inserted["flow_nodes"] += 1


async def _sync_flow_edges(session: AsyncSession, rows: list[dict], s: Sync) -> None:
    for row in rows:
        if s.apply:
            existing = await _scalar(
                session,
                "SELECT id FROM flow_edges WHERE tenant_id=:t AND device_code=:d "
                "AND vertical_code=:v AND from_node=:f AND to_node=:to",
                {
                    "t": row.get("tenant_id", 1), "d": row.get("device_code") or "",
                    "v": row.get("vertical_code") or "", "f": row.get("from_node"),
                    "to": row.get("to_node"),
                },
            )
            if existing:
                s.skipped["flow_edges"] += 1
                continue
            await session.execute(
                text(
                    "INSERT INTO flow_edges(tenant_id,device_code,vertical_code,from_node,"
                    "to_node,condition_type,condition_value,priority,status,created_at,updated_at) "
                    "VALUES(:t,:d,:v,:f,:to,:ct,:cv,:p,:st,:ca,:ua)"
                ),
                {
                    "t": row.get("tenant_id", 1), "d": row.get("device_code") or "",
                    "v": row.get("vertical_code") or "", "f": row.get("from_node"),
                    "to": row.get("to_node"),
                    "ct": row.get("condition_type") or "always",
                    "cv": row.get("condition_value") or "",
                    "p": int(row.get("priority") or 100),
                    "st": row.get("status") or "enabled",
                    "ca": _parse_dt(row.get("created_at")),
                    "ua": _parse_dt(row.get("updated_at")),
                },
            )
        s.inserted["flow_edges"] += 1


async def run(sqlite_path: Path, apply: bool, include_flow: bool = False) -> int:
    data = _read_sqlite(sqlite_path)
    s = Sync(apply)
    tables = TABLES if include_flow else KB_TABLES

    # 先确保目标库的表都在：新库（刚部署 / 空 PG）没跑过 init_db 时，
    # 直接查 vertical 会 "no such table"。init_db 只建缺失的表，不动已有表。
    from app.db import init_db

    await init_db()

    async with SessionLocal() as session:
        await _sync_vertical(session, data["vertical"], s)
        await _sync_location(session, data["location"], s)
        await _sync_employer(session, data["employer"], s)
        await _sync_alias(session, data["employer_alias"], s)
        await _sync_kb_faq(session, data["kb_faq"], s)
        if include_flow:
            await _sync_flow_nodes(session, data["flow_nodes"], s)
            await _sync_flow_edges(session, data["flow_edges"], s)
        if apply:
            await session.commit()
        else:
            await session.rollback()

    mode = "已写入" if apply else "预演（未写库）"
    print(f"[sync-kb] {mode}  源={sqlite_path}")
    print(f"{'表':<16}{'新增':>6}{'已存在/跳过':>14}")
    for name in tables:
        print(f"{name:<16}{s.inserted[name]:>6}{s.skipped[name]:>14}")
    if not include_flow:
        print("\n节点表未同步（默认不迁）。要迁用 --include-flow——"
              "迁了即刻开启节点路由，务必先验收。")
    print(f"\n合计新增 {sum(s.inserted[n] for n in tables)} 行，"
          f"跳过 {sum(s.skipped[n] for n in tables)} 行")
    if s.skipped["kb_faq"]:
        print("  · kb_faq 跳过含 position 作用域（Python 侧无 service_positions 表）")
    for note in s.notes:
        print(f"  · {note}")
    if not apply:
        print("\n确认无误后加 --apply 真正写入。")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Node SQLite → Python 库 知识库同步")
    parser.add_argument("--sqlite", type=Path, default=DEFAULT_SQLITE, help="源 SQLite 路径")
    parser.add_argument("--apply", action="store_true", help="真正写入（默认只预演）")
    parser.add_argument(
        "--include-flow",
        action="store_true",
        help="同时同步 flow_nodes / flow_edges（等于开启节点路由，谨慎）",
    )
    args = parser.parse_args(argv)
    return asyncio.run(run(args.sqlite, args.apply, args.include_flow))


if __name__ == "__main__":
    sys.exit(main())

"""把 kb_export 产出的种子 JSON 导入空库（Windows 单机版首次启动用）。

用法：
    python -m app.services.kb_seed_import kb_seed.json [--tenant-id 1] [--dry-run]

三条规则：

1. **幂等**。以 `(tenant_id, title, city, district)` 为去重键，已存在就跳过，
   不更新。单机版装上以后客户会自己改条目，第二次导入拿种子覆盖回去，
   等于把客户的修改擦掉——所以只增不改。
2. **分类按 label 对齐**。导出的 `category` 是 label 不是 id，导入时按 label
   查，查不到才建（`KbCategory`）。两台机器的自增 id 本来就不可能一样。
3. **`search_text` 用同一条公式重新生成**。见 `build_search_text`，它与
   `kb_import.py` 建条目时的写法逐字一致；种子文件里不存这个字段，
   因为它是派生值，存下来只会在一边改规则后变成两份对不上的数据。
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, init_db
from ..models_kb import DEFAULT_TENANT_ID, KbAsset, KbCategory, KbEntry, KbFragment

SEED_VERSION = 1


def build_search_text(title: str, body: str, city: str | None) -> str:
    """全文检索用的拼接文本：标题 + 正文 + 城市。

    公式与 `kb_import.py` 建条目时的那一行完全一致
    （`" ".join([title, body, fields.city or ""]).strip()`）。
    这不是"抄一份更省事"——检索层用 `LIKE` 打这份文本，两边公式一有出入，
    同一句话在老库能召回、在新库就召回不到，而且很难查。
    `tests/test_kb_seed.py::TestSearchTextParity` 拿 import_ebf 的真实产出做对照，
    kb_import 那边改了公式，这里会立刻红。
    """
    return " ".join([title, body, city or ""]).strip()


def _norm(value: str | None) -> str | None:
    """去空白；空串归一成 None，否则 "" 和 None 会算成两个不同的键。"""
    text = (value or "").strip()
    return text or None


def dedupe_key(
    title: str | None, city: str | None, district: str | None
) -> tuple[str, str | None, str | None]:
    """去重键：(title, city, district)，tenant_id 在查询时已限定。

    city/district 在库里可空，SQLite 的 NULL 不等于 NULL，不能用唯一索引兜底，
    只能在 Python 侧比。所以导入时先把现有键一次性读出来集合。
    """
    return (_norm(title) or "", _norm(city), _norm(district))


def _parse_dt(value: Any) -> datetime | None:
    """种子里的 ISO 8601 字符串转回 datetime。原样保留时区，不做换算。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def _to_decimal(value: Any) -> Decimal | None:
    """工价走 Decimal。先 str 再 Decimal，避免 22.1 变成 22.100000000000001。"""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


@dataclass
class SeedImportStats:
    """一次种子导入的结果。只统计"发生了什么"，不记录内容。"""

    entries_total: int = 0
    entries_added: int = 0
    entries_skipped: int = 0
    categories_created: int = 0
    fragments_added: int = 0
    assets_added: int = 0
    dry_run: bool = False
    errors: list[str] | None = None

    def summary(self) -> str:
        suffix = "（dry-run，未写库）" if self.dry_run else ""
        return (
            f"种子 {self.entries_total} 条：新增 {self.entries_added} / "
            f"跳过 {self.entries_skipped}；分类新建 {self.categories_created} 个；"
            f"片段 {self.fragments_added} 个{suffix}"
        )


async def _existing_keys(session: AsyncSession, tenant_id: int) -> set[tuple]:
    """现有条目的去重键。一次查完，别在循环里逐条 SELECT。"""
    rows = await session.execute(
        select(KbEntry.title, KbEntry.city, KbEntry.district).where(
            KbEntry.tenant_id == tenant_id
        )
    )
    return {dedupe_key(title, city, district) for title, city, district in rows}


async def _category_index(session: AsyncSession, tenant_id: int) -> dict[str, int]:
    """label -> id。同租户下按 label 对齐分类。"""
    rows = await session.execute(
        select(KbCategory.id, KbCategory.label).where(KbCategory.tenant_id == tenant_id)
    )
    return {(label or "").strip(): cat_id for cat_id, label in rows if (label or "").strip()}


async def import_seed(
    session: AsyncSession,
    seed: dict[str, Any],
    *,
    tenant_id: int = DEFAULT_TENANT_ID,
    dry_run: bool = False,
) -> SeedImportStats:
    """执行导入。`dry_run=True` 时只走统计，一行都不写库。"""
    stats = SeedImportStats(dry_run=dry_run, errors=[])

    version = seed.get("version")
    if version is not None and int(version) > SEED_VERSION:
        raise ValueError(f"种子版本 {version} 高于本程序支持的 {SEED_VERSION}，请先升级")

    entries = seed.get("entries") or []
    stats.entries_total = len(entries)

    seen = await _existing_keys(session, tenant_id)
    categories = await _category_index(session, tenant_id)
    # 同一个 storage_key 在多条目里复用时只建一条 KbAsset
    assets: dict[str, int] = {}

    for item in entries:
        title = (item.get("title") or "").strip()
        if not title:
            stats.errors.append("有条目缺 title，已跳过")
            stats.entries_skipped += 1
            continue

        key = dedupe_key(title, item.get("city"), item.get("district"))
        if key in seen:
            stats.entries_skipped += 1
            continue

        # ── 分类：按 label 查，没有就建 ──
        category_id: int | None = None
        category_label = (item.get("category") or "").strip()
        if category_label:
            category_id = categories.get(category_label)
            if category_id is None:
                stats.categories_created += 1
                if dry_run:
                    # 占位 id：本批后面同 label 的条目不用重复计数
                    category_id = -1
                    categories[category_label] = category_id
                else:
                    category = KbCategory(
                        tenant_id=tenant_id, label=category_label, position=0
                    )
                    session.add(category)
                    await session.flush()  # 拿自增 id
                    category_id = category.id
                    categories[category_label] = category_id

        kind = item.get("kind") if item.get("kind") in ("job", "script") else "script"
        body = item.get("body") or ""
        city = _norm(item.get("city"))
        fragments = [
            text
            for text in (item.get("fragments") or [])
            if isinstance(text, str) and text.strip()
        ]
        asset_payloads = [
            asset
            for asset in (item.get("assets") or [])
            if isinstance(asset, dict) and asset.get("storage_key")
        ]

        if dry_run:
            stats.entries_added += 1
            stats.fragments_added += len(fragments)
            stats.assets_added += len(asset_payloads)
            seen.add(key)
            continue

        entry = KbEntry(
            tenant_id=tenant_id,
            category_id=category_id,
            kind=kind,
            title=title[:500],
            city=city,
            district=_norm(item.get("district")),
            factory_name=item.get("factory_name"),
            age_min=item.get("age_min"),
            age_max=item.get("age_max"),
            wage_min=_to_decimal(item.get("wage_min")),
            wage_max=_to_decimal(item.get("wage_max")),
            wage_unit=item.get("wage_unit"),
            has_meal=item.get("has_meal"),
            has_dorm=item.get("has_dorm"),
            interview_at=_parse_dt(item.get("interview_at")),
            valid_until=_parse_dt(item.get("valid_until")),
            body=body,
            # 派生字段，按 kb_import 的同一套规则重建
            search_text=build_search_text(title[:500], body, city),
            status="enabled",
        )
        session.add(entry)
        await session.flush()  # 拿 entry.id 给片段用

        position = 0
        for text in fragments:
            session.add(
                KbFragment(
                    entry_id=entry.id, position=position, kind="text", content=text
                )
            )
            position += 1
            stats.fragments_added += 1

        for asset_payload in asset_payloads:
            storage_key = str(asset_payload["storage_key"])
            asset_id = assets.get(storage_key)
            if asset_id is None:
                asset = KbAsset(
                    tenant_id=tenant_id,
                    storage_key=storage_key,
                    mime=asset_payload.get("mime"),
                    bytes=asset_payload.get("size"),
                )
                session.add(asset)
                await session.flush()
                asset_id = asset.id
                assets[storage_key] = asset_id
                stats.assets_added += 1
            session.add(
                KbFragment(
                    entry_id=entry.id,
                    position=position,
                    kind="image",
                    content=None,  # 图片不进正文，靠 asset_id 指回存储
                    asset_id=asset_id,
                )
            )
            position += 1
            stats.fragments_added += 1

        seen.add(key)
        stats.entries_added += 1

    if not dry_run:
        await session.commit()
    return stats


def load_seed(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


async def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导入知识库种子数据（JSON）")
    parser.add_argument("seed", help="kb_seed.json 路径")
    parser.add_argument("--tenant-id", type=int, default=DEFAULT_TENANT_ID)
    parser.add_argument(
        "--dry-run", action="store_true", help="只统计新增/跳过，不写库"
    )
    args = parser.parse_args(argv)

    seed = load_seed(args.seed)
    await init_db()
    async with SessionLocal() as session:
        stats = await import_seed(
            session, seed, tenant_id=args.tenant_id, dry_run=args.dry_run
        )

    print(stats.summary())
    for error in (stats.errors or [])[:20]:
        print(f"  ! {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))

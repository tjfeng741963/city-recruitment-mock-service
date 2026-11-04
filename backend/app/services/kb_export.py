"""把知识库导出成种子 JSON，供 Windows 单机版首次启动自建知识库。

用法：
    python -m app.services.kb_export --out kb_seed.json [--with-assets]

为什么导出 JSON 而不是直接拷 .db 文件：
单机版的库是 SQLite，但客户机器上还有账号、配置、会话这些表，整库拷贝会把
开发环境的垃圾一起带过去。JSON 只带"知识"，目标库自建表结构、自增 id、时间戳。

四条取舍：

1. **只导 `status='enabled'`**。这是检索能命中的集合，disabled/expired 带过去
   也只是在新库里继续不可见，白占体积。
2. **不导 `id` / `tenant_id` / `search_text` / 时间戳**。id 是库内自增，
   跨库复制只会让 `category_id`、`fragment.entry_id` 全部错位；
   `search_text` 必须由目标库用 `kb_import` 那套规则重新生成（见 kb_seed_import），
   否则老库和新库的全文召回会不一样。
3. **分类导 `label` 不导 `category_id`**。两台机器上的 id 必然不同，
   label 才是人写的、可对齐的东西。
4. **图片默认不导**。`--with-assets` 只带 `storage_key`/`mime`/`size`，
   二进制仍在对象存储里，种子文件保持可读、可 diff。
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import SessionLocal, init_db
from ..models_kb import DEFAULT_TENANT_ID, KbAsset, KbCategory, KbEntry

# 种子格式版本。字段一旦不兼容就 +1，导入端据此拒绝或迁移。
SEED_VERSION = 1


def _to_iso(value: datetime | None) -> str | None:
    """日期一律 ISO 8601。带不带时区由库里存的原值决定，不做时区换算。

    这里刻意不 `astimezone()`：`interview_at` 存的是"几点面试"这个墙上时间，
    换成 UTC 再换回来，东八区的"明天中午一点"会变成"五点"，错得没有痕迹。
    """
    return value.isoformat() if value is not None else None


def _to_float(value: Decimal | None) -> float | None:
    """Decimal 进 JSON 只能当数字，统一转 float。"""
    return float(value) if value is not None else None


def _entry_payload(entry: KbEntry, category_label: str | None) -> dict[str, Any]:
    """单条条目的导出形态。字段顺序即 JSON 里的顺序，方便人眼比对。"""
    return {
        "kind": entry.kind,
        "title": entry.title,
        "category": category_label,
        "city": entry.city,
        "district": entry.district,
        "factory_name": entry.factory_name,
        "age_min": entry.age_min,
        "age_max": entry.age_max,
        "wage_min": _to_float(entry.wage_min),
        "wage_max": _to_float(entry.wage_max),
        "wage_unit": entry.wage_unit,
        "has_meal": entry.has_meal,
        "has_dorm": entry.has_dorm,
        "interview_at": _to_iso(entry.interview_at),
        "valid_until": _to_iso(entry.valid_until),
        "body": entry.body or "",
        # 片段只导文本：图片片段靠 assets 数组还原，base64 不进种子
        "fragments": [
            fragment.content
            for fragment in entry.fragments
            if fragment.kind == "text" and fragment.content
        ],
    }


async def _load_category_labels(
    session: AsyncSession, tenant_id: int
) -> dict[int, str]:
    """category_id -> label。一次查完，避免每条条目单独打一次库。"""
    rows = await session.execute(
        select(KbCategory.id, KbCategory.label).where(KbCategory.tenant_id == tenant_id)
    )
    return {row_id: row_label for row_id, row_label in rows}


async def _load_asset_payloads(
    session: AsyncSession, entry: KbEntry
) -> list[dict[str, Any]]:
    """某条条目的图片素材（保持片段顺序）。只有 --with-assets 时才查。"""
    asset_ids = [f.asset_id for f in entry.fragments if f.kind == "image" and f.asset_id]
    if not asset_ids:
        return []
    rows = (
        await session.execute(select(KbAsset).where(KbAsset.id.in_(asset_ids)))
    ).scalars().all()
    by_id = {asset.id: asset for asset in rows}
    payloads: list[dict[str, Any]] = []
    for asset_id in asset_ids:
        asset = by_id.get(asset_id)
        if asset is None:
            continue
        payloads.append(
            {"storage_key": asset.storage_key, "mime": asset.mime, "size": asset.bytes}
        )
    return payloads


async def export_seed(
    session: AsyncSession,
    *,
    tenant_id: int = DEFAULT_TENANT_ID,
    with_assets: bool = False,
) -> dict[str, Any]:
    """导出启用中的条目。按 id 升序，保证同一库多次导出结果稳定（可 diff）。"""
    stmt = (
        select(KbEntry)
        .where(KbEntry.tenant_id == tenant_id, KbEntry.status == "enabled")
        .order_by(KbEntry.id)
        .options(selectinload(KbEntry.fragments))
    )
    entries = (await session.execute(stmt)).scalars().all()

    category_labels = await _load_category_labels(session, tenant_id)

    payloads: list[dict[str, Any]] = []
    for entry in entries:
        payload = _entry_payload(entry, category_labels.get(entry.category_id))
        if with_assets:
            payload["assets"] = await _load_asset_payloads(session, entry)
        payloads.append(payload)

    return {
        "version": SEED_VERSION,
        "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "count": len(payloads),
        "entries": payloads,
    }


def summarize(seed: dict[str, Any]) -> str:
    """导出后打印的统计。发布前靠它确认"没导出来一堆空壳"。"""
    entries = seed["entries"]
    jobs = sum(1 for e in entries if e["kind"] == "job")
    scripts = sum(1 for e in entries if e["kind"] == "script")
    with_city = sum(1 for e in entries if e["city"])
    with_category = sum(1 for e in entries if e["category"])
    return (
        f"导出 {seed['count']} 条（job {jobs} / script {scripts}）；"
        f"有 city 的 {with_city} 条，有分类的 {with_category} 条"
    )


async def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导出知识库种子数据（JSON）")
    parser.add_argument("--out", required=True, help="输出 JSON 路径")
    parser.add_argument(
        "--with-assets",
        action="store_true",
        help="附带图片素材索引（storage_key/mime/size）；默认不带，只导文本",
    )
    args = parser.parse_args(argv)

    await init_db()
    async with SessionLocal() as session:
        seed = await export_seed(session, with_assets=args.with_assets)

    text = json.dumps(seed, ensure_ascii=False, indent=2)
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"已写入 {args.out}")
    print(summarize(seed))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))

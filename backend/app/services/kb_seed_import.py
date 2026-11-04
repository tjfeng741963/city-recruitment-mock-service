"""把 kb_export 产出的种子 JSON 导入空库（Windows 单机版首次启动用）。

用法：
    python -m app.services.kb_seed_import kb_seed.json [--tenant-id 1] [--dry-run]

四条规则：

1. **幂等**。以 `(tenant_id, title, city, district)` 为去重键，**库里已有**就跳过，
   不更新。单机版装上以后客户会自己改条目，第二次导入拿种子覆盖回去，
   等于把客户的修改擦掉——所以只增不改。
   去重只跟**库**比，不跟本批已插入的条目比：源数据里同名条目本来就多
   （「招聘信息」25 条、「筛选要求」9 条，是同一份 word 的不同版本/不同分组），
   拿 `(title, city, district)` 在本批内互相去重会静默丢掉 130 条真实内容。
   第二次导入照样全部跳过——它们的键这时已经都在库里了，幂等不受影响。
2. **分类按 label 对齐**。导出的 `category` 是 label 不是 id，导入时按 label
   查，查不到才建（`KbCategory`）。两台机器的自增 id 本来就不可能一样。
3. **`search_text` 用同一条公式重新生成**。见 `build_search_text`，它与
   `kb_import.py` 建条目时的写法逐字一致；种子文件里不存这个字段，
   因为它是派生值，存下来只会在一边改规则后变成两份对不上的数据。
4. **岗位城市缺失时按文案补全**。见 `infer_city`。导出的 218 条岗位里只有
   52 条带 city（生产库很长时间没做抽取），而这些条目正文/标题里大多写着
   「番禺」「市桥」「钟村」。不补的话，客户问「广州有什么厂」时检索层的
   `city == '广州'` 会把这些岗位整片排除——库里有货，但客户永远看不到。
   话术（`kind='script'`）不参与补全：它们没有城市语义，补了只会在按城市
   筛选时把闲聊话术塞进岗位结果里。
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
from .kb_extract import _extract_city

SEED_VERSION = 1

# 区县/镇级地名 -> 上级市。`kb_extract._CITY_HINTS` 只认市名，但源数据里
# 大量条目标题/正文只写「市桥」「钟村」「化龙」「番禺」——只认市名会白丢
# 一整片广州岗位（实测 159 条 city 为空的岗位里，靠市名只能补回 7 条）。
#
# 只收「能唯一确定上级市」的地名。下面这些看着像、但碰撞太多的**不收**：
#   「长安」——"路线队长安排"里就有这两个字（实测 10 处全是假命中）
#   「光明」——"光明正大"；「南山」「大石」「新造」同理（"新造型"）
# 补错城市比不补更糟：客户会被推荐到另一个城市去面试。
_DISTRICT_CITY_HINTS: tuple[tuple[str, str], ...] = (
    # 广州
    ("番禺", "广州"), ("市桥", "广州"), ("钟村", "广州"), ("南村", "广州"),
    ("员岗", "广州"), ("化龙", "广州"), ("越秀", "广州"), ("花都", "广州"),
    ("白云", "广州"), ("天河", "广州"), ("海珠", "广州"), ("荔湾", "广州"),
    ("黄埔", "广州"), ("增城", "广州"), ("从化", "广州"),
    # 深圳
    ("龙岗", "深圳"), ("宝安", "深圳"), ("龙华", "深圳"), ("观澜", "深圳"),
    ("沙井", "深圳"), ("松岗", "深圳"), ("坪山", "深圳"),
    # 东莞
    ("虎门", "东莞"), ("厚街", "东莞"), ("塘厦", "东莞"), ("大朗", "东莞"),
    ("松山湖", "东莞"),
    # 佛山
    ("顺德", "佛山"), ("南海", "佛山"), ("三水", "佛山"), ("高明", "佛山"),
)


def _district_city(text: str) -> str | None:
    """文本里最靠前的区县名对应的市。找不到返回 None。

    取最靠前的一个，和 `kb_extract._cities_with_position` 的口径一致：
    「番禺的厂，也能去深圳」这句的主城市是番禺。
    """
    best: tuple[int, str] | None = None
    for district, city in _DISTRICT_CITY_HINTS:
        start = text.find(district)
        if start >= 0 and (best is None or start < best[0]):
            best = (start, city)
    return best[1] if best else None


def infer_city(title: str | None, body: str | None) -> str | None:
    """从标题 + 正文推断岗位所在城市。推断不出来返回 None。

    顺序是硬规则，不要调换：

        标题里的市名 → 标题里的区县名 → 正文里的市名 → 正文里的区县名

    标题优先的理由和 `kb_extract._extract_city` 一样：正文经常顺带提到别的
    城市（"广州的厂，也能去深圳"），标题写的才是这条岗位的真实地点。
    同一段文本里市名优先于区县名——市名是明确写法，区县名是间接线索。

    **推断不出来就返回 None，不设默认值**。默认广州会让深圳、东莞的岗位
    被客户按城市筛出来，属于把人骗过去白跑一趟。
    """
    title_text = title or ""
    body_text = body or ""
    return (
        _extract_city("", title_text)
        or _district_city(title_text)
        or _extract_city(body_text)
        or _district_city(body_text)
    )


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
    cities_inferred: int = 0
    categories_created: int = 0
    fragments_added: int = 0
    assets_added: int = 0
    dry_run: bool = False
    errors: list[str] | None = None

    def summary(self) -> str:
        suffix = "（dry-run，未写库）" if self.dry_run else ""
        return (
            f"种子 {self.entries_total} 条：新增 {self.entries_added} / "
            f"跳过 {self.entries_skipped}；城市补全 {self.cities_inferred} 条；"
            f"分类新建 {self.categories_created} 个；"
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

    # 只装库里已有的键。本批插入的条目不写回来——同名不同内容的多条要全进。
    db_keys = await _existing_keys(session, tenant_id)
    categories = await _category_index(session, tenant_id)
    # 同一个 storage_key 在多条目里复用时只建一条 KbAsset
    assets: dict[str, int] = {}

    for item in entries:
        title = (item.get("title") or "").strip()
        if not title:
            stats.errors.append("有条目缺 title，已跳过")
            stats.entries_skipped += 1
            continue

        # 城市必须在算去重键之前补出来：库里存的是补全后的 city，
        # 拿种子里的 null 去比键，第二次导入会把同一批岗位再插一遍。
        kind = item.get("kind") if item.get("kind") in ("job", "script") else "script"
        body = item.get("body") or ""
        city = _norm(item.get("city"))
        city_inferred = False
        if city is None and kind == "job":
            city = infer_city(title, body)
            city_inferred = city is not None

        key = dedupe_key(title, city, item.get("district"))
        if key in db_keys:
            stats.entries_skipped += 1
            continue
        if city_inferred:
            stats.cities_inferred += 1

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

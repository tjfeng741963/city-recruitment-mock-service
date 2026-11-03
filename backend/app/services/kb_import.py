"""把易歪歪备份（.ebf，SQLite 格式）导入知识库。

用法：
    python -m app.services.kb_import /path/to/易歪歪_备份_V1.ebf --report out.json

三条硬规则：

1. **只读打开源文件**。`.ebf` 是客户唯一的一份原始数据，任何写入都可能毁掉它。
   连接串固定 `?mode=ro`。
2. **相对日期在导入时换算**。源数据 245 条含"明天/本周X"，不换算等于把
   一个会过期的承诺存进库里（见 kb_extract 模块注释）。
3. **必须产出数据质量报告**。这份报告是阶段 3 检索调参的依据：
   抽不出工价/年龄的有多少、相对日期解析失败的有多少、疑似重复的有多少。

源表结构（实测 2026-11-03）：
    word_class(id, sign, label, position, username, ParentSign, IsGroup)   31 行
    word_list (id, parentSign, sign, label, jsonValue, texts, images, ...) 549 行
    word_image(id, filename, base64)                                       78 行
    word_label(id, label, position, username, sign)                        0 行

`jsonValue` 是 `[{"type": 1, "value": "文本"}, ...]` 形式的片段数组，
type=1 是文本；图片片段另见 word_image，通过 value 里的文件名关联。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sqlite3
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, init_db
from ..models_kb import DEFAULT_TENANT_ID, KbAsset, KbCategory, KbEntry, KbFragment
from .kb_assets import AssetStore, LocalAssetStore, build_filename_index, extract_images
from .kb_extract import extract_job_fields, has_relative_date


@dataclass
class ImportStats:
    """一次导入的质量指标。全部落进报告，不要只 print。"""

    categories_total: int = 0
    categories_imported: int = 0
    entries_total: int = 0
    entries_imported: int = 0
    fragments_total: int = 0
    text_fragments: int = 0
    image_fragments: int = 0
    images_total: int = 0
    relative_dates: int = 0
    relative_dates_resolved: int = 0
    with_age: int = 0
    with_wage: int = 0
    with_interview: int = 0
    with_meal: int = 0
    with_dorm: int = 0
    missing_age: list[str] = field(default_factory=list)
    missing_wage: list[str] = field(default_factory=list)
    unresolved_dates: list[str] = field(default_factory=list)
    duplicate_titles: list[tuple[str, str]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "categories": {
                "total": self.categories_total,
                "imported": self.categories_imported,
            },
            "entries": {"total": self.entries_total, "imported": self.entries_imported},
            "fragments": {
                "total": self.fragments_total,
                "text": self.text_fragments,
                "image": self.image_fragments,
            },
            "images": {"total": self.images_total},
            "relative_dates": {
                "detected": self.relative_dates,
                "resolved": self.relative_dates_resolved,
                "unresolved_samples": self.unresolved_dates[:20],
            },
            "structured_fields": {
                "with_age": self.with_age,
                "with_wage": self.with_wage,
                "with_interview": self.with_interview,
                "with_meal": self.with_meal,
                "with_dorm": self.with_dorm,
                "missing_age_samples": self.missing_age[:20],
                "missing_wage_samples": self.missing_wage[:20],
            },
            "suspect_duplicates": self.duplicate_titles[:20],
            "errors": self.errors[:20],
        }


@dataclass(frozen=True)
class SourceRow:
    id: int
    label: str
    parent_sign: str
    sign: str
    json_value: str
    type: int


def _open_source(path: str | Path) -> sqlite3.Connection:
    """只读打开。源文件是客户唯一原始数据，绝不写。"""
    uri = "file:" + urllib.parse.quote(str(path)) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def parse_fragments(json_value: str) -> list[tuple[str, str]]:
    """把 jsonValue 解析成 [(kind, content)]，保持原顺序。

    解析失败时退化为单条文本片段，保证原文不丢。
    """
    if not json_value:
        return []
    try:
        items = json.loads(json_value)
    except (json.JSONDecodeError, TypeError):
        return [("text", json_value.strip())] if json_value.strip() else []

    fragments: list[tuple[str, str]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if not isinstance(value, str) or not value.strip():
            continue
        kind = "image" if item.get("type") == 2 else "text"
        fragments.append((kind, value))
    return fragments


def _normalize_title(label: str, body: str) -> str:
    title = (label or "").strip()
    if title:
        return title[:500]
    first_line = (body or "").strip().splitlines()
    return (first_line[0][:500] if first_line else "未命名条目")


def _to_int(value: object) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _read_categories(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        "SELECT id, sign, label, position, ParentSign, IsGroup FROM word_class ORDER BY id"
    ).fetchall()
    return [
        {
            "sign": row["sign"] or "",
            "label": (row["label"] or "").strip(),
            "parent_sign": (row["ParentSign"] or "").strip(),
            "position": _to_int(row["position"]),
            "is_group": bool(row["IsGroup"]),
        }
        for row in rows
    ]


def _read_entries(con: sqlite3.Connection) -> list[SourceRow]:
    rows = con.execute(
        "SELECT id, parentSign, sign, label, jsonValue, type FROM word_list ORDER BY id"
    ).fetchall()
    return [
        SourceRow(
            id=row["id"],
            label=(row["label"] or "").strip(),
            parent_sign=(row["parentSign"] or "").strip(),
            sign=(row["sign"] or "").strip(),
            json_value=row["jsonValue"] or "",
            type=_to_int(row["type"]),
        )
        for row in rows
    ]


def _classify_kind(label: str, body: str) -> str:
    """粗判 job / script。

    有意保守：**只有**明显含岗位事实（年龄、工价、面试时间）的才标 job。
    标错的代价不对称——把话术标成 job，模型就不敢润色；把 job 标成话术，
    模型可能改写工价，那要赔钱。所以拿不准时标 script，让人工复核。
    """
    fields = extract_job_fields(body)
    has_facts = any(
        v is not None
        for v in (
            fields.age_min,
            fields.age_max,
            fields.wage_min,
            fields.interview_at,
        )
    )
    return "job" if has_facts else "script"


def _is_expired(valid_until: datetime | None) -> bool:
    if valid_until is None:
        return False
    now = datetime.now(valid_until.tzinfo)
    return valid_until < now


async def import_ebf(
    session: AsyncSession,
    source: str | Path,
    *,
    base_day: date | None = None,
    truncate: bool = False,
    asset_store: AssetStore | None = None,
) -> ImportStats:
    """执行导入。返回质量统计。

    `asset_store` 为空时跳过图片抽取——测试里不需要 157 MB 的落盘。
    """
    stats = ImportStats()
    con = _open_source(source)
    try:
        categories = _read_categories(con)
        entries = _read_entries(con)
        stats.categories_total = len(categories)
        stats.entries_total = len(entries)
        stats.images_total = con.execute("SELECT COUNT(*) FROM word_image").fetchone()[0]

        if truncate:
            await session.execute(
                delete(KbFragment).where(
                    KbFragment.entry_id.in_(
                        select(KbEntry.id).where(KbEntry.tenant_id == DEFAULT_TENANT_ID)
                    )
                )
            )
            await session.execute(delete(KbEntry).where(KbEntry.tenant_id == DEFAULT_TENANT_ID))
            await session.execute(
                delete(KbCategory).where(KbCategory.tenant_id == DEFAULT_TENANT_ID)
            )
            await session.execute(delete(KbAsset).where(KbAsset.tenant_id == DEFAULT_TENANT_ID))
            await session.commit()

        # ── 图片：解码落盘，并在库里建占位行，拿到 asset_id ──
        image_index: dict[str, object] = {}
        asset_ids: dict[str, int] = {}
        if asset_store is not None:
            images, image_errors = extract_images(source, asset_store)
            stats.errors.extend(image_errors)
            image_index = build_filename_index(images)  # type: ignore[assignment]
            next_asset_id = 1
            for img in images:
                if img.storage_key in asset_ids:
                    continue
                session.add(
                    KbAsset(
                        id=next_asset_id,
                        tenant_id=DEFAULT_TENANT_ID,
                        storage_key=img.storage_key,
                        mime=img.mime,
                        bytes=img.bytes,
                    )
                )
                asset_ids[img.storage_key] = next_asset_id
                next_asset_id += 1
            await session.flush()

        sign_to_category: dict[str, int] = {}

        # SQLite 下 BigInteger 主键不自动递增（只有 INTEGER PRIMARY KEY 才是 rowid 别名），
        # 所以显式分配 id。PostgreSQL 侧有 BIGSERIAL，不受影响。
        next_category_id = 1
        next_entry_id = 1
        next_fragment_id = 1

        # ── 第一遍：只建顶层分类，拿到 id ──
        for cat in categories:
            category = KbCategory(
                id=next_category_id,
                tenant_id=DEFAULT_TENANT_ID,
                parent_id=None,
                label=cat["label"] or cat["sign"],
                position=cat["position"],
            )
            session.add(category)
            await session.flush()
            sign_to_category[cat["sign"]] = category.id
            stats.categories_imported += 1
            next_category_id += 1

        # ── 第二遍：挂父子关系（ParentSign 指向另一条分类的 sign）──
        for cat in categories:
            parent_sign = cat["parent_sign"]
            if not parent_sign:
                continue
            parent_id = sign_to_category.get(parent_sign)
            own_id = sign_to_category.get(cat["sign"])
            if parent_id is None or own_id is None or parent_id == own_id:
                continue
            child = await session.get(KbCategory, own_id)
            if child is not None:
                child.parent_id = parent_id

        await session.flush()

        # ── 条目 ──
        seen_titles: dict[str, str] = {}
        for row in entries:
            fragments = parse_fragments(row.json_value)
            text_parts = [c for kind, c in fragments if kind == "text"]
            body = "\n".join(text_parts).strip()
            if not body and not any(kind == "image" for kind, _ in fragments):
                stats.errors.append(f"条目 {row.id} 无内容，已跳过")
                continue

            title = _normalize_title(row.label, body)
            fields = extract_job_fields(body, title=title, base=base_day)
            kind = _classify_kind(row.label, body)

            if has_relative_date(body):
                stats.relative_dates += 1
                if fields.interview_at is None:
                    stats.unresolved_dates.append(f"{row.id}:{title}")
                else:
                    stats.relative_dates_resolved += 1

            if fields.age_min is not None:
                stats.with_age += 1
            elif kind == "job":
                stats.missing_age.append(f"{row.id}:{title}")
            if fields.wage_min is not None:
                stats.with_wage += 1
            elif kind == "job":
                stats.missing_wage.append(f"{row.id}:{title}")
            if fields.interview_at is not None:
                stats.with_interview += 1
            if fields.has_meal is not None:
                stats.with_meal += 1
            if fields.has_dorm is not None:
                stats.with_dorm += 1

            if title in seen_titles:
                stats.duplicate_titles.append((seen_titles[title], title))
            else:
                seen_titles[title] = str(row.id)

            entry = KbEntry(
                id=next_entry_id,
                tenant_id=DEFAULT_TENANT_ID,
                category_id=sign_to_category.get(row.parent_sign),
                kind=kind,
                title=title,
                city=fields.city,
                age_min=fields.age_min,
                age_max=fields.age_max,
                wage_min=fields.wage_min,
                wage_max=fields.wage_max,
                wage_unit=fields.wage_unit,
                has_meal=fields.has_meal,
                has_dorm=fields.has_dorm,
                interview_at=fields.interview_at,
                valid_until=fields.valid_until,
                body=body,
                search_text=" ".join([title, body, fields.city or ""]).strip(),
                status="expired" if _is_expired(fields.valid_until) else "enabled",
            )
            session.add(entry)
            await session.flush()

            for position, (frag_kind, content) in enumerate(fragments):
                asset_id = None
                if frag_kind == "image" and image_index:
                    asset = image_index.get(content)
                    if asset is not None:
                        asset_id = asset_ids.get(asset.storage_key)
                session.add(
                    KbFragment(
                        id=next_fragment_id,
                        entry_id=entry.id,
                        position=position,
                        kind=frag_kind,
                        # 图片不进正文：base64 不落库，靠 asset_id 指回存储
                        content=content if frag_kind == "text" else None,
                        asset_id=asset_id,
                    )
                )
                next_fragment_id += 1
                stats.fragments_total += 1
                if frag_kind == "image":
                    stats.image_fragments += 1
                else:
                    stats.text_fragments += 1

            next_entry_id += 1
            stats.entries_imported += 1

        await session.commit()
    finally:
        con.close()

    return stats


def _sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


async def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导入易歪歪备份到知识库")
    parser.add_argument("source", help=".ebf 文件路径")
    parser.add_argument("--report", default=None, help="质量报告输出路径（JSON）")
    parser.add_argument("--truncate", action="store_true", help="导入前清空现有知识库")
    parser.add_argument(
        "--base-date", default=None, help="相对日期的基准日（YYYY-MM-DD），默认今天"
    )
    parser.add_argument(
        "--assets-dir",
        default="./data/kb-assets",
        help="图片落盘根目录；传空字符串则跳过图片抽取",
    )
    args = parser.parse_args(argv)

    base_day = date.fromisoformat(args.base_date) if args.base_date else None
    store = LocalAssetStore(Path(args.assets_dir)) if args.assets_dir else None

    await init_db()
    async with SessionLocal() as session:
        stats = await import_ebf(
            session,
            args.source,
            base_day=base_day,
            truncate=args.truncate,
            asset_store=store,
        )

    payload = stats.as_dict()
    payload["source"] = {
        "path": str(args.source),
        "sha256": _sha256(args.source),
        "base_date": (base_day or date.today()).isoformat(),
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
        print(f"报告已写入 {args.report}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))

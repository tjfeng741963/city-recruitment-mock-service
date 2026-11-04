"""种子导出/导入测试：导出结构、跨库往返、幂等、分类对齐、日期保真。

用例之间共享同一个 SQLite 文件（conftest 只在会话开始删一次），
所以每条用例开头都要把 kb_* 清空，`_clean_kb` 夹具负责这件事。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest_asyncio
from sqlalchemy import delete, func, select

from app.db import SessionLocal
from app.models_kb import KbAsset, KbCategory, KbEntry, KbFragment
from app.services.kb_export import export_seed
from app.services.kb_import import import_ebf
from app.services.kb_seed_import import build_search_text, import_seed

TENANT_ID = 1


@pytest_asyncio.fixture(autouse=True)
async def clean_kb(client):  # noqa: ARG001  依赖 client 保证表已建好
    """每条用例前清空知识库，避免用例之间串数据。"""
    async with SessionLocal() as session:
        await session.execute(delete(KbFragment))
        await session.execute(delete(KbEntry))
        await session.execute(delete(KbCategory))
        await session.execute(delete(KbAsset))
        await session.commit()
    yield


async def _add_entry(
    *,
    title: str,
    kind: str = "job",
    city: str | None = None,
    district: str | None = None,
    category_label: str | None = None,
    fragments: list[str] | None = None,
    body: str = "",
    **fields,
) -> int:
    """直接写库造一条条目，返回 id。search_text 走与导入端一致的公式。"""
    async with SessionLocal() as session:
        category_id = None
        if category_label:
            category = KbCategory(tenant_id=TENANT_ID, label=category_label)
            session.add(category)
            await session.flush()
            category_id = category.id

        entry = KbEntry(
            tenant_id=TENANT_ID,
            category_id=category_id,
            kind=kind,
            title=title,
            city=city,
            district=district,
            body=body,
            search_text=build_search_text(title, body, city),
            **fields,
        )
        session.add(entry)
        await session.flush()
        for position, text in enumerate(fragments or []):
            session.add(
                KbFragment(entry_id=entry.id, position=position, kind="text", content=text)
            )
        await session.commit()
        return entry.id


async def _export() -> dict:
    async with SessionLocal() as session:
        return await export_seed(session)


async def _import(seed: dict, *, dry_run: bool = False):
    async with SessionLocal() as session:
        return await import_seed(session, seed, tenant_id=TENANT_ID, dry_run=dry_run)


async def _count_entries() -> int:
    async with SessionLocal() as session:
        return (await session.execute(select(func.count()).select_from(KbEntry))).scalar_one()


async def _wipe_kb() -> None:
    """模拟"换一台机器"：条目、分类、素材全清空，租户保留。"""
    async with SessionLocal() as session:
        await session.execute(delete(KbFragment))
        await session.execute(delete(KbEntry))
        await session.execute(delete(KbCategory))
        await session.execute(delete(KbAsset))
        await session.commit()


class TestExport:
    async def test_empty_db(self) -> None:
        seed = await _export()
        assert seed["count"] == 0
        assert seed["entries"] == []
        assert seed["version"] == 1
        assert seed["exported_at"]

    async def test_fields_complete_and_no_internal_fields(self) -> None:
        await _add_entry(
            title="万美表带厂",
            city="广州",
            district="天河",
            factory_name="万美表带厂",
            age_min=18,
            age_max=45,
            wage_min=22,
            wage_max=25,
            wage_unit="hour",
            has_meal=True,
            has_dorm=False,
            interview_at=datetime(2026, 11, 5, 13, 0),
            valid_until=datetime(2026, 12, 1, 0, 0),
            category_label="广州工厂招聘",
            fragments=["广州万美表带厂 18-45岁", "22-25元/小时 包吃住"],
            body="广州万美表带厂 18-45岁 22-25元/小时",
        )
        await _add_entry(title="超龄话术", kind="script", body="哥，这个厂卡到45的")
        await _add_entry(title="深圳电子厂", city="深圳", body="深圳电子厂 20元/小时")

        seed = await _export()
        assert seed["count"] == 3
        first = seed["entries"][0]

        expected_keys = {
            "kind",
            "title",
            "category",
            "city",
            "district",
            "factory_name",
            "age_min",
            "age_max",
            "wage_min",
            "wage_max",
            "wage_unit",
            "has_meal",
            "has_dorm",
            "interview_at",
            "valid_until",
            "body",
            "fragments",
        }
        assert set(first) == expected_keys
        # 库内字段一个都不能带出去，尤其 search_text 是派生值
        assert "search_text" not in json.dumps(seed, ensure_ascii=False)
        assert "tenant_id" not in first and "id" not in first

        assert first["category"] == "广州工厂招聘"  # label 不是 id
        assert first["fragments"] == ["广州万美表带厂 18-45岁", "22-25元/小时 包吃住"]
        assert first["wage_min"] == 22.0 and isinstance(first["wage_min"], float)
        assert first["interview_at"] == "2026-11-05T13:00:00"

        # 按 id 升序，与插入顺序一致
        assert [e["title"] for e in seed["entries"]] == [
            "万美表带厂",
            "超龄话术",
            "深圳电子厂",
        ]

    async def test_skips_disabled_entries(self) -> None:
        await _add_entry(title="停用条目", body="停用")
        async with SessionLocal() as session:
            entry = (await session.execute(select(KbEntry))).scalar_one()
            entry.status = "disabled"
            await session.commit()

        seed = await _export()
        assert seed["count"] == 0


class TestRoundTrip:
    async def test_export_then_import_into_empty_db(self) -> None:
        await _add_entry(title="条目一", city="广州", fragments=["片段一"], body="正文一")
        await _add_entry(title="条目二", kind="script", body="话术二")
        await _add_entry(title="条目三", city="深圳", body="正文三")

        seed = await _export()
        await _wipe_kb()
        assert await _count_entries() == 0

        stats = await _import(seed)
        assert stats.entries_added == 3
        assert stats.entries_skipped == 0
        assert await _count_entries() == seed["count"]

    async def test_duplicate_import_is_skipped(self) -> None:
        await _add_entry(title="条目一", city="广州", body="正文一", fragments=["片段一"])
        seed = await _export()
        await _wipe_kb()

        first = await _import(seed)
        second = await _import(seed)
        assert first.entries_added == 1
        assert second.entries_added == 0
        assert second.entries_skipped == 1
        assert await _count_entries() == 1

    async def test_duplicate_import_does_not_overwrite(self) -> None:
        """客户改过的内容不能被种子覆盖回去。"""
        await _add_entry(title="条目一", city="广州", body="原始正文")
        seed = await _export()
        await _wipe_kb()
        await _import(seed)

        async with SessionLocal() as session:
            entry = (await session.execute(select(KbEntry))).scalar_one()
            entry.body = "客户改过的正文"
            entry.search_text = build_search_text(entry.title, entry.body, entry.city)
            await session.commit()

        await _import(seed)
        async with SessionLocal() as session:
            entry = (await session.execute(select(KbEntry))).scalar_one()
        assert entry.body == "客户改过的正文"

    async def test_dry_run_writes_nothing(self) -> None:
        await _add_entry(title="条目一", city="广州", body="正文一")
        await _add_entry(title="条目二", body="正文二")
        seed = await _export()
        await _wipe_kb()

        stats = await _import(seed, dry_run=True)
        assert stats.dry_run is True
        assert stats.entries_added == 2
        assert await _count_entries() == 0

    async def test_dry_run_reports_categories_without_creating(self) -> None:
        await _add_entry(title="条目一", category_label="广州工厂招聘", body="正文")
        seed = await _export()
        await _wipe_kb()

        stats = await _import(seed, dry_run=True)
        assert stats.categories_created == 1
        async with SessionLocal() as session:
            assert (await session.execute(select(func.count()).select_from(KbCategory))).scalar_one() == 0


class TestCategoryMapping:
    async def test_creates_category_by_label_in_empty_db(self) -> None:
        await _add_entry(title="条目一", category_label="广州工厂招聘", body="正文")
        await _add_entry(title="条目二", category_label="地铁常用语", kind="script", body="话术")
        seed = await _export()
        await _wipe_kb()

        stats = await _import(seed)
        assert stats.categories_created == 2

        async with SessionLocal() as session:
            labels = {
                label for (label,) in await session.execute(select(KbCategory.label))
            }
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "条目一"))
            ).scalar_one()
            category = await session.get(KbCategory, entry.category_id)
        assert labels == {"广州工厂招聘", "地铁常用语"}
        assert category.label == "广州工厂招聘"

    async def test_reuses_existing_category(self) -> None:
        """目标库已有同名分类时只挂靠，不重复建。"""
        await _add_entry(title="条目一", category_label="广州工厂招聘", body="正文")
        seed = await _export()
        await _wipe_kb()

        async with SessionLocal() as session:
            session.add(KbCategory(tenant_id=TENANT_ID, label="广州工厂招聘"))
            await session.commit()

        stats = await _import(seed)
        assert stats.categories_created == 0
        async with SessionLocal() as session:
            assert (
                await session.execute(select(func.count()).select_from(KbCategory))
            ).scalar_one() == 1


class TestFieldFidelity:
    async def test_datetime_round_trip(self) -> None:
        interview = datetime(2026, 11, 5, 13, 30, 0)
        valid_until = datetime(2026, 12, 1, 0, 0, 0)
        await _add_entry(
            title="条目一",
            city="广州",
            body="正文",
            interview_at=interview,
            valid_until=valid_until,
        )
        seed = await _export()
        await _wipe_kb()
        await _import(seed)

        async with SessionLocal() as session:
            entry = (await session.execute(select(KbEntry))).scalar_one()
        assert entry.interview_at == interview
        assert entry.valid_until == valid_until

    async def test_wage_decimal_round_trip(self) -> None:
        await _add_entry(
            title="条目一", city="广州", body="正文", wage_min=22.5, wage_max=25, wage_unit="hour"
        )
        seed = await _export()
        await _wipe_kb()
        await _import(seed)

        async with SessionLocal() as session:
            entry = (await session.execute(select(KbEntry))).scalar_one()
        assert entry.wage_min == 22.5
        assert entry.wage_max == 25
        assert entry.wage_min is not None and entry.wage_min.as_tuple().exponent == -2

    async def test_fragments_round_trip_in_order(self) -> None:
        await _add_entry(title="条目一", body="正文", fragments=["一", "二", "三"])
        seed = await _export()
        await _wipe_kb()
        await _import(seed)

        async with SessionLocal() as session:
            entry = (await session.execute(select(KbEntry))).scalar_one()
            fragments = (
                await session.execute(
                    select(KbFragment)
                    .where(KbFragment.entry_id == entry.id)
                    .order_by(KbFragment.position)
                )
            ).scalars().all()
        assert [f.content for f in fragments] == ["一", "二", "三"]
        assert all(f.kind == "text" for f in fragments)


class TestSearchTextParity:
    """search_text 必须和 kb_import 建出来的逐字一致，否则检索召回会两边不一样。"""

    async def test_matches_kb_import_output(self, tmp_path: Path) -> None:
        ebf = _make_mini_ebf(tmp_path / "mini.ebf")
        async with SessionLocal() as session:
            await import_ebf(session, ebf, truncate=True)
        async with SessionLocal() as session:
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "表带厂"))
            ).scalar_one()

        assert entry.search_text == build_search_text(entry.title, entry.body, entry.city)

        # 导出→导入后重建的 search_text 也要与老库相同
        seed = await _export()
        await _wipe_kb()
        await _import(seed)
        async with SessionLocal() as session:
            new_entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "表带厂"))
            ).scalar_one()
        assert new_entry.search_text == entry.search_text


def _make_mini_ebf(path: Path) -> Path:
    """造一份最小的易歪歪备份，只用来对照 search_text 的生成结果。"""
    body = "广州万美表带厂 18-45岁 22-25元/小时 包吃住"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE word_class (id INTEGER PRIMARY KEY, sign TEXT, label TEXT,
            position INTEGER, username TEXT, ParentSign TEXT, IsGroup INTEGER);
        CREATE TABLE word_list (id INTEGER PRIMARY KEY, parentSign TEXT, sign TEXT,
            label TEXT, jsonValue TEXT, texts TEXT, images TEXT, position INTEGER,
            username TEXT, keycode TEXT, txtSp TEXT, txtQp TEXT, bgColor TEXT, type INTEGER);
        CREATE TABLE word_image (id INTEGER PRIMARY KEY, filename TEXT, base64 TEXT);
        """
    )
    con.execute("INSERT INTO word_class VALUES (1,'GK-1','广州工厂招聘',0,'','',0)")
    con.execute(
        "INSERT INTO word_list (id,parentSign,sign,label,jsonValue,position,type) "
        "VALUES (1,'GK-1','GK-1-1','表带厂',?,0,0)",
        (json.dumps([{"type": 1, "value": body}], ensure_ascii=False),),
    )
    con.commit()
    con.close()
    return path

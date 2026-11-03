"""导入器测试：用合成的 .ebf（SQLite）验证映射与数据质量统计。

不依赖那份 158 MB 的真实备份——CI 里没有它。
真实数据的质量报告在 过程文件/yiwaiwai-import/quality-report.json。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models_kb import KbCategory, KbEntry, KbFragment
from app.services.kb_import import import_ebf, parse_fragments


def _make_ebf(path: Path) -> Path:
    """按真实备份的表结构造一个 4 条数据的迷你版本。"""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE word_class (id INTEGER PRIMARY KEY, sign TEXT, label TEXT,
            position INTEGER, username TEXT, ParentSign TEXT, IsGroup INTEGER);
        CREATE TABLE word_list (id INTEGER PRIMARY KEY, parentSign TEXT, sign TEXT,
            label TEXT, jsonValue TEXT, texts TEXT, images TEXT, position INTEGER,
            username TEXT, keycode TEXT, txtSp TEXT, txtQp TEXT, bgColor TEXT, type INTEGER);
        CREATE TABLE word_image (id INTEGER PRIMARY KEY, filename TEXT, base64 TEXT);
        CREATE TABLE word_label (id INTEGER PRIMARY KEY, label TEXT, position INTEGER,
            username TEXT, sign TEXT);
        """
    )
    con.execute("INSERT INTO word_class VALUES (1,'GK-1','广州工厂招聘',0,'','',0)")
    con.execute("INSERT INTO word_class VALUES (2,'GK-2','地铁常用语',0,'','',0)")

    job_json = json.dumps(
        [{"type": 1, "value": "广州万美表带厂 18-45岁 22-25元/小时 包吃住 明天中午一点面试"}],
        ensure_ascii=False,
    )
    script_json = json.dumps([{"type": 1, "value": "哥，这个厂卡到45的"}], ensure_ascii=False)
    image_json = json.dumps(
        [{"type": 1, "value": "招工海报"}, {"type": 2, "value": "poster.jpg"}],
        ensure_ascii=False,
    )
    empty_json = json.dumps([], ensure_ascii=False)

    rows = [
        (1, "GK-1", "GK-1-1", "表带厂", job_json),
        (2, "GK-2", "GK-2-1", "超龄话术", script_json),
        (3, "GK-1", "GK-1-2", "海报", image_json),
        (4, "GK-1", "GK-1-3", "空条目", empty_json),
    ]
    con.executemany(
        "INSERT INTO word_list (id,parentSign,sign,label,jsonValue,position,type) "
        "VALUES (?,?,?,?,?,0,0)",
        rows,
    )
    con.commit()
    con.close()
    return path


@pytest.fixture
def ebf(tmp_path: Path) -> Path:
    return _make_ebf(tmp_path / "mini.ebf")


class TestParseFragments:
    def test_text_and_image(self) -> None:
        raw = json.dumps(
            [{"type": 1, "value": "文字"}, {"type": 2, "value": "a.jpg"}],
            ensure_ascii=False,
        )
        assert parse_fragments(raw) == [("text", "文字"), ("image", "a.jpg")]

    def test_malformed_falls_back_to_text(self) -> None:
        assert parse_fragments("不是 JSON") == [("text", "不是 JSON")]

    def test_empty(self) -> None:
        assert parse_fragments("") == []


class TestImport:
    async def test_categories_and_entries(self, client, ebf: Path) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            stats = await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        assert stats.categories_imported == 2
        assert stats.entries_imported == 3  # 空条目被跳过
        assert stats.errors and "条目 4" in stats.errors[0]

    async def test_job_gets_structured_fields(self, client, ebf: Path) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        async with SessionLocal() as session:
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "表带厂"))
            ).scalar_one()
        assert entry.kind == "job"
        assert entry.city == "广州"
        assert entry.age_min == 18
        assert entry.age_max == 45
        assert entry.interview_at is not None
        assert entry.interview_at.day == 4
        assert entry.interview_at.hour == 13

    async def test_script_entry(self, client, ebf: Path) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        async with SessionLocal() as session:
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "超龄话术"))
            ).scalar_one()
        assert entry.kind == "script"
        assert entry.interview_at is None

    async def test_fragments_ordered(self, client, ebf: Path) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        async with SessionLocal() as session:
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "海报"))
            ).scalar_one()
            fragments = (
                await session.execute(
                    select(KbFragment)
                    .where(KbFragment.entry_id == entry.id)
                    .order_by(KbFragment.position)
                )
            ).scalars().all()
        assert [f.kind for f in fragments] == ["text", "image"]
        assert fragments[1].content is None  # 图片不落 base64

    async def test_entry_links_to_category(self, client, ebf: Path) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        async with SessionLocal() as session:
            category = (
                await session.execute(
                    select(KbCategory).where(KbCategory.label == "广州工厂招聘")
                )
            ).scalar_one()
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "表带厂"))
            ).scalar_one()
        assert entry.category_id == category.id

    async def test_source_file_is_untouched(self, client, ebf: Path) -> None:  # noqa: ARG002
        """源文件只读打开：导入前后大小与 mtime 不变。"""
        before = (ebf.stat().st_size, ebf.stat().st_mtime_ns)
        async with SessionLocal() as session:
            await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        after = (ebf.stat().st_size, ebf.stat().st_mtime_ns)
        assert before == after

    async def test_report_shape(self, client, ebf: Path) -> None:  # noqa: ARG002
        async with SessionLocal() as session:
            stats = await import_ebf(session, ebf, base_day=date(2026, 11, 3), truncate=True)
        report = stats.as_dict()
        assert report["entries"]["imported"] == 3
        assert report["relative_dates"]["resolved"] >= 1
        assert "structured_fields" in report

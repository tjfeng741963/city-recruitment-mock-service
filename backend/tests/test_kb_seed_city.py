"""种子导入的城市补全：标题优先、正文兜底、推不出来留空、话术不补。

背景：生产库导出的 218 条岗位里只有 52 条带 city，其余标题/正文写着
「市桥」「钟村」「番禺」。检索第 1 层是 `city == '广州'`，city 为 null 的岗位
会被整片排除——库里有货，客户问「广州有什么厂」却永远看不到。
补全只补**能确定**的：推不出来就留 null，绝不默认广州（补错城市等于让客户
跑到另一个城市去面试）。
"""

from __future__ import annotations

import pytest_asyncio
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models_kb import KbAsset, KbCategory, KbEntry, KbFragment
from app.services.kb_seed_import import build_search_text, import_seed, infer_city

TENANT_ID = 1


@pytest_asyncio.fixture(autouse=True)
async def clean_kb(client):  # noqa: ARG001  依赖 client 保证表已建好
    async with SessionLocal() as session:
        await session.execute(delete(KbFragment))
        await session.execute(delete(KbEntry))
        await session.execute(delete(KbCategory))
        await session.execute(delete(KbAsset))
        await session.commit()
    yield


def _seed(*entries: dict) -> dict:
    return {"version": 1, "count": len(entries), "entries": list(entries)}


async def _import(seed: dict):
    async with SessionLocal() as session:
        return await import_seed(session, seed, tenant_id=TENANT_ID)


async def _entry(title: str) -> KbEntry:
    async with SessionLocal() as session:
        return (
            await session.execute(select(KbEntry).where(KbEntry.title == title))
        ).scalar_one()


class TestInferCity:
    """纯函数层：先定优先级，再看边界。"""

    def test_title_district(self) -> None:
        # 市桥是广州番禺的街道名，_CITY_HINTS 里只有市名，靠区县表补
        assert infer_city("市桥雄智", "白班18元/小时，包吃包住") == "广州"

    def test_title_beats_body(self) -> None:
        """标题写的是岗位真实地点，正文提到别的城市不该改判。"""
        assert infer_city("钟村万美表带厂", "广州的厂，也能去深圳") == "广州"

    def test_body_fallback(self) -> None:
        assert infer_city("最新利口福", "番禺南村利口福食品厂 包吃4餐") == "广州"

    def test_title_city_wins_over_title_district(self) -> None:
        assert infer_city("广州番禺电子厂", "") == "广州"

    def test_nothing_mentioned_stays_none(self) -> None:
        """两个字段都没有地名就是 None——不默认广州，也不猜。"""
        assert infer_city("普工招聘", "18元/小时，包吃包住，不用体检") is None

    def test_collision_token_not_guessed(self) -> None:
        """"长安"在"路线队长安排"里也出现，不能当东莞长安镇。"""
        assert infer_city("面试注意事项", "后期入职这些都是路线队长安排的") is None


class TestImportBackfill:
    """导入落库：city 与 search_text 都要跟着变。"""

    async def test_title_only_city_is_filled(self) -> None:
        await _import(_seed({"kind": "job", "title": "市桥雄智", "city": None,
                             "body": "白班18元/小时，包吃包住", "fragments": []}))
        entry = await _entry("市桥雄智")
        assert entry.city == "广州"

    async def test_body_only_city_is_filled(self) -> None:
        await _import(_seed({"kind": "job", "title": "最新利口福", "city": None,
                             "body": "番禺南村利口福食品厂 包吃4餐", "fragments": []}))
        entry = await _entry("最新利口福")
        assert entry.city == "广州"

    async def test_no_city_anywhere_stays_null(self) -> None:
        await _import(_seed({"kind": "job", "title": "普工招聘", "city": None,
                             "body": "18元/小时，包吃包住", "fragments": []}))
        entry = await _entry("普工招聘")
        assert entry.city is None

    async def test_script_is_not_backfilled(self) -> None:
        """话术没有城市语义，补了会在按城市筛岗位时混进闲聊。"""
        await _import(_seed({"kind": "script", "title": "深圳地铁常用语",
                             "city": None, "body": "深圳这边坐地铁要刷卡", "fragments": []}))
        entry = await _entry("深圳地铁常用语")
        assert entry.city is None

    async def test_existing_city_is_not_overwritten(self) -> None:
        """种子自带 city 时以种子为准，推断不能改判。"""
        await _import(_seed({"kind": "job", "title": "东莞钳工", "city": "东莞",
                             "body": "深圳的厂也能去", "fragments": []}))
        entry = await _entry("东莞钳工")
        assert entry.city == "东莞"

    async def test_search_text_uses_backfilled_city(self) -> None:
        body = "白班18元/小时，包吃包住"
        await _import(_seed({"kind": "job", "title": "市桥雄智", "city": None,
                             "body": body, "fragments": []}))
        entry = await _entry("市桥雄智")
        assert entry.search_text == build_search_text("市桥雄智", body, "广州")
        assert entry.search_text.endswith("广州")

    async def test_backfill_keeps_second_import_idempotent(self) -> None:
        """补全后的 city 参与去重键，第二次导入不能把同一批岗位再插一遍。"""
        seed = _seed({"kind": "job", "title": "市桥雄智", "city": None,
                      "body": "白班18元/小时", "fragments": []})
        first = await _import(seed)
        second = await _import(seed)

        assert first.entries_added == 1
        assert first.cities_inferred == 1
        assert second.entries_added == 0
        assert second.entries_skipped == 1
        async with SessionLocal() as session:
            count = len((await session.execute(select(KbEntry))).scalars().all())
        assert count == 1

    async def test_duplicate_titles_in_one_seed_are_all_imported(self) -> None:
        """同名不同内容是不同知识：源数据里「招聘信息」有 25 条，不能互删。"""
        await _import(_seed(
            {"kind": "script", "title": "招聘信息", "city": None, "body": "版本一", "fragments": []},
            {"kind": "script", "title": "招聘信息", "city": None, "body": "版本二", "fragments": []},
        ))
        async with SessionLocal() as session:
            count = len((await session.execute(select(KbEntry))).scalars().all())
        assert count == 2

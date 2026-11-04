"""意图分流：寒暄 / 城市没岗位 / 年龄不符。

三个真实翻车场景（客户原话）：

    你好              → "这个我这边暂时没查到，你方便说一下是哪个城市、什么厂吗？"
    佛山有厂吗        → "我确认一下，稍后回你哈"
    我52岁了还能去吗  → "我确认一下，稍后回你哈"

检索命中 0 条不等于"不知道"。寒暄根本不该查库；城市没岗位要说哪有岗位；
年龄卡住要说清卡在几岁——否则客户只会觉得对面是机器人。

另外两条红线在这里一并守住：
- 寒暄不固定，但每条都要落到一个具体问题上（城市/工种/年龄）；
- 城市名、年龄区间只能来自库里的真实字段，不许编。
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models_kb import KbEntry
from app.services.kb_answer import (
    CLARIFY_CITY_REPLY,
    GREETING_VARIANTS,
    NO_MATCH_REPLY,
    answer,
    classify_greeting,
)


def _job(
    title: str,
    *,
    city: str | None = None,
    age_min: int | None = None,
    age_max: int | None = None,
    kind: str = "job",
    wage_min: float | None = None,
    wage_max: float | None = None,
) -> dict:
    return {
        "title": title,
        "city": city,
        "age_min": age_min,
        "age_max": age_max,
        "kind": kind,
        "wage_min": wage_min,
        "wage_max": wage_max,
    }


async def _seed(entries: Sequence[dict]) -> None:
    """铺数据。search_text 的拼法与 kb_import 一致，否则全文层召不回来。"""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        await session.execute(delete(KbEntry))
        for item in entries:
            body = f"{item['title']} 在招"
            session.add(
                KbEntry(
                    tenant_id=1,
                    kind=item["kind"],
                    title=item["title"],
                    city=item["city"],
                    age_min=item["age_min"],
                    age_max=item["age_max"],
                    wage_min=item["wage_min"],
                    wage_max=item["wage_max"],
                    wage_unit="hour" if item["wage_min"] is not None else None,
                    has_meal=True,
                    has_dorm=True,
                    body=body,
                    search_text=" ".join([item["title"], body, item["city"] or ""]).strip(),
                    status="enabled",
                    valid_until=now + timedelta(days=30),
                )
            )
        await session.commit()


# ─────────────────────────── 寒暄 ───────────────────────────
class TestGreeting:
    async def test_greeting_returns_variant_with_question(self, client) -> None:  # noqa: ARG002
        await _seed([_job("广州电子厂", city="广州", age_min=18, age_max=45)])
        async with SessionLocal() as session:
            result = await answer(session, "你好", None)
        assert result.source == "greeting"
        assert result.reply in GREETING_VARIANTS
        # 每条寒暄都要落到一个具体问题上，客户才接得下去
        assert "？" in result.reply
        assert result.matched_entry_ids == ()
        assert result.llm_fallback is False

    async def test_greeting_not_a_fixed_sentence(self, client) -> None:  # noqa: ARG002
        """真人不会每次一个字不差地回同一句。"""
        await _seed([_job("广州电子厂", city="广州", age_min=18, age_max=45)])
        replies: set[str] = set()
        async with SessionLocal() as session:
            for _ in range(60):
                result = await answer(session, "你好", None)
                replies.add(result.reply)
        assert len(replies) > 1
        assert replies <= set(GREETING_VARIANTS)

    async def test_greeting_works_with_empty_library(self, client) -> None:  # noqa: ARG002
        """空库也得能打招呼——寒暄本来就不该查库。"""
        await _seed([])
        async with SessionLocal() as session:
            result = await answer(session, "在吗", None)
        assert result.source == "greeting"
        assert result.reply in GREETING_VARIANTS

    async def test_greeting_plus_real_question_is_not_greeting(self, client) -> None:  # noqa: ARG002
        """「你好，广州有什么厂」是客户唯一一次说需求，不能当寒暄打发。"""
        await _seed([_job("广州电子厂", city="广州", age_min=18, age_max=45)])
        async with SessionLocal() as session:
            result = await answer(session, "你好，广州有什么厂", None)
        assert result.source != "greeting"
        assert result.matched_entry_ids


class TestClassifyGreeting:
    def test_plain_hellos(self) -> None:
        for text in ("你好", "您好", "在吗", "在不在", "有人吗", "老板", "hello", "hi", "早上好"):
            assert classify_greeting(text) is True, text

    def test_hello_with_substance_is_not_greeting(self) -> None:
        for text in (
            "你好，广州有什么厂",
            "你好我52岁了",
            "佛山有厂吗",
            "老板，工价多少",
            "在吗，我想问下宿舍",
            "",
        ):
            assert classify_greeting(text) is False, text

    def test_long_small_talk_is_not_greeting(self) -> None:
        """超过 8 个字就不当寒暄——宁可多查一次库，也不能把需求当寒暄。"""
        assert classify_greeting("你好呀我是朋友介绍过来的想找个活干") is False


# ─────────────────────── 城市没有岗位 ───────────────────────
class TestCityEmpty:
    async def test_points_to_real_cities(self, client) -> None:  # noqa: ARG002
        await _seed(
            [
                _job("广州电子厂", city="广州", age_min=18, age_max=45),
                _job("广州番禺电子厂", city="广州", age_min=18, age_max=45),
                _job("深圳电子厂", city="深圳", age_min=18, age_max=45),
                _job("东莞电子厂", city="东莞", age_min=18, age_max=45),
            ]
        )
        async with SessionLocal() as session:
            result = await answer(session, "佛山有厂吗", None)
        assert result.source == "city_empty"
        assert "佛山暂时没有合适的" in result.reply
        # 推荐的城市必须真实存在，且按在招条目数排前面
        assert "广州" in result.reply
        assert result.reply.index("广州") < result.reply.index("深圳")
        assert result.matched_entry_ids == ()

    async def test_lists_at_most_three_cities(self, client) -> None:  # noqa: ARG002
        await _seed(
            [
                _job("广州电子厂", city="广州"),
                _job("广州番禺电子厂", city="广州"),
                _job("深圳电子厂", city="深圳"),
                _job("东莞电子厂", city="东莞"),
                _job("中山电子厂", city="中山"),
            ]
        )
        async with SessionLocal() as session:
            result = await answer(session, "佛山有厂吗", None)
        assert result.source == "city_empty"
        assert "广州" in result.reply
        mentioned = [c for c in ("广州", "深圳", "东莞", "中山") if c in result.reply]
        assert len(mentioned) == 3  # 最多报三个，报太多客户记不住

    async def test_no_other_city_falls_back_to_no_match(self, client) -> None:  # noqa: ARG002
        """库里一条都没有：不能编城市，退回原有兜底。"""
        await _seed([])
        async with SessionLocal() as session:
            result = await answer(session, "佛山有厂吗", None)
        assert result.source == "no_match"
        assert result.reply == NO_MATCH_REPLY

    async def test_disabled_city_not_recommended(self, client) -> None:  # noqa: ARG002
        await _seed([_job("广州电子厂", city="广州")])
        async with SessionLocal() as session:
            entry = (
                await session.execute(select(KbEntry).where(KbEntry.title == "广州电子厂"))
            ).scalar_one()
            entry.status = "disabled"
            await session.commit()
            result = await answer(session, "佛山有厂吗", None)
        assert result.source == "no_match"
        assert "广州" not in result.reply


# ─────────────────────────── 年龄不符 ───────────────────────────
class TestAgeMismatch:
    async def test_explains_real_age_range(self, client) -> None:  # noqa: ARG002
        await _seed([_job("番禺电子厂", city="广州", age_min=18, age_max=45)])
        async with SessionLocal() as session:
            result = await answer(session, "我52岁了还能去吗", None, history=["我在广州"])
        assert result.source == "age_mismatch"
        # 区间来自条目真实字段，客户年龄来自他自己那句话
        assert "18" in result.reply and "45" in result.reply
        assert "52" in result.reply
        assert result.matched_entry_ids

    async def test_age_mismatch_beats_city_empty(self, client) -> None:  # noqa: ARG002
        """同城有岗位、只是年龄不够：说年龄，别把客户支到别的城市。"""
        await _seed(
            [
                _job("番禺电子厂", city="广州", age_min=18, age_max=45),
                _job("深圳电子厂", city="深圳", age_min=18, age_max=45),
            ]
        )
        async with SessionLocal() as session:
            result = await answer(session, "我52岁了还能去吗", None, history=["我在广州"])
        assert result.source == "age_mismatch"
        assert "45" in result.reply
        assert "深圳" not in result.reply

    async def test_no_age_range_falls_back_to_city(self, client) -> None:  # noqa: ARG002
        """条目没录年龄区间：不能瞎编，退回城市级解释。"""
        await _seed(
            [
                _job("佛山电子厂", city="佛山"),
                _job("广州电子厂", city="广州"),
            ]
        )
        async with SessionLocal() as session:
            result = await answer(session, "我52岁了还能去吗", None, history=["我在佛山"])
        assert result.source == "city_empty"
        assert "佛山暂时没有合适的" in result.reply
        assert "广州" in result.reply


# ─────────────────────── 原有行为不回归 ───────────────────────
class TestNoRegression:
    async def test_normal_city_query_still_hits(self, client) -> None:  # noqa: ARG002
        await _seed(
            [_job("广州电子厂", city="广州", age_min=18, age_max=45, wage_min=22, wage_max=25)]
        )
        async with SessionLocal() as session:
            result = await answer(session, "广州有什么厂", None)
        assert result.source in {"template", "llm"}
        assert result.matched_entry_ids
        assert "广州电子厂" in result.reply

    async def test_clarify_still_asks_city(self, client) -> None:  # noqa: ARG002
        await _seed([_job("广州电子厂", city="广州", age_min=18, age_max=45)])
        async with SessionLocal() as session:
            result = await answer(session, "工价多少一个小时", None)
        assert result.source == "clarify"
        assert result.reply == CLARIFY_CITY_REPLY

    async def test_specific_factory_miss_stays_no_match(self, client) -> None:  # noqa: ARG002
        """问的是具体厂名、库里没有：仍走原来的"你方便说一下吗"。"""
        await _seed([_job("广州电子厂", city="广州")])
        async with SessionLocal() as session:
            result = await answer(session, "立讯精密现在还招吗", None)
        assert result.source == "no_match"
        assert "方便说一下" in result.reply

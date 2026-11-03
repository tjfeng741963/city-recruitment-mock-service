"""回复生成的安全边界：数字校验。

这条防线是整份方案里性价比最高的一段代码——十行左右，
挡住的是"模型编工价赔钱"这个真实风险。
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.models_kb import KbEntry
from app.services.kb_reply import Facts, build_facts, extract_numbers, verify_reply
from app.services.kb_search import SearchHit, SearchResult


def _job(**overrides) -> KbEntry:
    values = {
        "id": 1,
        "tenant_id": 1,
        "kind": "job",
        "title": "广州电子厂",
        "city": "广州",
        "age_min": 18,
        "age_max": 45,
        "wage_min": Decimal("22"),
        "wage_max": Decimal("25"),
        "wage_unit": "hour",
        "has_meal": True,
        "has_dorm": True,
        "body": "18-45岁 22-25元/小时 包吃住",
    }
    values.update(overrides)
    return KbEntry(**values)


class TestExtractNumbers:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("22-25元/小时", {"22", "25"}),
            ("18到45岁", {"18", "45"}),
            ("二十二块钱", {"22"}),
            ("十八到四十五", {"18", "45"}),
            ("没有数字", set()),
            ("包吃住", set()),
        ],
    )
    def test_extract(self, text: str, expected: set[str]) -> None:
        assert extract_numbers(text) == expected

    def test_normalizes_trailing_zero(self) -> None:
        assert extract_numbers("22.0 元") == {"22"}


class TestVerifyReply:
    def test_allowed_numbers_pass(self) -> None:
        ok, bad = verify_reply("这个厂 18-45 岁，22-25 块一小时", {"18", "45", "22", "25"})
        assert ok is True
        assert bad == set()

    def test_fabricated_wage_is_caught(self) -> None:
        """模型把 22 编成 30 —— 必须被拦下。"""
        ok, bad = verify_reply("这个厂 30 块一小时", {"18", "45", "22", "25"})
        assert ok is False
        assert bad == {"30"}

    def test_fabricated_age_is_caught(self) -> None:
        ok, bad = verify_reply("45岁以下都能去，放宽到55", {"18", "45"})
        assert ok is False
        assert "55" in bad

    def test_chinese_numeral_fabrication_caught(self) -> None:
        ok, bad = verify_reply("三十块一个小时", {"22", "25"})
        assert ok is False
        assert bad == {"30"}

    def test_empty_reply_passes(self) -> None:
        ok, bad = verify_reply("好的", {"22"})
        assert ok is True
        assert bad == set()


class TestBuildFacts:
    def test_facts_include_structured_fields(self) -> None:
        result = SearchResult(hits=(SearchHit(entry=_job(), tier="sql"),))
        facts = build_facts(result)
        assert "18-45" in facts.block
        assert "22-25" in facts.block
        assert "广州" in facts.block

    def test_allowed_numbers_cover_facts(self) -> None:
        result = SearchResult(hits=(SearchHit(entry=_job(), tier="sql"),))
        facts = build_facts(result)
        assert {"18", "45", "22", "25"} <= facts.allowed_numbers

    def test_empty_result(self) -> None:
        facts = build_facts(SearchResult())
        assert facts.block == ""
        assert facts.allowed_numbers == set()

    def test_script_entry_has_no_structured_numbers(self) -> None:
        entry = KbEntry(
            id=2, tenant_id=1, kind="script", title="超龄话术", body="稍等一下，后续再聊"
        )
        facts = build_facts(SearchResult(hits=(SearchHit(entry=entry, tier="sql"),)))
        assert facts.allowed_numbers == set()


class TestFactsIsImmutable:
    def test_dataclass_frozen(self) -> None:
        facts = Facts(block="x", allowed_numbers={"1"})
        with pytest.raises(Exception):
            facts.block = "y"  # type: ignore[misc]

"""召回率评测器的自检：保证统计口径正确，不是保证检索够好。

检索够不够好由实跑结果决定（`python -m app.services.kb_eval`），
这里只验证"命中判定"和"阈值判断"这两件逻辑本身。
"""

from __future__ import annotations

import json
from pathlib import Path

from app.services.kb_eval import PASS_THRESHOLD, EvalCase, EvalResult, load_cases


class TestEvalResult:
    def test_recall_math(self) -> None:
        result = EvalResult(total=50, hits=40)
        assert result.recall == 0.8

    def test_zero_total_does_not_divide_by_zero(self) -> None:
        assert EvalResult().recall == 0.0

    def test_passes_at_threshold(self) -> None:
        at = EvalResult(total=10, hits=int(PASS_THRESHOLD * 10))
        assert at.passes is True

    def test_fails_below_threshold(self) -> None:
        below = EvalResult(total=10, hits=int(PASS_THRESHOLD * 10) - 1)
        assert below.passes is False

    def test_recommendation_changes_with_result(self) -> None:
        good = EvalResult(total=10, hits=10).as_dict()
        bad = EvalResult(total=10, hits=0).as_dict()
        assert "暂不建向量层" in good["recommendation"]
        assert "pgvector" in bad["recommendation"]


class TestLoadCases:
    def test_loads_real_question_set(self) -> None:
        path = Path(__file__).parent / "data" / "kb_questions.json"
        cases = load_cases(path)
        assert len(cases) == 50
        assert all(isinstance(c, EvalCase) for c in cases)
        assert all(c.expected_keywords for c in cases)

    def test_questions_are_colloquial_not_keyword_stuffing(self) -> None:
        """评测集必须是真实口语，否则测出来的召回率不可信。"""
        path = Path(__file__).parent / "data" / "kb_questions.json"
        cases = load_cases(path)
        short = [c for c in cases if len(c.question) <= 12]
        assert len(short) >= 40  # 绝大多数问法都是短句

    def test_parses_optional_city(self, tmp_path: Path) -> None:
        raw = [
            {"question": "有活吗", "expected_keywords": ["岗位"]},
            {"question": "广州有活吗", "expected_keywords": ["广州"], "city": "广州"},
        ]
        p = tmp_path / "q.json"
        p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        cases = load_cases(p)
        assert cases[0].city is None
        assert cases[1].city == "广州"

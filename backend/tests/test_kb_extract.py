"""知识库文本处理：相对日期换算 + 岗位字段抽取。

这些用例的期望值全部来自 docs/知识库与后端技术选型-决策文档.md 里
从真实话术库统计出来的样本，不是凭空构造的。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest

from app.services.kb_extract import (
    DEFAULT_VALIDITY_DAYS,
    convert_relative_date,
    extract_job_fields,
    has_relative_date,
)

BASE_DAY = date(2026, 11, 3)  # 周二


class TestRelativeDate:
    def test_tomorrow_noon(self) -> None:
        """源数据原文：万美表带厂 明天中午一点面试"""
        when, note = convert_relative_date("万美表带厂 明天中午一点面试", BASE_DAY)
        assert when is not None
        assert when.date() == date(2026, 11, 4)
        assert when.hour == 13
        assert when.minute == 0
        assert note is not None

    def test_today(self) -> None:
        when, _ = convert_relative_date("今天下午三点面试", BASE_DAY)
        assert when is not None
        assert when.date() == BASE_DAY
        assert when.hour == 15

    def test_after_tomorrow(self) -> None:
        when, _ = convert_relative_date("后天上午十点", BASE_DAY)
        assert when is not None
        assert when.date() == date(2026, 11, 5)
        assert when.hour == 10

    def test_weekday_this_week(self) -> None:
        """周二是基准日，周五应该在同周。"""
        when, _ = convert_relative_date("周五下午两点面试", BASE_DAY)
        assert when is not None
        assert when.date() == date(2026, 11, 6)
        assert when.hour == 14

    def test_weekday_next_week(self) -> None:
        when, _ = convert_relative_date("下周三面试", BASE_DAY)
        assert when is not None
        assert when.date() == date(2026, 11, 11)

    def test_absolute_date_this_year(self) -> None:
        when, _ = convert_relative_date("11月20号面试", BASE_DAY)
        assert when is not None
        assert when.date() == date(2026, 11, 20)

    def test_absolute_date_rolls_to_next_year(self) -> None:
        """3 月 5 日在 11 月之后，应推到次年。"""
        when, _ = convert_relative_date("3月5日面试", BASE_DAY)
        assert when is not None
        assert when.date() == date(2027, 3, 5)

    def test_no_date_returns_none(self) -> None:
        when, note = convert_relative_date("包吃住 18-45岁", BASE_DAY)
        assert when is None
        assert note is None

    def test_hhmm_format(self) -> None:
        when, _ = convert_relative_date("明天 14:30 面试", BASE_DAY)
        assert when is not None
        assert when.hour == 14
        assert when.minute == 30

    def test_date_without_clock_defaults_to_nine(self) -> None:
        when, _ = convert_relative_date("明天面试", BASE_DAY)
        assert when is not None
        assert when.hour == 9

    def test_cn_numerals(self) -> None:
        when, _ = convert_relative_date("明天上午十点半", BASE_DAY)
        assert when is not None
        assert when.hour == 10
        assert when.minute == 30

    def test_result_is_timezone_aware(self) -> None:
        when, _ = convert_relative_date("明天面试", BASE_DAY)
        assert when is not None
        assert when.tzinfo is not None
        assert when.utcoffset() is not None
        assert when.utcoffset().total_seconds() == 8 * 3600


class TestJobFields:
    def test_full_job_posting(self) -> None:
        text = "广州万美表带厂 18-45岁 22-25元/小时 包吃住 明天中午一点面试"
        f = extract_job_fields(text, base=BASE_DAY)
        assert f.city == "广州"
        assert f.age_min == 18
        assert f.age_max == 45
        assert f.wage_min == Decimal("22")
        assert f.wage_max == Decimal("25")
        assert f.wage_unit == "hour"
        assert f.has_meal is True
        assert f.has_dorm is True
        assert f.interview_at is not None

    def test_validity_follows_interview(self) -> None:
        f = extract_job_fields("明天上午十点面试", base=BASE_DAY)
        assert f.interview_at is not None
        assert f.valid_until is not None
        assert (f.valid_until - f.interview_at).days == DEFAULT_VALIDITY_DAYS

    def test_no_fabrication_when_missing(self) -> None:
        """抽不到就留空，绝不猜。"""
        f = extract_job_fields("地铁安检员，待遇面议", base=BASE_DAY)
        assert f.age_min is None
        assert f.age_max is None
        assert f.wage_min is None
        assert f.interview_at is None

    def test_cn_numeral_age_range_not_guessed(self) -> None:
        f = extract_job_fields("年龄：二十到四十五", base=BASE_DAY)
        assert f.age_min is None

    def test_not_including_meals(self) -> None:
        f = extract_job_fields("工价 20-22元/月 不包吃", base=BASE_DAY)
        assert f.has_meal is False

    def test_wage_reversed_range_is_normalized(self) -> None:
        f = extract_job_fields("25-20元/天", base=BASE_DAY)
        assert f.wage_min == Decimal("20")
        assert f.wage_max == Decimal("25")

    def test_single_wage(self) -> None:
        f = extract_job_fields("每小时 20元/小时", base=BASE_DAY)
        assert f.wage_min == Decimal("20")
        assert f.wage_max == Decimal("20")
        assert f.wage_unit == "hour"

    def test_empty_text(self) -> None:
        f = extract_job_fields("")
        assert f.city is None
        assert f.interview_at is None


class TestRelativeDateDetection:
    @pytest.mark.parametrize(
        "text",
        ["明天面试", "今日下午", "后天到岗", "本周三面试", "下周一"],
    )
    def test_detects_relative(self, text: str) -> None:
        assert has_relative_date(text) is True

    @pytest.mark.parametrize("text", ["包吃住 18-45岁", "广州 22元/小时"])
    def test_plain_text_has_none(self, text: str) -> None:
        assert has_relative_date(text) is False


class TestCityExtraction:
    """城市字段错了会把客户推荐到别的城市，比不填更糟。"""

    def test_title_wins_over_body(self) -> None:
        """标题写东莞、正文提到深圳时，以标题为准。"""
        f = extract_job_fields(
            "东莞的厂，也可以安排深圳的岗位", title="东莞钳工CNC招工"
        )
        assert f.city == "东莞"

    def test_nearest_city_in_title_wins(self) -> None:
        f = extract_job_fields("", title="东莞惠州转莞深")
        assert f.city == "东莞"

    def test_body_used_when_title_has_none(self) -> None:
        f = extract_job_fields("广州万美表带厂 18-45岁", title="表带厂招工")
        assert f.city == "广州"

    def test_no_city_anywhere(self) -> None:
        f = extract_job_fields("18-45岁 22元/小时", title="电子厂招工")
        assert f.city is None

    def test_title_only(self) -> None:
        f = extract_job_fields("", title="珠海安保招聘")
        assert f.city == "珠海"

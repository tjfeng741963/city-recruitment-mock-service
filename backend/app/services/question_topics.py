"""Disambiguate named expenses before generic wage keyword matching."""

WAGE_KEYWORDS = ("工资", "薪资", "工钱", "工价", "待遇", "收入", "月薪", "时薪", "日薪", "挣多少", "多少钱")

_EXPENSE_SUBJECTS = (
    "体检", "查体", "健康证", "报销", "社保", "保险", "五险", "一金",
    "工衣", "制服", "服装", "培训", "宿舍", "住宿", "吃饭", "伙食", "水电",
    "报名", "中介", "介绍费", "路费", "车费", "交通", "押金", "保证金",
    "被褥", "床上用品", "收费", "费用", "交钱", "交多少", "缴费", "花钱",
)
_COST_WORDS = ("多少", "钱", "费", "扣", "报销", "免费", "自费", "贵", "便宜", "元", "块")


def is_non_wage_cost_question(text: str) -> bool:
    """A named cost, including deductions from wages, needs its own policy.

    Bare “多少钱” remains a wage follow-up. A named expense cannot be answered
    by gross wages or by a general accommodation/shift field instead.
    """
    value = str(text or "")
    return any(word in value for word in _EXPENSE_SUBJECTS) and any(
        word in value for word in _COST_WORDS
    )


def is_wage_keyword(keyword: str) -> bool:
    """Include compound wage phrases without discarding “体检多少钱”."""
    return any(word in keyword for word in WAGE_KEYWORDS) and not any(
        word in keyword for word in _EXPENSE_SUBJECTS
    )

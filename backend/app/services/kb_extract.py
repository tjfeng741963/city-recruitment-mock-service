"""知识库文本处理：相对日期换算 + 岗位字段抽取。

为什么必须先做这一步（docs/知识库与后端技术选型-决策文档.md 2.4 节）：

    万美表带厂   明天中午一点面试

这句话在写下时是对的，下周检索出来就是错的。直接发给客户等于承诺了一个
不存在的面试时间——这是劳务纠纷级别的错误。所以相对日期必须在**入库时**
换成绝对时间戳 + 有效期，不能等导进去再补。

这里的函数全部是纯函数，不碰数据库，方便单测。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation

# 默认有效期：面试时间之后 2 天。过了这个点条目自动过期，不再参与检索。
DEFAULT_VALIDITY_DAYS = 2

# 中国没有夏令时，业务全在国内，固定 +08:00 即可。
CN_TZ = timezone(timedelta(hours=8))

_CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}

_WEEKDAY_NAMES = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}

_RELATIVE_DAY_PATTERNS: tuple[tuple[re.Pattern[str], int], ...] = (
    (re.compile(r"大后天"), 3),
    (re.compile(r"后天"), 2),
    (re.compile(r"明天|明日"), 1),
    (re.compile(r"今天|今日"), 0),
)

_WEEKDAY_PATTERN = re.compile(r"(?:本|这|下)?周([一二三四五六日天])")

_CLOCK_PATTERN = re.compile(
    r"(上午|下午|晚上|中午|早上|凌晨)?\s*"
    r"([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*[点時时]\s*"
    r"(半|[0-9]{1,2}分|[一二三四五六七八九十]{1,3}分)?"
)
_HHMM_PATTERN = re.compile(r"([0-9]{1,2})\s*[:：]\s*([0-9]{2})")

_ABS_DATE_PATTERN = re.compile(r"([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*[日号]")

_AGE_PATTERN = re.compile(
    r"([0-9]{2})\s*[-~—至到]\s*([0-9]{2})\s*[岁周岁]"
    r"|年龄\s*[:：]?\s*([0-9]{2})\s*[-~—至到]\s*([0-9]{2})"
)

_WAGE_UNIT_WORDS = {
    "小时": "hour", "时": "hour",
    "天": "day",
    "月": "month",
}

_WAGE_PATTERN = re.compile(
    r"([0-9]+(?:\.[0-9]+)?)\s*[-~—至到]\s*([0-9]+(?:\.[0-9]+)?)\s*"
    r"(?:元|块)?\s*[/每]\s*(小时|时|天|月)"
    r"|([0-9]+(?:\.[0-9]+)?)\s*[-~—至到]\s*([0-9]+(?:\.[0-9]+)?)\s*"
    r"(?:元|块)?\s*一?(小时|天|月)"
    r"|([0-9]+(?:\.[0-9]+)?)\s*(?:元|块)?\s*[/每]\s*(小时|时|天|月)"
)

_MEAL_WORDS = ("包吃", "包吃住", "管吃", "包中餐", "包午餐", "三餐")
_DORM_WORDS = ("包住", "包吃住", "有宿舍", "包住宿", "住宿")

_CITY_HINTS = (
    "广州", "深圳", "东莞", "佛山", "中山", "珠海", "惠州", "南宁", "柳州", "桂林",
    "成都", "武汉", "长沙", "郑州", "天津", "西安", "杭州", "昆明", "重庆", "青岛",
    "沈阳", "南通", "呼和浩特", "北京", "上海", "苏州", "厦门", "福州", "合肥",
)


@dataclass(frozen=True)
class JobFields:
    """从一条岗位文案里能抽出来的结构化事实。抽不到就是 None，不要瞎猜。"""

    city: str | None = None
    age_min: int | None = None
    age_max: int | None = None
    wage_min: Decimal | None = None
    wage_max: Decimal | None = None
    wage_unit: str | None = None
    has_meal: bool | None = None
    has_dorm: bool | None = None
    interview_at: datetime | None = None
    valid_until: datetime | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)


def _cn_number(token: str) -> int | None:
    """把 "两"/"十二"/"二五" 这种中文数字转成整数。超出 99 的放弃。"""
    if not token:
        return None
    if token.isdigit():
        return int(token)
    if token == "十":
        return 10
    if len(token) == 1:
        return _CN_DIGITS.get(token)
    if len(token) == 2:
        if token[0] == "十":
            return 10 + (_CN_DIGITS.get(token[1]) or 0)
        if token[1] == "十":
            return (_CN_DIGITS.get(token[0]) or 0) * 10
    if len(token) == 3 and token[1] == "十":
        return (_CN_DIGITS.get(token[0]) or 0) * 10 + (_CN_DIGITS.get(token[2]) or 0)
    return None


def _parse_clock(text: str) -> tuple[int, int] | None:
    """在文案里找时刻，返回 (hour, minute)。找不到返回 None。"""
    m = _CLOCK_PATTERN.search(text)
    if m:
        period, hour_tok, minute_tok = m.groups()
        hour = _cn_number(hour_tok or "")
        if hour is not None and hour <= 24:
            minute = 0
            if minute_tok == "半":
                minute = 30
            elif minute_tok and minute_tok.endswith("分"):
                parsed = _cn_number(minute_tok[:-1])
                if parsed is not None and parsed < 60:
                    minute = parsed
            if period in ("下午", "晚上") and hour < 12:
                hour += 12
            elif period == "中午":
                # "中午一点"是 13 点，"中午十二点"是 12 点，不是 24 点
                if 1 <= hour <= 5:
                    hour += 12
                elif hour == 12:
                    hour = 12
            elif period == "凌晨" and hour == 12:
                hour = 0
            return hour, minute

    hhmm = _HHMM_PATTERN.search(text)
    if hhmm:
        hour, minute = int(hhmm.group(1)), int(hhmm.group(2))
        if hour <= 24 and minute < 60:
            return hour, minute
    return None


def convert_relative_date(
    text: str, base: date | datetime | None = None
) -> tuple[datetime | None, str | None]:
    """把文案里的面试时间换成绝对时间戳。

    返回 (interview_at, note)。note 说明这次换算的依据，抽不到时为 None。

    基准日只能是导入日——源数据里只有"明天中午一点"，没有基准日期。
    因此这个函数**必须在导入时调用**，结果落库；不要留到检索时再算。
    """
    if base is None:
        base_day = datetime.now(CN_TZ).date()
    elif isinstance(base, datetime):
        base_day = base.date()
    else:
        base_day = base

    target_day: date | None = None
    note: str | None = None

    for pattern, offset in _RELATIVE_DAY_PATTERNS:
        if pattern.search(text):
            target_day = base_day + timedelta(days=offset)
            note = f"相对日+{offset}"
            break

    if target_day is None:
        m = _WEEKDAY_PATTERN.search(text)
        if m:
            weekday = _WEEKDAY_NAMES.get(m.group(1))
            if weekday is not None:
                prefix = m.group(0)[:1]
                delta = (weekday - base_day.weekday()) % 7
                if prefix == "下":
                    # "下周三"永远是下一周，即使今天就是周三也是 +7
                    delta += 7
                target_day = base_day + timedelta(days=delta)
                note = f"周{prefix}{m.group(1)}"

    if target_day is None:
        m = _ABS_DATE_PATTERN.search(text)
        if m:
            month, day = int(m.group(1)), int(m.group(2))
            if 1 <= month <= 12 and 1 <= day <= 31:
                try:
                    candidate = date(base_day.year, month, day)
                except ValueError:
                    candidate = None
                if candidate is not None:
                    if candidate < base_day:
                        try:
                            candidate = date(base_day.year + 1, month, day)
                        except ValueError:
                            candidate = None
                    if candidate is not None:
                        target_day = candidate
                        note = f"{month}月{day}日"

    if target_day is None:
        return None, None

    clock = _parse_clock(text)
    if clock is None:
        # 只有日期没有时刻：默认当天上午 9 点，比"0 点"更接近劳务行业实际。
        hour, minute = 9, 0
        note = (note or "") + "+默认9点"
    else:
        hour, minute = clock

    interview_at = datetime.combine(target_day, time(hour, minute), tzinfo=CN_TZ)
    return interview_at, note


def _to_decimal(raw: str | None) -> Decimal | None:
    if not raw:
        return None
    try:
        return Decimal(raw)
    except (InvalidOperation, ValueError):
        return None


def _normalize_unit(raw: str | None) -> str | None:
    return _WAGE_UNIT_WORDS.get(raw) if raw else None


def _extract_age(text: str) -> tuple[int | None, int | None]:
    m = _AGE_PATTERN.search(text)
    if not m:
        return None, None
    low = m.group(1) or m.group(3)
    high = m.group(2) or m.group(4)
    try:
        age_min, age_max = int(low), int(high)
    except (TypeError, ValueError):
        return None, None
    if age_min > age_max or age_max > 150:
        return None, None
    return age_min, age_max


def _extract_wage(text: str) -> tuple[Decimal | None, Decimal | None, str | None]:
    m = _WAGE_PATTERN.search(text)
    if not m:
        return None, None, None
    if m.group(1):
        low_raw, high_raw, unit_raw = m.group(1), m.group(2), m.group(3)
    elif m.group(4):
        low_raw, high_raw, unit_raw = m.group(4), m.group(5), m.group(6)
    else:
        low_raw, high_raw, unit_raw = m.group(7), None, m.group(8)

    unit = _normalize_unit(unit_raw)
    low = _to_decimal(low_raw)
    if low is None:
        return None, None, unit
    high = _to_decimal(high_raw)
    if high is None:
        high = low
    if high < low:
        low, high = high, low
    return low, high, unit


def _cities_with_position(text: str) -> list[tuple[int, str]]:
    """返回文本里出现的城市及其位置，按位置排序。

    位置很关键：标题"东莞到深圳"里，离开头最近的才是主城市。
    原实现按词表顺序取第一个命中，导致标题写东莞的条目被判成深圳。
    """
    found: list[tuple[int, str]] = []
    for city in _CITY_HINTS:
        start = text.find(city)
        if start >= 0:
            found.append((start, city))
    return sorted(found)


def _extract_city(text: str, title: str | None = None) -> str | None:
    """城市优先级：标题里最靠前的 > 正文里最靠前的。

    标题优先的理由：正文经常顺带提到别的城市（"广州的厂，也能去深圳"），
    但标题写的是这条岗位的真实地点。实测 218 条岗位里有 9 条因此
    记错城市，客户可能被推荐到别的城市去。
    """
    if title:
        in_title = _cities_with_position(title)
        if in_title:
            return in_title[0][1]
    in_body = _cities_with_position(text)
    return in_body[0][1] if in_body else None


def _extract_flags(
    text: str, words: tuple[str, ...], negative_words: tuple[str, ...]
) -> bool | None:
    if any(w in text for w in negative_words):
        return False
    if any(w in text for w in words):
        return True
    return None


def extract_job_fields(
    text: str, *, title: str | None = None, base: date | datetime | None = None
) -> JobFields:
    """从一条岗位文案里抽结构化事实。抽不到的字段一律 None。

    宁可留空也不要猜：工价猜错要赔钱。这些字段只用于确定性筛选，
    原文 `body` 始终保留，展示时以原文为准。
    """
    # 正文为空也要抽城市：有些条目只有标题和图片，标题里的城市是唯一线索
    if not text:
        return JobFields(city=_extract_city("", title))

    age_min, age_max = _extract_age(text)
    wage_min, wage_max, wage_unit = _extract_wage(text)
    interview_at, date_note = convert_relative_date(text, base)

    notes: list[str] = []
    if date_note:
        notes.append(date_note)

    valid_until = None
    if interview_at is not None:
        valid_until = interview_at + timedelta(days=DEFAULT_VALIDITY_DAYS)

    return JobFields(
        city=_extract_city(text, title),
        age_min=age_min,
        age_max=age_max,
        wage_min=wage_min,
        wage_max=wage_max,
        wage_unit=wage_unit,
        has_meal=_extract_flags(text, _MEAL_WORDS, ("不包吃", "不管吃")),
        has_dorm=_extract_flags(text, _DORM_WORDS, ("不包住", "不管住", "无住宿")),
        interview_at=interview_at,
        valid_until=valid_until,
        notes=tuple(notes),
    )


def has_relative_date(text: str) -> bool:
    """这条文案是否含相对日期。用于生成数据质量报告。"""
    if any(p.search(text) for p, _ in _RELATIVE_DAY_PATTERNS):
        return True
    return bool(_WEEKDAY_PATTERN.search(text))

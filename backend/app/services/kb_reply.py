"""回复生成：事实块 / 话术块分离 + 数字后置校验 + 降级。

这是整个方案里最便宜也最重要的一道防线（决策文档 6.1 节）。

    如果让模型自由生成工价、年龄、面试时间，它一定会编。
    劳务行业编错工价要赔钱。

所以 prompt 里事实块和话术块物理分开，生成后校验：
回复里出现的每个数字，必须能在事实块里找到；找不到就降级为原文模板。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .kb_search import SearchResult

# 匹配中文文案里的数字。工价/年龄/时间都用阿拉伯数字写，
# 但模型可能写成"二十二"，所以中文数字也要覆盖。
_ARABIC_NUM = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_CN_NUM_CHARS = "零〇一二两三四五六七八九十百"
_CN_NUM = re.compile(f"[{_CN_NUM_CHARS}]+")

_CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}

# 单个中文数字后面跟这些字，才算真的数字（"八块"、"5岁"）。
# 否则"一小时"、"稍等一下"里的"一"会被误判成数字，把正常回复判成编造。
_CN_SINGLE_ACCEPT = set("元块岁月日号")


def _cn_to_int(token: str) -> int | None:
    """把中文数字串转成整数。只处理 0-999，够覆盖年龄和工价。"""
    if not token:
        return None
    if token == "十":
        return 10
    if "十" in token:
        left, _, right = token.partition("十")
        tens = _CN_DIGITS.get(left, 1) if left else 1
        ones = _CN_DIGITS.get(right, 0) if right else 0
        return tens * 10 + ones
    if len(token) == 1:
        return _CN_DIGITS.get(token)
    total = 0
    for ch in token:
        digit = _CN_DIGITS.get(ch)
        if digit is None:
            return None
        total = total * 10 + digit
    return total


def extract_numbers(text: str) -> set[str]:
    """提取文本里所有数字，统一成字符串形式方便比对。"""
    if not text:
        return set()
    values: set[str] = set()
    for raw in _ARABIC_NUM.findall(text):
        try:
            as_float = float(raw)
        except ValueError:
            continue
        # 归一化：22.0 和 22 视为同一个数
        values.add(str(int(as_float)) if as_float.is_integer() else str(as_float))
    for match in _CN_NUM.finditer(text):
        raw = match.group()
        parsed = _cn_to_int(raw)
        if parsed is None:
            continue
        if len(raw) == 1:
            # 单个"一"/"两"大多是虚词："一小时"、"稍等一下"、"两点半"。
            # 只有紧跟量词/货币单位时才当成真数字（"八块"、"5岁"）。
            nxt = text[match.end() : match.end() + 1]
            if nxt not in _CN_SINGLE_ACCEPT:
                continue
        values.add(str(parsed))
    return values


def verify_reply(reply: str, allowed_numbers: set[str]) -> tuple[bool, set[str]]:
    """校验回复里的数字是否都在授权范围内。

    返回 (是否通过, 越权的数字集合)。越权集合非空时调用方必须降级。
    """
    used = extract_numbers(reply)
    unauthorized = {n for n in used if n not in allowed_numbers}
    return (not unauthorized), unauthorized


@dataclass(frozen=True)
class Facts:
    """从检索结果里提取的、允许出现在回复中的事实与数字。"""

    block: str
    allowed_numbers: set[str]


def build_facts(result: SearchResult, *, limit: int = 3) -> Facts:
    """把命中的知识条目整理成 prompt 里的事实块。

    只取前几条：塞太多会稀释模型注意力，也超出成本预期。
    """
    lines: list[str] = []
    allowed: set[str] = set()

    for hit in result.hits[:limit]:
        entry = hit.entry
        parts = [f"【{entry.title}】"]

        if entry.kind == "job":
            if entry.city:
                parts.append(f"城市：{entry.city}")
            if entry.age_min is not None and entry.age_max is not None:
                parts.append(f"年龄要求：{entry.age_min}-{entry.age_max} 岁")
            if entry.wage_min is not None:
                unit = {"hour": "元/小时", "day": "元/天", "month": "元/月"}.get(
                    entry.wage_unit or "", ""
                )
                if entry.wage_max is not None and entry.wage_max != entry.wage_min:
                    parts.append(f"工价：{entry.wage_min}-{entry.wage_max}{unit}")
                else:
                    parts.append(f"工价：{entry.wage_min}{unit}")
            if entry.has_meal is True:
                parts.append("包吃")
            if entry.has_dorm is True:
                parts.append("包住")
            if entry.interview_at is not None:
                parts.append(f"面试时间：{entry.interview_at:%Y-%m-%d %H:%M}")

        body = (entry.body or "").strip()
        if body:
            parts.append(f"原文：{body[:300]}")

        lines.append("；".join(parts))
        # 只有事实块里的数字才被授权。原文里的数字也算——那是客户自己的资料。
        allowed |= extract_numbers("；".join(parts))

    return Facts(block="\n".join(lines), allowed_numbers=allowed)


SYSTEM_PROMPT = """你是劳务派遣公司的招聘顾问，正在用企业微信跟求职者聊天。

【硬约束】
1. 只能使用下面【事实】里的工价、年龄、面试时间。禁止编造任何数字。
2. 事实里没有的信息，就说"我确认一下再回你"，不要猜。
3. 口语化、简短，像人聊天；不要用"知识库""系统""根据记录"这类词。
4. 不要输出事实里没有的数字。"""


def build_messages(user_text: str, facts: Facts, *, scripts: SearchResult | None = None):
    """组装 prompt。事实块与话术块物理分开——这是安全边界的落点。"""
    from .llm_provider import ChatMessage

    sections = [SYSTEM_PROMPT, "\n【事实，禁止改写】\n" + (facts.block or "（无匹配岗位）")]

    if scripts is not None and len(scripts) > 0:
        script_lines = [f"- {(h.entry.body or '').strip()[:200]}" for h in scripts.hits[:3]]
        sections.append("\n【参考话术，可自由改写】\n" + "\n".join(script_lines))

    sections.append(f"\n【求职者】\n{user_text}")
    return [ChatMessage(role="system", content="".join(sections))]

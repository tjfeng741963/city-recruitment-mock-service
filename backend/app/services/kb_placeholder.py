"""知识库占位命中：按话术条目的标题关键词做包含匹配。

本期只做占位（见 docs/对齐-对话流程与知识库v2.md 第五节）：
命中 → 返回条目正文（answer）；没命中 → 返回 None，由调用方走兜底话术并记
unknown_questions。**不接 LLM 生成**——生成一句看似专业的错话，比说"我确认一下"更糟。

真内容（每个节点 3-5 条话术）等客户给聊天记录，届时只替换本文件的匹配策略，
调用方（flow / api_flow）不用改。
"""

from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models_kb import DEFAULT_TENANT_ID, KbEntry

# 一条话术标题最多能带出多少条：库里会有几百条，全量扫也能接受，但留个上限防跑飞
MAX_ENTRIES = 500

# 标题切词时的分隔符：中文标题里常见「体检 / 住宿」「体检报销吗」这类写法
_SPLIT = re.compile(r"[^\u4e00-\u9fa5A-Za-z0-9]+")

# 太短的词匹配上必然是噪音（「的」「吗」「钱」）
MIN_KEYWORD = 2

_STOPWORDS = {
    "什么", "怎么", "如何", "可以", "能不", "不能", "我们", "你们", "这个", "那个",
    "一个", "是不", "不是", "有没", "没有", "多少", "哪些", "的话",
}


def keywords_of(title: str) -> list[str]:
    """标题 → 关键词。

    中文标题没有空格，整句当关键词就要求客户一字不差地复述，实际命中率极低。
    所以除了整句，再取每个片段的前 2/3 个字：「体检要自己出钱吗」→「体检」，
    客户问「体检花钱吗」也能命中。宁可多答一句，不要答不上来。
    """
    text = (title or "").strip()
    words: list[str] = []
    for part in _SPLIT.split(text):
        if len(part) < MIN_KEYWORD:
            continue
        words.append(part)
        if len(part) > 4:
            words.extend([part[:2], part[:3]])
    if len(text) >= MIN_KEYWORD:
        words.append(text)
    seen: list[str] = []
    for word in words:
        if word not in seen and word not in _STOPWORDS:
            seen.append(word)
    return seen


def match(question: str, title: str) -> bool:
    """客户问法里包含标题的任一关键词就算命中。"""
    text = question or ""
    return any(word in text for word in keywords_of(title))


async def lookup(session: AsyncSession, question: str) -> str | None:
    """查一条话术。命中返回正文，未命中返回 None。"""
    text = (question or "").strip()
    if not text:
        return None
    rows = (
        await session.execute(
            select(KbEntry)
            .where(
                KbEntry.tenant_id == DEFAULT_TENANT_ID,
                KbEntry.kind == "script",
                KbEntry.status == "enabled",
            )
            .order_by(KbEntry.id)
            .limit(MAX_ENTRIES)
        )
    ).scalars().all()
    for entry in rows:
        if not (entry.body or "").strip():
            continue
        if match(text, entry.title):
            return str(entry.body).strip()
    return None


__all__ = ["keywords_of", "lookup", "match"]

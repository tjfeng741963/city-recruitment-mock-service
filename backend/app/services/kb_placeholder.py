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
from .kb_policy import shared_answer_allowed
from .question_topics import is_non_wage_cost_question, is_wage_keyword

# 一条话术标题最多能带出多少条：库里会有几百条，全量扫也能接受，但留个上限防跑飞。
# 2026-11-15：存量已 534 条，原来上限 500 会让最后 34 条永远不参与匹配。
MAX_ENTRIES = 2000

# 标题切词时的分隔符：中文标题里常见「体检 / 住宿」「体检报销吗」这类写法
_SPLIT = re.compile(r"[^\u4e00-\u9fa5A-Za-z0-9]+")

# 太短的词匹配上必然是噪音（「的」「吗」「钱」）
MIN_KEYWORD = 2

_STOPWORDS = {
    "什么", "怎么", "如何", "可以", "能不", "不能", "我们", "你们", "这个", "那个",
    "一个", "是不", "不是", "有没", "没有", "多少", "哪些", "的话",
    # 2026-11-11 模拟实测：条目 #152 标题里带「还有法定节假日…」，
    # 客户问「还有什么岗位」被「还有」误命中。以下连接词/客套词永远不当主题词。
    "还有", "以及", "而且", "但是", "可是", "如果", "或者", "就是", "都是", "也是",
    "直接", "需要", "然后", "这边", "那边", "咱们", "现在", "今天", "明天", "后天",
    "昨天", "属于", "感觉", "比较", "非常", "特别", "之类", "一下", "一直", "一定",
    "全部", "所有", "情况", "后续", "后续有", "大家", "自己", "做的话", "来说",
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


def _matching_words(question: str, title: str) -> list[str]:
    text = question or ""
    expense_question = is_non_wage_cost_question(text)
    return [word for word in keywords_of(title) if word in text and not (
        expense_question and is_wage_keyword(word)
    )]


def match(question: str, title: str) -> bool:
    """按主题关键词匹配；具体费用问题不靠工资/多少钱命中旧话术。"""
    return bool(_matching_words(question, title))


async def lookup_entry(
    session: AsyncSession,
    question: str,
    city: str | None = None,
    factory: str | None = None,
    *,
    require_factory: bool = False,
) -> dict[str, str] | None:
    """查一条话术。命中返回 {id,title,body}，未命中返回 None。

    城市加权（只在本层做，match() 不变）：
    - entry.city 与 city 相同 → 该条总分 +3（同城话术优先）
    - entry.city 非空且 != city → 直接排除（城市不符不许命中）
    - entry.city 为空 → 通配，无加权

    工厂加权（契约 docs/对齐-设备工厂绑定与资料导入.md §2）：
    - entry.factory_name 与 factory 相同 → 总分 +5（本厂话术优先级最高）
      「相同」按双向包含判断（绑定值可能是简称：「松下万宝」⊂ 全称也算同厂）
    - 双方都非空且互不包含 → 直接排除（别家的厂规发给本厂客户是事故）
    - 任一方为空 → 通配，无加权
    - city/factory 都为空 → 全部通配（原行为）

    flow 接口传 require_factory=True：未知工厂时排除具名工厂条目，
    不能把缺少上下文当成允许读取任意厂规。旧调用保持原签名语义。
    """
    text = (question or "").strip()
    if not text:
        return None
    city_hint = (city or "").strip()
    factory_hint = (factory or "").strip()
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
    best: tuple[int, dict[str, str]] | None = None  # (得分, 条目)
    for entry in rows:
        if not (entry.body or "").strip():
            continue
        words = _matching_words(text, entry.title)
        if not words:
            continue
        entry_city = str(getattr(entry, "city", None) or "").strip()
        if entry_city and entry_city != city_hint:
            continue
        entry_factory = str(getattr(entry, "factory_name", None) or "").strip()
        if require_factory and entry_factory and not factory_hint:
            continue
        if require_factory and not entry_factory and not shared_answer_allowed(
            text, str(entry.body or ""), keywords=[str(entry.title or "")],
        ):
            continue
        if (
            entry_factory
            and factory_hint
            and entry_factory not in factory_hint
            and factory_hint not in entry_factory
        ):
            continue
        score = sum(len(w) for w in words)
        if entry_city:
            score += 3
        if entry_factory and factory_hint:
            score += 5
        # 命中总长最长的算最相关：「体检报销吗」输给「体检报销多少钱一个月」
        if best is None or score > best[0]:
            best = (
                score,
                {
                    # 测试夹具可能是裸 Row（无 id 列）→ 用 title 当身份兜底
                    "id": str(getattr(entry, "id", None) or getattr(entry, "title", "") or ""),
                    "title": str(getattr(entry, "title", "") or ""),
                    "body": str(getattr(entry, "body", "") or "").strip(),
                },
            )
    return best[1] if best else None


async def lookup(
    session: AsyncSession,
    question: str,
    city: str | None = None,
    factory: str | None = None,
) -> str | None:
    """兼容旧签名：命中返回正文，未命中返回 None。"""
    hit = await lookup_entry(session, question, city=city, factory=factory)
    return hit["body"] if hit else None


__all__ = ["keywords_of", "lookup", "lookup_entry", "match"]

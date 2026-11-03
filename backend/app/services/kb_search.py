"""三层检索漏斗：SQL 结构化筛选 → 全文匹配 → （预留）向量检索。

为什么顺序不能反过来（docs/知识库与后端技术选型-决策文档.md 5.3 节）：

    用户：「我 52 了还能去吗」

这句话里没有岗位名、厂名、城市。纯向量检索会召回一堆语义相近但不相关的岗位，
且**无法确定性判断"52 岁不符合 18-45"**。而 SQL 一句 `age_max >= 52` 就直接排除。

只有抽出了结构化字段，才能做确定性判断。这是分层检索的真正价值，不是性能。

本阶段（阶段 3 的 3.1）只做前两层。向量层留空——按计划，
要先实测 50 个真实问法的 top-3 召回率，低于 70% 才建向量索引。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import and_, case, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models_kb import DEFAULT_TENANT_ID, KbEntry

# 每个查询最多返回多少条，避免把整库塞进 prompt
DEFAULT_LIMIT = 8

# 第 2 层全文匹配的候选规模上限：超过这个数说明筛选条件太宽，先截断再排序
FULLTEXT_SCAN_LIMIT = 200

_AGE_QUERY_PATTERN = re.compile(r"([0-9]{1,2})\s*[岁]")

# 常见口语里的年龄表达："我52了"、"我今年52了"、"52了还能去吗"
# (?:今年)? 是可选的，"我今?...52" 这种必须整体匹配不上就退到下面那条
_AGE_COLLOQUIAL_PATTERN = re.compile(
    r"(?:我|本人)?\s*(?:今年|年纪|年龄)?\s*([0-9]{1,2})\s*(?:岁|了)"
)


@dataclass(frozen=True)
class SearchQuery:
    """一次检索请求。所有字段都可选，全部为空时退化为"列出可用条目"。"""

    tenant_id: int = DEFAULT_TENANT_ID
    city: str | None = None
    age: int | None = None
    text: str | None = None
    kind: str | None = None
    limit: int = DEFAULT_LIMIT


@dataclass(frozen=True)
class SearchHit:
    """命中结果。tier 记录命中的是哪一层，用于日志回溯。"""

    entry: KbEntry
    tier: str  # "sql" / "fulltext"
    score: float = 1.0


@dataclass(frozen=True)
class SearchResult:
    hits: tuple[SearchHit, ...] = field(default_factory=tuple)
    tiers_used: tuple[str, ...] = field(default_factory=tuple)

    def __len__(self) -> int:
        return len(self.hits)

    @property
    def entries(self) -> tuple[KbEntry, ...]:
        return tuple(h.entry for h in self.hits)


def extract_age_from_query(text: str | None) -> int | None:
    """从用户问法里抽年龄。"我今年52了" / "52岁还能去吗" 都要能认出来。

    抽不出来返回 None——这时不做年龄硬过滤，宁可多召回也不要错杀。
    """
    if not text:
        return None
    m = _AGE_COLLOQUIAL_PATTERN.search(text) or _AGE_QUERY_PATTERN.search(text)
    if not m:
        return None
    age = int(m.group(1))
    return age if 0 <= age <= 150 else None


def _active_conditions(now: datetime | None = None) -> list:
    """条目可被检索的前提：启用中，且没有过期。

    `valid_until` 为空表示长期有效（纯话术类条目通常没有有效期）。
    """
    current = now or datetime.now(timezone.utc)
    return [
        KbEntry.status == "enabled",
        or_(KbEntry.valid_until.is_(None), KbEntry.valid_until > current),
    ]


def _keyword_tokens(text: str) -> list[str]:
    """把问法切成用于 LIKE 的关键词。

    中文没有空格，整句当一个词去 LIKE 不可能命中——实测召回率只有 36%。
    这里退化成**二元组（bigram）**：连续汉字串切成相邻两字组合，
    再补上数字串。

    bigram 的代价是召回变宽（"包吃住"会切出"包吃""吃住"），
    但第 2 层本来就只是候选召回，后面还有相关度排序与 limit 截断。
    比"一个字都匹配不上"好得多。

    将来上 PostgreSQL tsvector + 中文分词时，替换这一个函数即可。
    """
    tokens: list[str] = []
    for run in re.findall(r"[一-鿿]+", text):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    tokens += re.findall(r"[0-9]{2,}", text)

    # 去重保序；bigram 数量天然不多，但整句很长时仍需截断
    seen: set[str] = set()
    result: list[str] = []
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        result.append(token)
    return result[:6]


async def search(
    session: AsyncSession, query: SearchQuery, *, now: datetime | None = None
) -> SearchResult:
    """执行三层漏斗的前两层。"""
    hits: list[SearchHit] = []
    tiers: list[str] = []
    seen_ids: set[int] = set()

    base = [*_active_conditions(now), KbEntry.tenant_id == query.tenant_id]
    if query.kind:
        base.append(KbEntry.kind == query.kind)

    # ── 第 1 层：SQL 结构化筛选 ─────────────────────────────
    sql_filters = list(base)
    if query.city:
        sql_filters.append(KbEntry.city == query.city)

    age = query.age
    if age is not None:
        # 岗位必须容纳这个年龄：age_min <= age <= age_max。
        # 纯话术条目没有年龄字段，不参与年龄硬过滤（用 or_ 放行）。
        sql_filters.append(
            or_(
                and_(
                    KbEntry.age_min.is_not(None),
                    KbEntry.age_max.is_not(None),
                    KbEntry.age_min <= age,
                    KbEntry.age_max >= age,
                ),
                KbEntry.kind == "script",
            )
        )

    # 只有 city / age 这类确定性条件才走第 1 层；纯文本查询直接进第 2 层
    if query.city or age is not None:
        # 岗位优先于话术：客户问"广州 52 岁能去吗"，先要知道有哪个厂能接，
        # 话术是辅助。不排序的话按主键截断，话术会先占满 limit（实测踩到过）。
        stmt = (
            select(KbEntry)
            .where(*sql_filters)
            .order_by(
                case((KbEntry.kind == "job", 0), else_=1),
                KbEntry.id,
            )
            .limit(query.limit)
        )
        rows = (await session.execute(stmt)).scalars().all()
        for row in rows:
            if row.id not in seen_ids:
                seen_ids.add(row.id)
                hits.append(SearchHit(entry=row, tier="sql"))
        tiers.append("sql")

    # ── 第 2 层：全文匹配 ───────────────────────────────────
    if query.text and query.text.strip():
        tokens = _keyword_tokens(query.text)
        if tokens:
            text_filters = list(base)
            if query.city:
                text_filters.append(KbEntry.city == query.city)
            clauses = [
                or_(
                    KbEntry.title.like(f"%{token}%"),
                    KbEntry.search_text.like(f"%{token}%"),
                )
                for token in tokens
            ]
            stmt = (
                select(KbEntry)
                .where(*text_filters, or_(*clauses))
                .limit(FULLTEXT_SCAN_LIMIT)
            )
            rows = (await session.execute(stmt)).scalars().all()
            tiers.append("fulltext")
            for row in rows:
                if row.id in seen_ids or len(hits) >= query.limit:
                    continue
                seen_ids.add(row.id)
                hits.append(
                    SearchHit(entry=row, tier="fulltext", score=_relevance(row, tokens))
                )

    return SearchResult(hits=tuple(hits[: query.limit]), tiers_used=tuple(tiers))


def _relevance(entry: KbEntry, tokens: list[str]) -> float:
    """粗糙但可解释的相关度：命中词越多、标题命中权重越高，得分越高。"""
    haystack_title = entry.title or ""
    haystack_body = entry.search_text or ""
    score = 0.0
    for token in tokens:
        if token in haystack_title:
            score += 2.0
        if token in haystack_body:
            score += 1.0
    return score

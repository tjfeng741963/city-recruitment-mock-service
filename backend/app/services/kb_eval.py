"""检索召回率实测：真实问法 → top-3 命中率。

这是计划里明确的**决策点**（docs/知识库与后端技术选型-决策文档.md 4.4 节）：

    top-3 召回率 ≥ 70% → 不建向量层，前两层够了
    < 70%           → 才需要 pgvector

没有这份实测，向量层就是拍脑袋加的——多一个索引、多一次 embedding 调用、
多一份运维负担，而它解决的问题可能根本不存在。

问法全部按劳务派遣的真实口语写（"我52了还能去吗"），不是把标题改个问号。
评测集落在 `backend/tests/data/kb_questions.json`，可以随业务补充。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from .kb_search import SearchQuery, extract_age_from_query, search

DEFAULT_TOP_K = 3
PASS_THRESHOLD = 0.70


@dataclass(frozen=True)
class EvalCase:
    """一条评测样本。expected 里给出任意一个命中即算对。"""

    question: str
    expected_keywords: tuple[str, ...]
    city: str | None = None


@dataclass
class EvalResult:
    total: int = 0
    hits: int = 0
    misses: list[dict] = field(default_factory=list)

    @property
    def recall(self) -> float:
        return self.hits / self.total if self.total else 0.0

    @property
    def passes(self) -> bool:
        return self.recall >= PASS_THRESHOLD

    def as_dict(self) -> dict:
        return {
            "total": self.total,
            "hits": self.hits,
            "recall": round(self.recall, 4),
            "threshold": PASS_THRESHOLD,
            "passes": self.passes,
            "recommendation": (
                "前两层已达标，暂不建向量层"
                if self.passes
                else "低于阈值，需要上 pgvector 向量层"
            ),
            "misses": self.misses,
        }


def load_cases(path: str | Path) -> list[EvalCase]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return [
        EvalCase(
            question=item["question"],
            expected_keywords=tuple(item["expected_keywords"]),
            city=item.get("city"),
        )
        for item in raw
    ]


async def evaluate(
    session: AsyncSession, cases: list[EvalCase], *, top_k: int = DEFAULT_TOP_K
) -> EvalResult:
    """逐条跑检索，统计 top-k 内是否出现期望关键词。"""
    result = EvalResult(total=len(cases))

    for case in cases:
        query = SearchQuery(
            city=case.city,
            age=extract_age_from_query(case.question),
            text=case.question,
            limit=top_k,
        )
        found = await search(session, query)

        titles = [(h.entry.title or "") + "\n" + (h.entry.body or "") for h in found.hits]
        matched = any(
            keyword in text for keyword in case.expected_keywords for text in titles
        )

        if matched:
            result.hits += 1
        else:
            result.misses.append(
                {
                    "question": case.question,
                    "expected": list(case.expected_keywords),
                    "got": [h.entry.title for h in found.hits],
                    "tiers": list(found.tiers_used),
                }
            )

    return result


async def _main(argv: list[str] | None = None) -> int:
    import argparse

    from ..db import SessionLocal, init_db

    parser = argparse.ArgumentParser(description="知识库检索召回率实测")
    parser.add_argument(
        "--cases",
        default=str(Path(__file__).resolve().parents[2] / "tests" / "data" / "kb_questions.json"),
        help="评测集 JSON 路径",
    )
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--report", default=None, help="结果输出路径（JSON）")
    args = parser.parse_args(argv)

    cases = load_cases(args.cases)
    await init_db()
    async with SessionLocal() as session:
        result = await evaluate(session, cases, top_k=args.top_k)

    text = json.dumps(result.as_dict(), ensure_ascii=False, indent=2)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
        print(f"报告已写入 {args.report}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))

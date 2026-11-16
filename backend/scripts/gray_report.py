"""灰度复盘：把 flow_events 还原成「客户说了什么 → 我们回了什么 → 为什么这么回」。

跑法（在 ``backend/`` 下）::

    uv run python -m scripts.gray_report                 # 最近 24 小时
    uv run python -m scripts.gray_report --since 2026-11-16T00:00
    uv run python -m scripts.gray_report --csv out.csv   # 给运营/测试看的表格
    uv run python -m scripts.gray_report --suspects      # 只看可疑回复

三条约束，改之前先看：

1. **只读**。这个脚本绝不写库——灰度期间任何写入都可能影响线上会话。
2. **按 session_key + seq 排序还原顺序**。会话流是追加的，seq 在同一会话内单调，
   跨会话之间没有可比性，所以必须分组再排。
3. **「可疑」是启发式，不是结论**。命中只代表值得人工看一眼，不能直接当 bug。

``trace`` 字段是 2026-11-15 才加上的。之前的回复没有 trace，脚本对老数据要能降级
显示，不能因为缺字段就整行报错。
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from app.db import SessionLocal
from app.models_flow import FlowEvent

# 这些来源说明「回复内容是代码或知识库给的」，不是模型自由发挥。
# 灰度里模型胡说八道是主要风险，所以先看 source 为空串的那些。
_CODE_SOURCES = {"script", "card", "fact", "collect", "kb", "closing"}

# 兜底话术：出现即说明这一轮降级了（模型失败/审核用尽/回声拦截）。
_FALLBACK_MARKERS = (
    "这个我确认一下，稍后回你",
    "这个问题刚才已经回复过你啦",
    "我在的，你想了解哪方面？",
)


def _body(event: FlowEvent) -> dict[str, Any]:
    try:
        parsed = json.loads(event.body or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _suspect_reasons(reply: dict[str, Any]) -> list[str]:
    """这条回复为什么值得人工看一眼。返回空列表 = 没发现异常。"""
    reasons: list[str] = []
    trace = reply.get("trace") or {}
    text = str(reply.get("text") or "")

    # 老数据没有 trace：只有文本，能查的有限，如实标注。
    if not trace:
        reasons.append("无诊断字段（trace 上线前的数据）")
        return reasons

    if any(marker in text for marker in _FALLBACK_MARKERS):
        reasons.append("走了兜底话术")

    if trace.get("echo_guarded"):
        reasons.append("模型复读客户原话，被回声防护换掉")

    review = trace.get("review") or []
    if any(
        isinstance(item, dict) and item.get("stage") == "rewrite_blocked_by_fact_guard"
        for item in review
    ):
        reasons.append("重写稿编了工价，被事实护栏拦下")
    if any(isinstance(item, dict) and item.get("stage") == "forced_fallback" for item in review):
        reasons.append("审核两轮未过，强制兜底")
    if any(isinstance(item, dict) and item.get("stage") == "no_reviewer" for item in review):
        reasons.append("审核器不在，未过审")

    source = str(trace.get("source") or "")
    if source and source not in _CODE_SOURCES:
        reasons.append(f"未知来源 {source}")
    if not source:
        reasons.append("来源为空（模型自由发挥）")

    status = str(trace.get("recruit_status") or "")
    if status == "disqualified":
        reasons.append("已标记不合适")

    # 模型调用层面的可疑：灰度里最关键的一类证据。
    # 「没调模型」和「调了但失败」是两种完全不同的 bug，必须分开报。
    llm = trace.get("llm")
    if isinstance(llm, list):
        if not llm:
            reasons.append("本轮未调用模型（代码渲染/确定性兜底）")
        else:
            failed = [call for call in llm if isinstance(call, dict) and not call.get("ok")]
            if failed:
                error = str(failed[0].get("error") or "")[:120]
                reasons.append(f"模型调用失败 {len(failed)}/{len(llm)} 次：{error}")
            slow = [
                call
                for call in llm
                if isinstance(call, dict) and int(call.get("ms") or 0) > 10_000
            ]
            if slow:
                reasons.append(f"模型响应慢：{slow[0].get('ms')}ms")
    return reasons


async def collect(since: datetime) -> list[dict[str, Any]]:
    """按会话还原成时间线。返回每个会话的有序事件列表。"""
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(FlowEvent)
                .where(FlowEvent.created_at >= since)
                .order_by(FlowEvent.session_key, FlowEvent.seq)
            )
        ).scalars().all()

    grouped: dict[str, list[FlowEvent]] = defaultdict(list)
    for row in rows:
        grouped[row.session_key].append(row)

    sessions: list[dict[str, Any]] = []
    for key, events in grouped.items():
        timeline: list[dict[str, Any]] = []
        for event in events:
            body = _body(event)
            item: dict[str, Any] = {
                "seq": event.seq,
                "type": event.type,
                "at": event.created_at.isoformat(sep=" ", timespec="seconds")
                if event.created_at
                else "",
            }
            if event.type == "inbound":
                item["text"] = str(body.get("text") or "")
            elif event.type == "reply":
                item["text"] = str(body.get("text") or "")
                item["parts"] = body.get("parts") or []
                item["trace"] = body.get("trace") or {}
                item["suspects"] = _suspect_reasons(body)
            elif event.type == "stage_change":
                item["text"] = f"{body.get('from', '')} → {body.get('to', '')}"
            elif event.type == "slot_set":
                item["text"] = f"{body.get('key', '')} = {body.get('value', '')}"
            elif event.type == "action":
                item["text"] = str(body.get("name") or "")
            elif event.type == "kb_hit":
                item["text"] = f"KB {body.get('id', '')}"
            timeline.append(item)
        sessions.append({"session_key": key, "events": timeline})
    return sessions


def summarize(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    """灰度看板需要的数字：来源分布、审核动作、可疑条数。"""
    sources: dict[str, int] = defaultdict(int)
    reviews: dict[str, int] = defaultdict(int)
    replies = 0
    suspects = 0
    for session in sessions:
        for event in session["events"]:
            if event["type"] != "reply":
                continue
            replies += 1
            trace = event.get("trace") or {}
            sources[str(trace.get("source") or "(空)")] += 1
            for item in trace.get("review") or []:
                if isinstance(item, dict):
                    key = str(item.get("stage") or item.get("verdict") or "?")
                    reviews[key] += 1
            if event.get("suspects"):
                suspects += 1
    return {
        "sessions": len(sessions),
        "replies": replies,
        "suspects": suspects,
        "sources": dict(sorted(sources.items(), key=lambda kv: -kv[1])),
        "review": dict(sorted(reviews.items(), key=lambda kv: -kv[1])),
    }


def print_timeline(sessions: list[dict[str, Any]], only_suspects: bool) -> None:
    for session in sessions:
        lines: list[str] = []
        for event in session["events"]:
            if event["type"] not in ("inbound", "reply"):
                continue
            if only_suspects and not event.get("suspects"):
                continue
            who = "客户" if event["type"] == "inbound" else "我们"
            lines.append(f"  [{event['at']}] {who}: {event['text']}")
            if event["type"] == "reply" and event.get("suspects"):
                for reason in event["suspects"]:
                    # 不能用 ⚠ 这类符号：Windows 控制台是 GBK，一 print 就 UnicodeEncodeError。
                    lines.append(f"      [可疑] {reason}")
                trace = event.get("trace") or {}
                if trace:
                    lines.append(
                        "      >>> source={} stage={}->{} kb={}".format(
                            trace.get("source") or "(空)",
                            trace.get("stage_from") or "",
                            trace.get("stage_to") or "",
                            trace.get("kb_entry_id") or "-",
                        )
                    )
                    llm = trace.get("llm")
                    if isinstance(llm, list):
                        if not llm:
                            lines.append("      >>> 模型：本轮未调用")
                        for index, call in enumerate(llm, start=1):
                            if not isinstance(call, dict):
                                continue
                            tokens = call.get("tokens") or {}
                            lines.append(
                                "      >>> 模型#{} {} ok={} {}ms tokens={} 尝试{}次{}".format(
                                    index,
                                    call.get("model") or "?",
                                    call.get("ok"),
                                    call.get("ms"),
                                    tokens.get("total_tokens", "-"),
                                    call.get("attempts"),
                                    f" 错误：{str(call.get('error'))[:80]}"
                                    if call.get("error")
                                    else "",
                                )
                            )
        if lines:
            print(f"── 会话 {session['session_key']} ──")
            print("\n".join(lines))
            print()


def write_csv(sessions: list[dict[str, Any]], path: str) -> int:
    """一行一条回复，给测试员/运营在 Excel 里标「错在哪」。"""
    rows = 0
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "会话", "时间", "客户原话", "我们回的", "来源",
                "阶段变化", "知识库条目", "可疑原因",
                "模型调用次数", "模型", "耗时ms", "token", "模型失败原因",
                "人工判定", "应为",
            ]
        )
        for session in sessions:
            pending = ""
            for event in session["events"]:
                if event["type"] == "inbound":
                    pending = event["text"]
                    continue
                if event["type"] != "reply":
                    continue
                trace = event.get("trace") or {}
                llm = trace.get("llm") if isinstance(trace.get("llm"), list) else []
                calls = [call for call in llm if isinstance(call, dict)]
                models = ",".join(str(call.get("model") or "?") for call in calls)
                total_ms = sum(int(call.get("ms") or 0) for call in calls)
                tokens = sum(
                    int((call.get("tokens") or {}).get("total_tokens") or 0) for call in calls
                )
                errors = "；".join(
                    str(call.get("error"))[:120] for call in calls if call.get("error")
                )
                writer.writerow(
                    [
                        session["session_key"],
                        event["at"],
                        pending,
                        event["text"],
                        trace.get("source") or "(空)",
                        f"{trace.get('stage_from') or ''}→{trace.get('stage_to') or ''}",
                        trace.get("kb_entry_id") or "",
                        "；".join(event.get("suspects") or []),
                        len(calls),          # 0 = 本轮一次模型都没调
                        models,
                        total_ms,
                        tokens,
                        errors,
                        "",  # 人工判定：对 / 错 / 词不达意
                        "",  # 应为
                    ]
                )
                rows += 1
                pending = ""
    return rows


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="灰度复盘：会话流还原 + 可疑回复筛查")
    parser.add_argument("--hours", type=int, default=24, help="统计最近多少小时（默认 24）")
    parser.add_argument("--since", help="起始时间，格式 YYYY-MM-DDTHH:MM（优先于 --hours）")
    parser.add_argument("--csv", help="把每条回复导出成 CSV，供人工标注")
    parser.add_argument("--suspects", action="store_true", help="只打印可疑回复")
    parser.add_argument("--json", action="store_true", help="输出汇总 JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%dT%H:%M")
        except ValueError:
            print(f"起始时间格式不对：{args.since!r}，应为 YYYY-MM-DDTHH:MM", file=sys.stderr)
            return 2
    else:
        since = datetime.now(timezone.utc) - timedelta(hours=max(1, args.hours))
    # 库里存的是 naive UTC，查询条件也必须 naive，否则边界会漂 8 小时。
    since_naive = since.replace(tzinfo=None) if since.tzinfo else since

    sessions = asyncio.run(collect(since_naive))
    stats = summarize(sessions)

    if args.csv:
        written = write_csv(sessions, args.csv)
        print(f"已导出 {written} 条回复到 {args.csv}", file=sys.stderr)

    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 0

    print(f"时间范围：{since_naive.isoformat(sep=' ', timespec='minutes')} 起")
    print(f"会话 {stats['sessions']} 个 / 回复 {stats['replies']} 条 / 可疑 {stats['suspects']} 条")
    print("来源分布：" + "，".join(f"{k} {v}" for k, v in stats["sources"].items()))
    if stats["review"]:
        print("审核动作：" + "，".join(f"{k} {v}" for k, v in stats["review"].items()))
    print()
    print_timeline(sessions, only_suspects=args.suspects)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

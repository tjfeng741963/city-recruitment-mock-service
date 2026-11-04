"""城市招聘日报：给老板看的每日数字。

跑法（在 ``backend/`` 下）::

    uv run python -m scripts.daily_report
    uv run python -m scripts.daily_report --date 2026-11-04
    uv run python -m scripts.daily_report --days 7
    uv run python -m scripts.daily_report --json

三条硬约束，改这个文件前先看：

1. **切日一律按东八区**。库里存的是 naive UTC，直接按 UTC 切会把本地 0–8 点的单
   算到前一天。换算只在边界发生，查询条件仍是 naive UTC。
2. **口径与 ``app/api_lead.py::stats`` 完全一致**，不另造一套：
   「约面」= ``LeadEvent.event_type='scheduled'`` 的流水条数；
   「到面 / 爽约」= ``LeadEvent.to_stage`` 命中 ``interviewed`` / ``no_show`` 的条数。
   同一份数据两种算法，迟早会对不上，届时没人知道该信哪个。
3. **分母为 0 时比率输出 ``-``**。0.0% 会被读成"来了但一个都没到"，
   而事实是"还没开始约"，这两件事对老板的决策完全不同。

``--json`` 的结构与终端板块一一对应（``leads`` / ``sessions`` / ``device`` /
``switches``），比率未定义时给 ``null`` 而不是 0，理由同上。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import unicodedata
from collections.abc import Sequence
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import Conversation, Device, Message
from app.models_lead import Lead, LeadEvent
from app.services import lead_guard

# 业务时区。与 models_lead.LOCAL_TZ 同一个值，这里再定义一次是为了脚本能独立被导入。
LOCAL_TZ = timezone(timedelta(hours=8))

# 心跳超过这个秒数就算失联，与 workers/device_watch.py 的判定保持一致。
OFFLINE_AFTER_SECONDS = 90


# ─────────────────────────── 时间 ───────────────────────────
def _naive_utc(dt: datetime) -> datetime:
    """转成 naive UTC（库里的存法）。naive 入参按 UTC 理解。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _local_date(dt: datetime) -> date:
    """某一时刻对应的东八区日期。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ).date()


def day_bounds(day: date) -> tuple[datetime, datetime]:
    """东八区某一天的 ``[起, 止)``，两端都换成 naive UTC 供查询用。"""
    start_local = datetime.combine(day, time.min, tzinfo=LOCAL_TZ)
    end_local = start_local + timedelta(days=1)
    return _naive_utc(start_local), _naive_utc(end_local)


def _iso_local(dt: datetime | None) -> str | None:
    """库里 naive UTC → 带 +08:00 的 ISO 字符串。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ).isoformat(timespec="seconds")


# ─────────────────────────── 取数 ───────────────────────────
def _rate(numerator: int, denominator: int) -> float | None:
    """比率四舍五入到三位；分母为 0 返回 None（终端显示 ``-``）。"""
    return round(numerator / denominator, 3) if denominator else None


async def _scalar(session: AsyncSession, stmt) -> int:  # noqa: ANN001
    return int((await session.execute(stmt)).scalar_one() or 0)


async def _events_in_day(session: AsyncSession, start: datetime, end: datetime, **where) -> int:
    """某天落在窗口内的 LeadEvent 条数，附带的字段条件是等值匹配。"""
    stmt = (
        select(func.count())
        .select_from(LeadEvent)
        .where(LeadEvent.at >= start, LeadEvent.at < end)
    )
    for key, value in where.items():
        stmt = stmt.where(getattr(LeadEvent, key) == value)
    return await _scalar(session, stmt)


async def _funnel(session: AsyncSession) -> dict[str, Any]:
    """累计漏斗。分母固定取「累计约面」，与 stats 接口一致。"""
    booked = await _scalar(
        session,
        select(func.count()).select_from(LeadEvent).where(LeadEvent.event_type == "scheduled"),
    )
    interviewed = await _scalar(
        session,
        select(func.count())
        .select_from(LeadEvent)
        .where(LeadEvent.to_stage == "interviewed"),
    )
    no_show = await _scalar(
        session,
        select(func.count()).select_from(LeadEvent).where(LeadEvent.to_stage == "no_show"),
    )
    return {
        "booked": booked,
        "interviewed": interviewed,
        "no_show": no_show,
        "interview_rate": _rate(interviewed, booked),
        "no_show_rate": _rate(no_show, booked),
    }


async def _sessions(session: AsyncSession, start: datetime, end: datetime) -> dict[str, int]:
    total = await _scalar(session, select(func.count()).select_from(Conversation))

    active = await _scalar(
        session,
        select(func.count(func.distinct(Message.conversation_id))).where(
            Message.created_at >= start, Message.created_at < end
        ),
    )
    inbound = await _scalar(
        session,
        select(func.count())
        .select_from(Message)
        .where(
            Message.direction == "inbound",
            Message.created_at >= start,
            Message.created_at < end,
        ),
    )

    # 「未回复」= 会话最后一条消息是客户发的。用 max(id) 找最后一条：
    # messages 只追加，id 单调递增，比按 created_at 排序更稳（同一秒多条时不会并列）。
    last_ids = select(func.max(Message.id)).group_by(Message.conversation_id)
    unreplied = await _scalar(
        session,
        select(func.count())
        .select_from(Message)
        .where(Message.id.in_(last_ids), Message.direction == "inbound"),
    )

    return {
        "total": total,
        "active_today": active,
        "inbound_today": inbound,
        "unreplied": unreplied,
    }


async def _device(session: AsyncSession, now_naive: datetime) -> dict[str, Any] | None:
    """单机阶段只认第一条设备，与 ``api_lead_board`` 的取法一致。"""
    dev = (
        await session.execute(select(Device).order_by(Device.id.asc()).limit(1))
    ).scalar_one_or_none()
    if dev is None:
        return None

    age = None
    if dev.last_heartbeat_at is not None:
        age = max(0, int((now_naive - _naive_utc(dev.last_heartbeat_at)).total_seconds()))

    return {
        "device_code": dev.device_code,
        "status": dev.status,
        "wecom_state": dev.wecom_state,
        "last_heartbeat_at": _iso_local(dev.last_heartbeat_at),
        "age_seconds": age,
    }


def _switches() -> dict[str, Any]:
    """两个急停开关的当前状态。存在开关文件即关闭，每次调用都重新 stat。"""
    state = lead_guard.status()
    return {
        "extract": {
            "enabled": state["extract"]["enabled"],
            "reason": state["extract"]["reason"],
        },
        "sweep": {"enabled": state["sweep"]["enabled"], "reason": state["sweep"]["reason"]},
    }


async def _collect_day(
    session: AsyncSession,
    day: date,
    start: datetime,
    end: datetime,
    now_naive: datetime,
) -> dict[str, Any]:
    leads = {
        "new": await _scalar(
            session,
            select(func.count())
            .select_from(Lead)
            .where(Lead.created_at >= start, Lead.created_at < end),
        ),
        "scheduled": await _events_in_day(session, start, end, event_type="scheduled"),
        "interviewed": await _events_in_day(session, start, end, to_stage="interviewed"),
        "no_show": await _events_in_day(session, start, end, to_stage="no_show"),
        # 待核实是「此刻还挂着多少」，不是某天的流水，所以不带日期条件
        "pending_confirm": await _scalar(
            session,
            select(func.count()).select_from(Lead).where(Lead.pending_confirm.is_(True)),
        ),
        "funnel": await _funnel(session),
    }

    return {
        "date": day.isoformat(),
        "leads": leads,
        "sessions": await _sessions(session, start, end),
        "device": await _device(session, now_naive),
        "switches": _switches(),
    }


async def collect_day(day: date, now: datetime | None = None) -> dict[str, Any]:
    """单日报表。``now`` 只影响心跳时长，日期边界由 ``day`` 决定。"""
    ref = now or datetime.now(timezone.utc)
    start, end = day_bounds(day)
    async with SessionLocal() as session:
        return await _collect_day(session, day, start, end, _naive_utc(ref))


async def collect_range(
    end_day: date, days: int, now: datetime | None = None
) -> dict[str, Any]:
    """最近 ``days`` 天（含 ``end_day``）的逐日数据 + 合计。"""
    ref = now or datetime.now(timezone.utc)
    now_naive = _naive_utc(ref)
    day_list = [end_day - timedelta(days=offset) for offset in range(days - 1, -1, -1)]

    async with SessionLocal() as session:
        rows = []
        for day in day_list:
            start, end = day_bounds(day)
            rows.append(await _collect_day(session, day, start, end, now_naive))

    if not rows:  # days < 1 已被参数校验拦住，这里只是兜底
        empty = await collect_day(end_day, now=ref)
        return {**empty, "mode": "range", "days": []}

    last = rows[-1]
    totals = {
        key: sum(row["leads"][key] for row in rows)
        for key in ("new", "scheduled", "interviewed", "no_show")
    }
    return {
        "mode": "range",
        "start": rows[0]["date"],
        "end": rows[-1]["date"],
        "days": rows,
        "leads": {
            **totals,
            "pending_confirm": last["leads"]["pending_confirm"],
            "funnel": last["leads"]["funnel"],
        },
        # 期内合计：active_today / inbound_today 是 N 天的和，不是某一天的快照
        "sessions": {
            "total": last["sessions"]["total"],
            "active_today": sum(row["sessions"]["active_today"] for row in rows),
            "inbound_today": sum(row["sessions"]["inbound_today"] for row in rows),
            "unreplied": last["sessions"]["unreplied"],
        },
        "device": last["device"],
        "switches": last["switches"],
    }


# ─────────────────────────── 终端渲染 ───────────────────────────
def _width(text: str) -> int:
    """显示宽度：中文/全角算 2，其余算 1。对齐表格用，不追求完美。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(text))


def _ljust(text: str, width: int) -> str:
    return str(text) + " " * max(0, width - _width(text))


def _rjust(text: str, width: int) -> str:
    return " " * max(0, width - _width(text)) + str(text)


def _kv(label: str, value: Any, width: int = 18) -> str:
    return "  " + _ljust(label, width) + str(value)


def _pct(rate: float | None) -> str:
    """比率显示。未定义（分母为 0）一律 ``-``，不写 0.0%。"""
    return "-" if rate is None else f"{rate * 100:.1f}%"


def _age_text(seconds: int | None) -> str:
    if seconds is None:
        return "无心跳记录"
    if seconds < 60:
        return f"{seconds} 秒前"
    if seconds < 3600:
        return f"{seconds // 60} 分钟前"
    return f"{seconds // 3600} 小时前"


def _switch_text(item: dict[str, Any]) -> str:
    if item["enabled"]:
        return "开启"
    return f"关闭（{item['reason']}）"


def _render_blocks(report: dict[str, Any], today_label: str) -> list[str]:
    """漏斗 / 会话 / 采集端 / 开关，四块单日与多日共用。"""
    funnel = report["leads"]["funnel"]
    sessions = report["sessions"]
    device = report["device"]
    switches = report["switches"]

    lines = [
        "【漏斗（累计）】",
        f"  已约面 {funnel['booked']}   已到面 {funnel['interviewed']}   "
        f"爽约 {funnel['no_show']}",
        f"  到面率 {_pct(funnel['interview_rate'])}   "
        f"爽约率 {_pct(funnel['no_show_rate'])}",
        "【会话】",
        f"  总会话 {sessions['total']}   {today_label}有消息 {sessions['active_today']}   "
        f"{today_label}入站消息 {sessions['inbound_today']}",
        f"  未回复（最后一条是客户） {sessions['unreplied']}",
        "【采集端】",
    ]

    if device is None:
        lines.append("  无设备注册")
    else:
        lines.append(
            f"  {device['device_code']}   {device['status']} / {device['wecom_state']}   "
            f"最后心跳 {_age_text(device['age_seconds'])}"
        )

    lines += [
        "【开关】",
        f"  线索抽取：{_switch_text(switches['extract'])}   "
        f"扫描：{_switch_text(switches['sweep'])}",
    ]
    return lines


def render_text(report: dict[str, Any]) -> str:
    """终端表格。单日与多日共用 ``render_text``，由 ``mode`` 区分。"""
    if report.get("mode") == "range":
        return _render_range(report)

    leads = report["leads"]
    lines = [
        f"===== 城市招聘日报 {report['date']} =====",
        "【线索】",
        _kv("今日新线索", leads["new"]),
        _kv("今日约面", leads["scheduled"]),
        _kv("今日到面", leads["interviewed"]),
        _kv("今日爽约", leads["no_show"]),
        _kv("待核实", leads["pending_confirm"]),
    ]
    lines += _render_blocks(report, "今日")
    return "\n".join(lines)


def _render_range(report: dict[str, Any]) -> str:
    days = report["days"]
    width = 14
    header = (
        "  "
        + _ljust("日期", width)
        + _rjust("新线索", 8)
        + _rjust("约面", 6)
        + _rjust("到面", 6)
        + _rjust("爽约", 6)
        + _rjust("入站", 6)
    )
    lines = [
        f"===== 城市招聘日报 {report['start']} ~ {report['end']}"
        f"（{len(days)} 天）=====",
        "【逐日】",
        header,
    ]
    for row in days:
        lines.append(
            "  "
            + _ljust(row["date"], width)
            + _rjust(row["leads"]["new"], 8)
            + _rjust(row["leads"]["scheduled"], 6)
            + _rjust(row["leads"]["interviewed"], 6)
            + _rjust(row["leads"]["no_show"], 6)
            + _rjust(row["sessions"]["inbound_today"], 6)
        )

    leads = report["leads"]
    lines.append(
        "  "
        + _ljust("合计", width)
        + _rjust(leads["new"], 8)
        + _rjust(leads["scheduled"], 6)
        + _rjust(leads["interviewed"], 6)
        + _rjust(leads["no_show"], 6)
        + _rjust(report["sessions"]["inbound_today"], 6)
    )

    lines += [
        "【线索（合计）】",
        _kv("合计新线索", leads["new"]),
        _kv("合计约面", leads["scheduled"]),
        _kv("合计到面", leads["interviewed"]),
        _kv("合计爽约", leads["no_show"]),
        _kv("待核实（当前）", leads["pending_confirm"]),
    ]
    lines += _render_blocks(report, "期内")
    return "\n".join(lines)


# ─────────────────────────── 入口 ───────────────────────────
def _parse_date(raw: str | None) -> date:
    if not raw:
        return _local_date(datetime.now(timezone.utc))
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:  # 交给 argparse 报错，退出码 2
        raise argparse.ArgumentTypeError(f"日期格式应为 YYYY-MM-DD：{raw!r}") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="daily_report", description="城市招聘日报（东八区切日）"
    )
    parser.add_argument("--date", default=None, help="报告日期，格式 YYYY-MM-DD，默认今天")
    parser.add_argument(
        "--days", type=int, default=None, help="汇总最近 N 天（含 --date 当天），输出逐日表 + 合计"
    )
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        day = _parse_date(args.date)
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))

    if args.days is not None and args.days < 1:
        parser.error("--days 必须 >= 1")

    if args.days is None:
        report = asyncio.run(collect_day(day))
    else:
        report = asyncio.run(collect_range(day, args.days))

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())

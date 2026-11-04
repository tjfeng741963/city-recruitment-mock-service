"""约面精度的归一与待核实时刻的计算。

核心是两条：模型说不清钟点时必须按「天」处理（不采信它编的 09:00），
以及 nocturnal 的提醒要顺延到白天，半夜没人处理待办。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.models_lead import compute_check_at, ensure_lead_columns
from app.services.lead_extract import normalize

LOCAL = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 4, 10, 0, tzinfo=LOCAL)


# ─────────────────────── 归一 ───────────────────────
def test_day_precision_ignores_model_clock() -> None:
    """模型吐了 09:00，但标的是 day —— 一律归一到本地当天 00:00。"""
    rec, why = normalize(
        {
            "stage": "booked",
            "confidence": 0.9,
            "interview_at": "2026-11-05T09:00:00+08:00",
            "interview_precision": "day",
        },
        "intent",
        now=NOW,
    )
    assert why == ""
    assert rec["stage"] == "booked"
    # 本地 2026-11-05 00:00 = UTC 2026-11-04 16:00
    assert rec["interview_at"] == datetime(2026, 11, 4, 16, 0)
    assert rec["interview_precision"] == "day"

    check = compute_check_at(rec["interview_at"], rec["interview_precision"])
    # 本地 18:00 = UTC 10:00
    assert check == datetime(2026, 11, 5, 10, 0)


def test_missing_precision_defaults_to_day() -> None:
    """模型忘了给精度 —— 按最保守的 day 处理，时间同样归一。"""
    rec, _ = normalize(
        {
            "stage": "booked",
            "confidence": 0.9,
            "interview_at": "2026-11-05T15:30:00+08:00",
        },
        "intent",
        now=NOW,
    )
    assert rec["interview_precision"] == "day"
    assert rec["interview_at"] == datetime(2026, 11, 4, 16, 0)


def test_minute_precision_check_at_plus_three_hours() -> None:
    """知道钟点：约 09:00，+3 小时 = 本地 12:00 提醒。"""
    rec, _ = normalize(
        {
            "stage": "booked",
            "confidence": 0.9,
            "interview_at": "2026-11-05T09:00:00+08:00",
            "interview_precision": "minute",
        },
        "intent",
        now=NOW,
    )
    assert rec["interview_precision"] == "minute"
    assert rec["interview_at"] == datetime(2026, 11, 5, 1, 0)  # 01:00 UTC

    check = compute_check_at(rec["interview_at"], rec["interview_precision"])
    assert check == datetime(2026, 11, 5, 4, 0)  # 12:00 本地


def test_minute_precision_night_pushed_to_next_morning() -> None:
    """约 20:00，+3h 落到 23:00 —— 顺延到次日 09:00。"""
    interview_at = datetime(2026, 11, 5, 20, 0, tzinfo=LOCAL)
    check = compute_check_at(interview_at, "minute")
    # 次日 09:00 本地 = 次日 01:00 UTC
    assert check == datetime(2026, 11, 6, 1, 0)


def test_minute_precision_early_morning_pushed_to_nine() -> None:
    """凌晨 04:30，+3h 是 07:30，仍在夜间窗口内 —— 顺延到当天 09:00。"""
    interview_at = datetime(2026, 11, 5, 4, 30, tzinfo=LOCAL)
    check = compute_check_at(interview_at, "minute")
    assert check == datetime(2026, 11, 5, 1, 0)  # 本地 09:00


def test_no_interview_time_means_no_check() -> None:
    assert compute_check_at(None, "minute") is None
    assert compute_check_at(None, "day") is None

    rec, _ = normalize(
        {"stage": "booked", "confidence": 0.9, "interview_at": None},
        "intent",
        now=NOW,
    )
    # booked 没时间会降级成 intent，自然也没有待核实时刻
    assert rec["stage"] == "intent"
    assert compute_check_at(rec["interview_at"], rec["interview_precision"]) is None


# ─────────────────────── 存量库补列 ───────────────────────
@pytest.mark.asyncio
async def test_ensure_lead_columns_idempotent(tmp_path) -> None:
    db_path = (tmp_path / "legacy.db").as_posix()
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "CREATE TABLE leads ("
                    " id INTEGER PRIMARY KEY,"
                    " conversation_id INTEGER,"
                    " stage VARCHAR(24),"
                    " interview_at DATETIME)"
                )
            )
            await conn.execute(
                text("INSERT INTO leads (id, conversation_id, stage) VALUES (1, 1, 'booked')")
            )

            added = await ensure_lead_columns(conn)
            assert added == ["interview_precision", "check_at", "alerted_at"]

            # 第二次调用什么都不该做
            assert await ensure_lead_columns(conn) == []

            row = (
                await conn.execute(
                    text("SELECT interview_precision, check_at, alerted_at FROM leads WHERE id = 1")
                )
            ).one()
            # 精度回填 'day'；两个时刻绝不回填，否则上线瞬间全量历史 booked 同时触发
            assert row[0] == "day"
            assert row[1] is None
            assert row[2] is None

            columns = await conn.run_sync(
                lambda sync_conn: [c["name"] for c in inspect(sync_conn).get_columns("leads")]
            )
            assert {"interview_precision", "check_at", "alerted_at"} <= set(columns)

            index_names = [
                r[0]
                for r in (
                    await conn.execute(
                        text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='leads'")
                    )
                ).all()
            ]
            assert "ix_leads_check_at" in index_names
    finally:
        await engine.dispose()

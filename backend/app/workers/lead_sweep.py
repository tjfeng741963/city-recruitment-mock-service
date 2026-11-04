"""待核实扫描 worker：约面到点后，把线索标成「待核实」，等人工确认到面还是爽约。

P0 的边界（评审已定，不要在实现里越界）：

- **只出待办提醒，绝不向客户发消息**。用公司账号主动给客户发"你今天来不来"，
  实测发两条就被退回登录页，风控这条线不能碰；
- 所以本模块不 import 任何发送/投递代码，不写 ``deliveries``，不改 ``stage``。
  需要发消息是另一个产品决策，不是这里顺手补一下的事。

并发安全靠那条带条件的 UPDATE：``WHERE stage='booked' AND pending_confirm=0``，
只有真正把状态从 0 改成 1 的那次 rowcount 是 1，多开进程也不会重复提醒。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select, update

from ..db import SessionLocal
from ..models_lead import STAGE_BOOKED, Lead, LeadEvent
from ..services.lead_guard import sweep_enabled

logger = logging.getLogger(__name__)


def _now_naive() -> datetime:
    """库里统一 naive UTC，比较前先统一口径。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_naive_utc(dt: datetime | None) -> datetime:
    if dt is None:
        return _now_naive()
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


async def run_once(now: datetime | None = None, limit: int = 50) -> dict:
    """跑一轮：挑到点的 booked → 逐条条件更新 → 成功的写一条事件。

    返回 ``{"scanned": 候选数, "marked": 成功标记数, "skipped": 是否被急停,
    "reason": 说明}``，方便脚本/巡检直接打印。
    """
    ok, why = sweep_enabled()
    if not ok:
        return {"scanned": 0, "marked": 0, "skipped": True, "reason": why}

    ref = _as_naive_utc(now)

    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(Lead.id, Lead.conversation_id)
                .where(
                    Lead.stage == STAGE_BOOKED,
                    Lead.pending_confirm.is_(False),
                    Lead.check_at.is_not(None),
                    Lead.check_at <= ref,
                )
                .order_by(Lead.check_at)
                .limit(limit)
            )
        ).all()
        # 结束只读事务，别把行锁一直攥着
        await session.rollback()

    marked = 0
    for lead_id, conversation_id in rows:
        async with SessionLocal() as session:
            try:
                result = await session.execute(
                    update(Lead)
                    .where(
                        Lead.id == lead_id,
                        Lead.stage == STAGE_BOOKED,
                        Lead.pending_confirm.is_(False),
                    )
                    .values(pending_confirm=True, alerted_at=ref)
                )
                # 只有自己抢到这一次状态翻转，才写事件；否则是别人已经标过了
                if result.rowcount == 1:
                    session.add(
                        LeadEvent(
                            conversation_id=conversation_id,
                            event_type="check_pending",
                            from_stage=STAGE_BOOKED,
                            to_stage=STAGE_BOOKED,
                            payload=json.dumps(
                                {"check_at": ref.isoformat(), "alerted_at": ref.isoformat()},
                                ensure_ascii=False,
                            ),
                            source="system",
                        )
                    )
                    marked += 1
                await session.commit()
            except Exception:  # noqa: BLE001 - 一行失败不能拖住整批
                logger.exception("线索 %s 标待核实失败", lead_id)
                await session.rollback()

    if rows:
        logger.info("lead_sweep 一轮结束: scanned=%d marked=%d", len(rows), marked)
    return {"scanned": len(rows), "marked": marked, "skipped": False, "reason": ""}


async def run_forever(interval: float = 300.0) -> None:
    """常驻循环。异常只记日志，绝不退出（退出就再也没人提醒了）。"""
    logger.info("lead_sweep worker 启动，轮询间隔 %.1fs", interval)
    while True:
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 轮询不能因为一次异常就退出
            logger.exception("lead_sweep 轮询异常")
        await asyncio.sleep(interval)


__all__ = ["run_forever", "run_once"]

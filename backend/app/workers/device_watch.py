"""设备离线判定 worker：心跳超时就把设备标成 offline，并推一条 WS 事件。

判定只看 ``last_heartbeat_at``：超过 ``OFFLINE_AFTER_SECONDS`` 没心跳即离线。
``wecom_state`` **不动**——那是设备自己探测的企业微信状态，服务器不替它猜。

抢占靠条件更新（``WHERE status='online'``）+ rowcount：多个 worker 同时跑，
只有真正改到 1 行的那次才推事件，不会重复刷屏。

进程模型同 ``workers/outbox.py``：单进程 asyncio 循环，异常只记日志不退出。
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from ..db import SessionLocal
from ..models import Device
from ..ws.hub import EVT_DEVICE_STATUS, device_topic, hub

logger = logging.getLogger(__name__)

# 心跳超时阈值：设备端 30s 一次心跳，2 个周期不报就算掉线
OFFLINE_AFTER_SECONDS = 90

LOCAL_TZ = timezone(timedelta(hours=8))


def _naive_utc(dt: datetime) -> datetime:
    """带时区的转成 naive UTC；naive 的按 UTC 理解（库里统一这个口径）。"""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _iso_local(dt: datetime | None) -> str | None:
    """库里是 naive UTC，推给前端时统一带 +08:00。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ).isoformat()


async def run_once(now: datetime | None = None) -> dict[str, int]:
    """跑一轮离线判定，返回 ``{"checked": 候选数, "marked": 真正标离线数}``。"""
    ref = _naive_utc(now or datetime.now(timezone.utc))
    cutoff = ref - timedelta(seconds=OFFLINE_AFTER_SECONDS)

    checked = 0
    marked = 0

    async with SessionLocal() as session:
        candidates = (
            await session.execute(
                select(Device).where(
                    Device.status == "online",
                    Device.last_heartbeat_at.is_not(None),
                    Device.last_heartbeat_at < cutoff,
                )
            )
        ).scalars().all()
        checked = len(candidates)

        for device in candidates:
            # 先取出来：更新后对象就过期了，事件的字段必须来自更新前
            device_id = device.id
            device_code = device.device_code
            wecom_state = device.wecom_state
            heartbeat_at = device.last_heartbeat_at

            result = await session.execute(
                update(Device)
                .where(Device.id == device_id, Device.status == "online")
                .values(status="offline")
                .execution_options(synchronize_session=False)
            )
            if result.rowcount != 1:
                # 别的 worker 抢先改了，或者设备刚好又心跳了 —— 不推事件
                continue

            await session.commit()
            marked += 1

            await hub.publish(
                device_topic(device_code),
                {
                    "type": EVT_DEVICE_STATUS,
                    "device_code": device_code,
                    "status": "offline",
                    "wecom_state": wecom_state,
                    "last_heartbeat_at": _iso_local(heartbeat_at),
                    "reason": f"心跳超时 {OFFLINE_AFTER_SECONDS} 秒",
                },
            )

    if checked:
        logger.info("device_watch 一轮结束: checked=%s marked=%s", checked, marked)
    return {"checked": checked, "marked": marked}


async def run_forever(interval: float = 30.0) -> None:
    logger.info("device_watch worker 启动，轮询间隔 %.1fs", interval)
    while True:
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 轮询不能因为一次异常就退出
            logger.exception("device_watch 轮询异常")
        await asyncio.sleep(interval)


__all__ = ["OFFLINE_AFTER_SECONDS", "run_forever", "run_once"]

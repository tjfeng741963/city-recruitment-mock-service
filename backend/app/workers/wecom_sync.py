"""企微消息的定时兜底同步。

回调丢失（网络抖动、企微重试耗尽、服务重启期间）时，这条轮询是唯一的补偿路径。
未配置企微时静默跳过，不刷日志。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..channels.wecom_kf.client import WeComClient
from ..channels.wecom_kf.config import get_wecom_settings
from ..channels.wecom_kf.sync import ensure_channel, sync_channel
from ..db import SessionLocal

logger = logging.getLogger(__name__)


async def run_once() -> dict[str, Any] | None:
    """拉一轮。未配置返回 None，配置了返回 sync 统计。"""
    settings = get_wecom_settings()
    if not settings.configured:
        return None

    async with SessionLocal() as session:
        channel = await ensure_channel(session)
        if channel is None:  # pragma: no cover - configured 为真时不该发生
            return None
        client = WeComClient(settings)
        try:
            return await sync_channel(session, channel, client)
        finally:
            await client.aclose()


async def run_forever(interval_seconds: float = 15.0) -> None:
    logger.info("企微同步 worker 启动，间隔 %.1fs", interval_seconds)
    while True:
        try:
            stats = await run_once()
            if stats and (stats.get("new_messages") or stats.get("errors")):
                logger.info(
                    "同步完成 pages=%s new=%s errors=%s",
                    stats.get("pages"),
                    stats.get("new_messages"),
                    stats.get("errors"),
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 后台任务不能因为一次失败就死掉
            logger.exception("企微同步失败，%ss 后重试", interval_seconds)
        await asyncio.sleep(interval_seconds)


__all__ = ["run_forever", "run_once"]

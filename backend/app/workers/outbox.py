"""发件箱 worker：定时把 queued 的投递交给 sender 真正发出去。

进程模型：单进程内 asyncio 循环。抢占靠数据库中那条条件更新，
所以就算多开几个 worker 也不会把同一条消息发两次（多余的会被判 "already claimed"）。

客户端按 duck typing 使用（见 channels/wecom_kf/sender.py 的模块注释），
这里刻意不在模块顶层 import 具体类：worker 不该和某个通道实现绑死，
另外也避免 client 还没就绪时整个 worker 模块 import 失败。
"""

from __future__ import annotations

import asyncio
import importlib
import logging
from collections.abc import Callable
from typing import Any

from ..channels.wecom_kf.sender import WeComKfSender
from ..db import SessionLocal
from ..services.delivery_service import claim_batch

logger = logging.getLogger(__name__)

ClientFactory = Callable[[], Any]

_client_factory: ClientFactory | None = None


def set_client_factory(factory: ClientFactory | None) -> None:
    """注入客户端工厂（测试/多账号场景）；传 None 恢复默认的延迟解析。"""
    global _client_factory
    _client_factory = factory


def _default_client() -> Any:
    """延迟解析默认客户端：只依赖 send_text / service_state 两个方法。"""
    package = (__package__ or "app.workers").rsplit(".", 1)[0]  # app.workers -> app
    module = importlib.import_module(f"{package}.channels.wecom_kf.client")
    client_cls = getattr(module, "WeComClient", None)
    if client_cls is None:
        raise RuntimeError("app.channels.wecom_kf.client.WeComClient 未实现，无法创建企微客户端")
    return client_cls()


def _resolve_factory(client_factory: ClientFactory | None) -> ClientFactory:
    return client_factory or _client_factory or _default_client


def _tally(counters: dict[str, int], result) -> None:
    if result.ok:
        counters["accepted"] += 1
    elif result.blocked_reason:
        counters["blocked"] += 1
    elif result.uncertain:
        counters["unknown"] += 1
    else:
        counters["failed"] += 1


async def run_once(limit: int = 20, *, client_factory: ClientFactory | None = None) -> dict[str, int]:
    """跑一轮：挑候选 → 逐条投递。单条异常只计数，绝不中断整批。"""
    counters = {"picked": 0, "accepted": 0, "failed": 0, "blocked": 0, "unknown": 0}
    factory = _resolve_factory(client_factory)

    async with SessionLocal() as session:
        candidate_ids = await claim_batch(session, limit)
        # 结束只读事务：Postgres 下这会释放 SKIP LOCKED 拿到的行锁
        await session.rollback()

    counters["picked"] = len(candidate_ids)
    for delivery_id in candidate_ids:
        async with SessionLocal() as session:
            try:
                result = await WeComKfSender(factory(), session).send(delivery_id)
            except Exception:  # noqa: BLE001 - 单条失败不能影响整批
                logger.exception("投递 %s 处理失败", delivery_id)
                counters["failed"] += 1
                await session.rollback()
                continue
        _tally(counters, result)

    if counters["picked"]:
        logger.info("outbox 一轮结束: %s", counters)
    return counters


async def run_forever(interval_seconds: float = 5.0) -> None:
    logger.info("outbox worker 启动，轮询间隔 %.1fs", interval_seconds)
    while True:
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 轮询不能因为一次异常就退出
            logger.exception("outbox 轮询异常")
        await asyncio.sleep(interval_seconds)


__all__ = ["run_forever", "run_once", "set_client_factory"]

"""outbox 通道过滤回归（2026-11-16 整合）。

claim_batch 只领 wecom_kf 通道的投递；wxwork_local（键鼠）通道的投递由
GET /agent/commands 消费——过去混进 outbox 会被 KF sender 校验打失败，
等于把本该键鼠发送的指令悄悄判死。
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.db import SessionLocal, engine, init_db
from app.models import ChannelAccount, Conversation, Customer, Delivery
from app.services import delivery_service


@pytest_asyncio.fixture(autouse=True)
async def clean_tables():
    # 前后都清：用例会留下通道/会话/投递行，污染共享测试库的后续用例
    # （实测把 test_list_conversations_empty 搞挂）。
    await init_db()
    async with SessionLocal() as session:
        for model in (Delivery, Conversation, Customer, ChannelAccount):
            await session.execute(delete(model))
        await session.commit()
    yield
    async with SessionLocal() as session:
        for model in (Delivery, Conversation, Customer, ChannelAccount):
            await session.execute(delete(model))
        await session.commit()


@pytest.fixture(scope="module", autouse=True)
def dispose_engine_after_module():
    """模块跑完先释放连接池：conftest 收尾要删测试库文件，Windows 下句柄没放掉就删不动。"""
    yield
    asyncio.run(engine.dispose())


async def _mk_delivery(channel_type: str, suffix: str) -> int:
    async with SessionLocal() as session:
        channel = ChannelAccount(
            channel_type=channel_type,
            name="通道",
            external_id=f"ch_{suffix}",
            corp_id="corp_test",
            status="enabled",
        )
        session.add(channel)
        await session.flush()
        customer = Customer(
            channel_account_id=channel.id,
            external_userid=f"wx_{suffix}",
            nickname="客户",
        )
        session.add(customer)
        await session.flush()
        conv = Conversation(
            channel_account_id=channel.id,
            customer_id=customer.id,
        )
        session.add(conv)
        await session.flush()
        delivery = Delivery(
            conversation_id=conv.id,
            content="你好",
            idempotency_key=f"manual-reply:t-{suffix}",
            status="queued",
        )
        session.add(delivery)
        await session.commit()
        return delivery.id


@pytest.mark.asyncio
async def test_outbox_claims_only_wecom_kf_deliveries():
    kf_id = await _mk_delivery("wecom_kf", "kf1")
    local_id = await _mk_delivery("wxwork_local", "loc1")

    async with SessionLocal() as session:
        picked = await delivery_service.claim_batch(session, 20)
        assert picked == [kf_id]
        statuses = {
            d.id: d.status
            for d in (await session.execute(select(Delivery))).scalars()
        }
    # 键鼠通道的投递留在 queued，等 GET /agent/commands 来领
    assert statuses[local_id] == "queued"

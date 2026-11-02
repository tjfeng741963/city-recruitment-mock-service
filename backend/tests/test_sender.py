"""出站投递的测试：六道校验 / 抢占 / 状态流转 / worker。

全部用假客户端（只实现 send_text + service_state 两个方法），不碰网络。
数据库直接用 SessionLocal()，靠 `APP_DATABASE_URL` 指向独立的 test_sender.db，
避免和并行任务抢同一个库。
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from dataclasses import dataclass
from datetime import timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.channels.wecom_kf.errors import WeComApiError
from app.channels.wecom_kf.sender import MAX_TEXT_BYTES, WeComKfSender
from app.db import SessionLocal, init_db
from app.models import ChannelAccount, Conversation, Customer, Delivery, Message
from app.services import delivery_service
from app.workers import outbox

UTC = timezone.utc


# ─────────────────────────── 假客户端 ───────────────────────────
class FakeClient:
    """记录调用次数，返回值/异常可配置。"""

    def __init__(
        self,
        *,
        state: int = 0,
        result: dict | None = None,
        error: Exception | None = None,
        state_error: Exception | None = None,
    ) -> None:
        self.state = state
        self.result = dict(result) if result is not None else {"errcode": 0, "errmsg": "ok"}
        self.error = error
        self.state_error = state_error
        self.sent: list[tuple[str, str, str, str]] = []
        self.state_calls = 0

    async def service_state(self, open_kfid: str, external_userid: str) -> int:
        self.state_calls += 1
        if self.state_error is not None:
            raise self.state_error
        return self.state

    async def send_text(self, open_kfid: str, external_userid: str, content: str, msgid: str) -> dict:
        self.sent.append((open_kfid, external_userid, content, msgid))
        if self.error is not None:
            raise self.error
        payload = dict(self.result)
        payload.setdefault("msgid", msgid)
        return payload


# ─────────────────────────── 夹具 ───────────────────────────
@pytest_asyncio.fixture(autouse=True)
async def clean_tables():
    """每个用例前清空相关表，用例之间互不影响。"""
    await init_db()
    async with SessionLocal() as session:
        for model in (Message, Delivery, Conversation, Customer, ChannelAccount):
            await session.execute(delete(model))
        await session.commit()
    yield


@pytest.fixture(scope="module", autouse=True)
def dispose_engine_after_module():
    """模块跑完先释放连接池：conftest 收尾要删测试库文件，Windows 下句柄没放掉就删不动。"""
    yield
    from app.db import engine

    asyncio.run(engine.dispose())


@dataclass
class Scene:
    delivery_id: int
    conversation_id: int
    channel_id: int
    customer_id: int
    external_userid: str
    open_kfid: str
    corp_id: str
    idempotency_key: str


async def make_scene(
    *,
    channel_status: str = "enabled",
    takeover: bool = False,
    content: str = "你好，方便聊聊岗位吗",
    key: str = "ai-1",
    inbound_ago: timedelta = timedelta(hours=1),
    with_customer: bool = True,
    with_inbound: bool = True,
    extra_deliveries: int = 0,
    extra_status: str = "accepted",
) -> Scene:
    """造一个「通道 + 客户 + 会话 + 一条入站消息 + 一条待投递」的最小场景。"""
    suffix = uuid.uuid4().hex[:8]
    open_kfid = f"kf_{suffix}"
    external_userid = f"wm_{suffix}"
    corp_id = "corp_test"

    async with SessionLocal() as session:
        channel = ChannelAccount(
            channel_type="wecom_kf",
            name="客服账号",
            external_id=open_kfid,
            corp_id=corp_id,
            status=channel_status,
        )
        session.add(channel)
        await session.flush()

        customer_id = 999_999
        if with_customer:
            customer = Customer(
                channel_account_id=channel.id,
                external_userid=external_userid,
                nickname="张三",
            )
            session.add(customer)
            await session.flush()
            customer_id = customer.id

        conversation = Conversation(
            channel_account_id=channel.id,
            customer_id=customer_id,
            takeover=takeover,
        )
        session.add(conversation)
        await session.flush()

        inbound_at = delivery_service.utcnow() - inbound_ago
        if with_inbound:
            session.add(
                Message(
                    conversation_id=conversation.id,
                    direction="inbound",
                    source="customer",
                    content="你们还在招人吗",
                    created_at=inbound_at,
                )
            )

        for i in range(extra_deliveries):
            session.add(
                Delivery(
                    conversation_id=conversation.id,
                    idempotency_key=f"filler-{i}-{suffix}",
                    content=f"占额度消息 {i}",
                    status=extra_status,
                    created_at=inbound_at + timedelta(minutes=1),
                )
            )

        delivery = Delivery(
            conversation_id=conversation.id,
            idempotency_key=key,
            content=content,
            status="queued",
            created_at=inbound_at + timedelta(minutes=2),
        )
        session.add(delivery)
        await session.commit()

        return Scene(
            delivery_id=delivery.id,
            conversation_id=conversation.id,
            channel_id=channel.id,
            customer_id=customer_id,
            external_userid=external_userid,
            open_kfid=open_kfid,
            corp_id=corp_id,
            idempotency_key=key,
        )


async def get_delivery(delivery_id: int) -> Delivery:
    async with SessionLocal() as session:
        return await session.get(Delivery, delivery_id)


# ─────────────────────────── 1. 六道校验 ───────────────────────────
CHECK_CASES = [
    ("channel disabled", {"channel_status": "disabled"}, "channel disabled"),
    ("customer not mapped", {"with_customer": False}, "customer identity is not mapped"),
    ("text too long", {"content": "a" * (MAX_TEXT_BYTES + 1)}, "text must be 1..2048 utf-8 bytes"),
    ("window expired", {"inbound_ago": timedelta(hours=49)}, "48-hour reply window expired"),
    ("allowance exhausted", {"extra_deliveries": 5}, "five-message reply allowance exhausted"),
    ("human takeover", {"takeover": True}, "human takeover"),
]


@pytest.mark.parametrize(
    "case,options,expected",
    CHECK_CASES,
    ids=[case for case, _, _ in CHECK_CASES],
)
async def test_each_check_blocks(case: str, options: dict, expected: str) -> None:
    scene = await make_scene(**options)
    client = FakeClient()

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    assert result.ok is False, case
    assert result.blocked_reason == expected, case
    assert client.sent == [], "校验不过时绝不能调用发送接口"

    delivery = await get_delivery(scene.delivery_id)
    assert delivery.status == "blocked"
    assert delivery.blocked_reason == expected


# ─────────────────────────── 2. 正常发送 ───────────────────────────
async def test_send_success_end_to_end() -> None:
    scene = await make_scene()
    client = FakeClient()

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    assert result.ok is True
    assert result.external_msgid
    assert len(client.sent) == 1, "同一条投递只能发一次"
    assert client.state_calls == 1

    open_kfid, external_userid, content, msgid = client.sent[0]
    assert (open_kfid, external_userid) == (scene.open_kfid, scene.external_userid)
    assert content == "你好，方便聊聊岗位吗"
    expected_msgid = hashlib.sha256(
        f"{scene.corp_id}:{scene.open_kfid}:{scene.idempotency_key}".encode("utf-8")
    ).hexdigest()[:32]
    assert msgid == expected_msgid, "msgid 由 corp:kf:key 派生，重投时保持不变"
    assert result.external_msgid == expected_msgid

    delivery = await get_delivery(scene.delivery_id)
    assert delivery.status == "accepted"
    assert delivery.external_msgid == expected_msgid
    assert delivery.attempts == 1

    async with SessionLocal() as session:
        messages = (
            await session.execute(select(Message).where(Message.delivery_id == scene.delivery_id))
        ).scalars().all()
        assert len(messages) == 1
        assert messages[0].direction == "outbound"
        assert messages[0].source == "ai"
        assert messages[0].content == "你好，方便聊聊岗位吗"

        conversation = await session.get(Conversation, scene.conversation_id)
        assert conversation.last_message_at is not None
        assert conversation.last_message_preview == "你好，方便聊聊岗位吗"


# ─────────────────────────── 3. 结果不明不重投 ───────────────────────────
async def test_uncertain_failure_goes_unknown_and_is_not_retried() -> None:
    scene = await make_scene()
    client = FakeClient(error=WeComApiError("read timeout", None, uncertain=True))

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    assert result.ok is False
    assert result.uncertain is True
    delivery = await get_delivery(scene.delivery_id)
    assert delivery.status == "unknown"
    assert delivery.next_attempt_at is None, "unknown 不允许自动重投"

    # 再跑一次也不会重发
    async with SessionLocal() as session:
        again = await WeComKfSender(client, session).send(scene.delivery_id)
    assert again.ok is False
    assert len(client.sent) == 1, "结果不明的消息只能发过一次"

    # worker 也挑不到它
    async with SessionLocal() as session:
        assert await delivery_service.claim_batch(session, 10) == []
        counts = await delivery_service.stats(session)
    assert counts["unknown"] == 1


# ─────────────────────────── 4. 限流退避 ───────────────────────────
async def test_rate_limited_returns_to_queue_with_delay() -> None:
    scene = await make_scene()
    client = FakeClient(error=WeComApiError("rate limited", 45009))
    before = delivery_service.utcnow()

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    assert result.ok is False
    delivery = await get_delivery(scene.delivery_id)
    assert delivery.status == "queued"
    assert delivery.attempts == 1
    assert delivery.next_attempt_at is not None
    delay = delivery_service.as_utc(delivery.next_attempt_at) - before
    assert timedelta(seconds=55) <= delay <= timedelta(seconds=65)
    assert len(client.sent) == 1

    # 退避期内 worker 不该再挑它
    async with SessionLocal() as session:
        assert await delivery_service.claim_batch(session, 10) == []


async def test_system_busy_errcode_also_requeues() -> None:
    scene = await make_scene()
    client = FakeClient(result={"errcode": -1, "errmsg": "system busy"})

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    assert result.ok is False
    assert (await get_delivery(scene.delivery_id)).status == "queued"


# ─────────────────────────── 5. 并发抢占 ───────────────────────────
async def test_concurrent_senders_only_one_wins() -> None:
    scene = await make_scene()
    client = FakeClient()

    async def worker():
        async with SessionLocal() as session:
            return await WeComKfSender(client, session).send(scene.delivery_id)

    first, second = await asyncio.gather(worker(), worker())

    winners = [r for r in (first, second) if r.ok]
    losers = [r for r in (first, second) if not r.ok]
    assert len(winners) == 1, (first, second)
    assert len(losers) == 1
    assert losers[0].error == "already claimed"
    assert len(client.sent) == 1, "并发下同一条消息只能发一次"

    async with SessionLocal() as session:
        messages = (
            await session.execute(select(Message).where(Message.delivery_id == scene.delivery_id))
        ).scalars().all()
    assert len(messages) == 1


# ─────────────────────────── 6. service_state ───────────────────────────
async def test_service_state_blocks_api_reply() -> None:
    scene = await make_scene()
    client = FakeClient(state=3)

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    assert result.ok is False
    assert result.blocked_reason == "service state 3 does not permit api replies"
    delivery = await get_delivery(scene.delivery_id)
    assert delivery.status == "blocked"
    assert delivery.blocked_reason == "service state 3 does not permit api replies"
    assert client.sent == []


# ─────────────────────────── 7. 人工接管 ───────────────────────────
async def test_takeover_blocks_ai_but_lets_manual_reply_through() -> None:
    ai_scene = await make_scene(takeover=True, key="ai-takeover")
    manual_scene = await make_scene(takeover=True, key="manual-reply:agent-1")
    client = FakeClient()

    async with SessionLocal() as session:
        ai_result = await WeComKfSender(client, session).send(ai_scene.delivery_id)
    async with SessionLocal() as session:
        manual_result = await WeComKfSender(client, session).send(manual_scene.delivery_id)

    assert ai_result.ok is False
    assert ai_result.blocked_reason == "human takeover"
    assert manual_result.ok is True
    assert len(client.sent) == 1

    async with SessionLocal() as session:
        messages = (
            await session.execute(
                select(Message).where(Message.delivery_id == manual_scene.delivery_id)
            )
        ).scalars().all()
    assert messages[0].source == "agent", "manual-reply: 前缀的投递来源应记为 agent"


# ─────────────────────────── 8. 2048 字节边界 ───────────────────────────
@pytest.mark.parametrize("size,allowed", [(2048, True), (2049, False)])
async def test_text_byte_boundary(size: int, allowed: bool) -> None:
    scene = await make_scene(content="a" * size)
    client = FakeClient()

    async with SessionLocal() as session:
        result = await WeComKfSender(client, session).send(scene.delivery_id)

    delivery = await get_delivery(scene.delivery_id)
    if allowed:
        assert result.ok is True
        assert delivery.status == "accepted"
        assert len(client.sent) == 1
    else:
        assert result.ok is False
        assert result.blocked_reason == "text must be 1..2048 utf-8 bytes"
        assert delivery.status == "blocked"
        assert client.sent == []


# ─────────────────────────── 状态机 / worker ───────────────────────────
async def test_mark_rejects_illegal_transition() -> None:
    scene = await make_scene()

    async with SessionLocal() as session:
        with pytest.raises(ValueError):
            await delivery_service.mark(session, scene.delivery_id, "accepted")
        await session.rollback()
        with pytest.raises(ValueError):
            await delivery_service.mark(session, scene.delivery_id, "queued")

    # 合法路径照常
    async with SessionLocal() as session:
        await delivery_service.mark(session, scene.delivery_id, "blocked", reason="human takeover")
    assert (await get_delivery(scene.delivery_id)).status == "blocked"


async def test_run_once_counts_and_keeps_going() -> None:
    await make_scene(key="ai-ok")
    await make_scene(takeover=True, key="ai-blocked")
    scene_broken = await make_scene(key="ai-boom")
    broken_kfid = scene_broken.open_kfid

    class FlakyClient(FakeClient):
        """遇到第三条投递时抛非企微异常，验证整批不中断。"""

        async def service_state(self, open_kfid: str, external_userid: str) -> int:
            if open_kfid == broken_kfid:
                raise RuntimeError("boom")
            return await super().service_state(open_kfid, external_userid)

    counters = await outbox.run_once(client_factory=lambda: FlakyClient())

    assert counters["picked"] == 3
    assert counters["accepted"] == 1
    assert counters["blocked"] == 1
    assert counters["unknown"] == 1
    assert counters["failed"] == 0

    async with SessionLocal() as session:
        counts = await delivery_service.stats(session)
    assert counts["accepted"] == 1
    assert counts["blocked"] == 1
    assert counts["unknown"] == 1
    assert counts["queued"] == 0

    # 第二轮没有可投递的了
    assert (await outbox.run_once(client_factory=lambda: FakeClient()))["picked"] == 0

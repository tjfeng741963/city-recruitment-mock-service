"""企业微信客服的出站投递：六道发送校验 + 抢占 + 结果落库。

客户端只按 duck typing 使用，不 import 具体实现（client.py 由另一个模块提供）：

    await client.send_text(open_kfid, external_userid, content, msgid) -> dict
        # 成功：{"errcode": 0, "errmsg": "ok", "msgid": "<回显的 msgid>"}
    await client.service_state(open_kfid, external_userid) -> int
        # 0..4，0/1 允许 API 回复
    失败抛 WeComApiError(message, code, uncertain)

为什么校验顺序不能乱：每道校验都在替后一道兜底。通道停用就没必要谈客户映射；
文本不合法时算 48h 窗口纯属浪费；已经超窗时再算 5 条配额没有意义；
而「人工接管」是最后一道，因为它是业务策略而非通道约束。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import ChannelAccount, Conversation, Customer, Delivery, Message
from ...services.delivery_service import (
    ACCEPTED,
    BLOCKED,
    FAILED,
    MANUAL_REPLY_PREFIX,
    QUEUED,
    SENDING,
    UNKNOWN,
    as_utc,
    mark,
    utcnow,
)
from ..base import SendResult
from .errors import WeComApiError

MAX_TEXT_BYTES = 2048
REPLY_WINDOW = timedelta(hours=48)
MAX_REPLIES_PER_WINDOW = 5
# 哪些状态算「这个窗口里已经用掉的配额」：unknown 也占额度，因为对方可能已经收到了
COUNTED_STATUSES: tuple[str, ...] = (QUEUED, SENDING, ACCEPTED, UNKNOWN)
# -1 = 系统繁忙，45009 = 接口频率超限，两者都值得退避后重试
RATE_LIMIT_CODES: frozenset[int] = frozenset({-1, 45009})
RETRY_DELAY = timedelta(seconds=60)
PREVIEW_LIMIT = 255


@dataclass(slots=True)
class _Target:
    """校验通过后要用到的实体，避免重复查库。"""

    delivery: Delivery
    conversation: Conversation
    channel: ChannelAccount
    customer: Customer


class WeComKfSender:
    def __init__(self, client, session: AsyncSession) -> None:
        self._client = client
        self._session = session

    # ─────────────────────────── 主流程 ───────────────────────────
    async def send(self, delivery_id: int) -> SendResult:
        session = self._session
        delivery = await session.get(Delivery, delivery_id)
        if delivery is None:
            return SendResult(ok=False, error=f"投递记录 {delivery_id} 不存在")
        if delivery.status in (ACCEPTED, UNKNOWN):
            # 已经落地（或结果不明）的不允许再发，否则会重复打扰客户
            return SendResult(ok=False, error="already claimed")

        reason, target = await self._precheck(delivery)
        if target is None:
            await self._block(delivery, reason)
            return SendResult(ok=False, blocked_reason=reason)

        # 这里先结束只读事务，让抢占那条 UPDATE 独占写锁，避免 SQLite 下读到旧快照
        await session.commit()
        if not await self._claim(delivery):
            return SendResult(ok=False, error="already claimed")

        try:
            state = int(
                await self._client.service_state(
                    target.channel.external_id, target.customer.external_userid
                )
            )
        except WeComApiError as exc:
            return await self._fail(delivery, exc)
        except Exception as exc:  # noqa: BLE001 - 结果不明，宁可停下也不重投
            await mark(session, delivery.id, UNKNOWN)
            return SendResult(ok=False, error=str(exc), uncertain=True)

        if state not in (0, 1):
            blocked = f"service state {state} does not permit api replies"
            await mark(session, delivery.id, BLOCKED, reason=blocked)
            return SendResult(ok=False, blocked_reason=blocked)

        msgid = await self._ensure_msgid(delivery, target)
        try:
            raw = await self._client.send_text(
                target.channel.external_id,
                target.customer.external_userid,
                delivery.content,
                msgid,
            )
        except WeComApiError as exc:
            return await self._fail(delivery, exc)
        except Exception as exc:  # noqa: BLE001
            await mark(session, delivery.id, UNKNOWN)
            return SendResult(ok=False, error=str(exc), uncertain=True)

        payload = raw if isinstance(raw, dict) else {}
        errcode = int(payload.get("errcode") or 0)
        returned = str(payload.get("msgid") or "")
        if errcode != 0:
            return await self._fail(
                delivery,
                WeComApiError(str(payload.get("errmsg") or "send_text failed"), errcode),
            )
        if returned != msgid:
            # 回显不一致说明发的不是我们准备的那条，当成失败让人工介入
            await mark(session, delivery.id, FAILED)
            return SendResult(ok=False, error=f"msgid mismatch: sent {msgid}, got {returned}")

        await self._accept(target, msgid)
        return SendResult(ok=True, external_msgid=msgid)

    # ─────────────────────────── 六道校验 ───────────────────────────
    async def _precheck(self, delivery: Delivery) -> tuple[str, _Target | None]:
        session = self._session

        conversation = await session.get(Conversation, delivery.conversation_id)
        if conversation is None:
            return "customer identity is not mapped", None

        # 1. 通道账号必须可用
        channel = await session.get(ChannelAccount, conversation.channel_account_id)
        if channel is None or channel.status != "enabled":
            return "channel disabled", None

        # 2. 客户身份必须已映射到这个通道上的 external_userid
        customer = await session.get(Customer, conversation.customer_id)
        if customer is None or not customer.external_userid:
            return "customer identity is not mapped", None
        if customer.channel_account_id != channel.id:
            return "customer identity is not mapped", None

        # 3. 文本长度按 UTF-8 字节算，中文一个字 3 字节
        size = len(delivery.content.encode("utf-8"))
        if size < 1 or size > MAX_TEXT_BYTES:
            return f"text must be 1..{MAX_TEXT_BYTES} utf-8 bytes", None

        # 4. 48 小时回复窗口：以会话最后一条客户入站消息为起点
        last_inbound = (
            await session.execute(
                select(func.max(Message.created_at)).where(
                    Message.conversation_id == conversation.id,
                    Message.direction == "inbound",
                )
            )
        ).scalar()
        window_start = as_utc(last_inbound)
        if window_start is None or utcnow() - window_start >= REPLY_WINDOW:
            return "48-hour reply window expired", None

        # 5. 同一窗口内最多 5 条。自己不算，否则第一条消息永远「先把额度用掉一条」
        used = (
            await session.execute(
                select(func.count(Delivery.id)).where(
                    Delivery.conversation_id == conversation.id,
                    Delivery.id != delivery.id,
                    Delivery.status.in_(COUNTED_STATUSES),
                    Delivery.created_at >= window_start,
                )
            )
        ).scalar() or 0
        if int(used) >= MAX_REPLIES_PER_WINDOW:
            return "five-message reply allowance exhausted", None

        # 6. 人工接管期间只放行人工回复
        if conversation.takeover and not delivery.idempotency_key.startswith(MANUAL_REPLY_PREFIX):
            return "human takeover", None

        return "", _Target(
            delivery=delivery, conversation=conversation, channel=channel, customer=customer
        )

    async def _block(self, delivery: Delivery, reason: str) -> None:
        if delivery.status == BLOCKED:
            if delivery.blocked_reason != reason:
                delivery.blocked_reason = reason
                await self._session.commit()
            return
        if delivery.status not in (QUEUED, SENDING):
            # 终态（accepted/unknown/failed）不允许再改，保持原样
            return
        await mark(self._session, delivery.id, BLOCKED, reason=reason)

    # ─────────────────────────── 抢占 / 发送副作用 ───────────────────────────
    async def _claim(self, delivery: Delivery) -> bool:
        """条件更新抢占：只有把 queued 改成 sending 成功的那一个 worker 继续往下走。"""
        session = self._session
        result = await session.execute(
            update(Delivery)
            .where(Delivery.id == delivery.id, Delivery.status == QUEUED)
            .values(
                status=SENDING,
                attempts=Delivery.attempts + 1,
                next_attempt_at=None,
                updated_at=utcnow(),
            )
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        if result.rowcount == 0:
            return False
        await session.refresh(delivery)
        return True

    async def _ensure_msgid(self, delivery: Delivery, target: _Target) -> str:
        """msgid 必须在发送前落库：崩溃重投时靠它让企微侧去重。"""
        if delivery.external_msgid:
            return delivery.external_msgid
        seed = f"{target.channel.corp_id}:{target.channel.external_id}:{delivery.idempotency_key}"
        msgid = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]
        delivery.external_msgid = msgid
        await self._session.commit()
        return msgid

    async def _accept(self, target: _Target, msgid: str) -> None:
        """状态、消息、会话摘要三件事必须同一个事务落地。"""
        session = self._session
        await mark(session, target.delivery.id, ACCEPTED, external_msgid=msgid, commit=False)

        exists = (
            await session.execute(
                select(Message.id).where(Message.delivery_id == target.delivery.id).limit(1)
            )
        ).scalar_one_or_none()
        now = utcnow()
        if exists is None:
            session.add(
                Message(
                    conversation_id=target.conversation.id,
                    direction="outbound",
                    source=_source_of(target.delivery),
                    content_type="text",
                    content=target.delivery.content,
                    external_msgid=msgid,
                    delivery_id=target.delivery.id,
                    created_at=now,
                )
            )
        target.conversation.last_message_at = now
        target.conversation.last_message_preview = target.delivery.content[:PREVIEW_LIMIT]
        await session.commit()

    async def _fail(self, delivery: Delivery, exc: WeComApiError) -> SendResult:
        if exc.uncertain:
            # 网络结果不明：绝不重投，留给人看
            await mark(self._session, delivery.id, UNKNOWN)
            return SendResult(ok=False, error=str(exc), uncertain=True)
        if exc.code in RATE_LIMIT_CODES:
            await mark(
                self._session,
                delivery.id,
                QUEUED,
                next_attempt_at=utcnow() + RETRY_DELAY,
            )
            return SendResult(ok=False, error=str(exc))
        await mark(self._session, delivery.id, FAILED)
        return SendResult(ok=False, error=str(exc))


def _source_of(delivery: Delivery) -> str:
    return "agent" if delivery.idempotency_key.startswith(MANUAL_REPLY_PREFIX) else "ai"


__all__ = ["WeComKfSender"]

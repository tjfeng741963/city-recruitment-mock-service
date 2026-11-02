"""出站发件箱（transactional outbox）的读写与状态机。

设计要点：
1. 状态机只有一个入口 `mark()`：任何状态变更都必须声明迁移前状态是否合法，
   非法迁移直接 ValueError，避免出现「accepted 又被改回 queued」这类脏状态。
2. `claim_batch()` 只挑候选，不做真正的抢占；抢占由 sender 里那条
   `UPDATE deliveries SET status='sending' WHERE id=? AND status='queued'` 的
   rowcount 决定（单语句原子操作）。原因见 `_supports_skip_locked` 的注释。
3. 时间统一按 UTC 存取。SQLite 读回来的 datetime 是 naive 的（tzinfo 丢失），
   所以所有 Python 侧比较都要先过 `as_utc()`。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Delivery

UTC = timezone.utc

# ─────────────────────────── 状态全集 ───────────────────────────
QUEUED = "queued"
SENDING = "sending"
ACCEPTED = "accepted"
UNKNOWN = "unknown"
FAILED = "failed"
BLOCKED = "blocked"

STATUSES: tuple[str, ...] = (QUEUED, SENDING, ACCEPTED, UNKNOWN, FAILED, BLOCKED)

# 合法迁移表：queued → sending → accepted|unknown|failed，外加 sending → queued（限流退避重试）。
# blocked 是「前置校验不通过」的终点，queued 和 sending 都可以进去（service_state 校验发生在抢占之后）。
TRANSITIONS: dict[str, frozenset[str]] = {
    QUEUED: frozenset({SENDING, BLOCKED}),
    SENDING: frozenset({QUEUED, ACCEPTED, UNKNOWN, FAILED, BLOCKED}),
    ACCEPTED: frozenset(),
    UNKNOWN: frozenset(),
    FAILED: frozenset(),
    BLOCKED: frozenset(),
}

# 人工来源的投递统一带这个前缀：sender 靠它判断来源（ai / agent），
# 并且在人工接管期间放行人工回复。
MANUAL_REPLY_PREFIX = "manual-reply:"
IDEMPOTENCY_KEY_MAX = 128


def utcnow() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime | None) -> datetime | None:
    """把数据库里读出来的 naive datetime 补成 UTC aware。"""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


# ─────────────────────────── 创建 ───────────────────────────
def normalize_key(idempotency_key: str, source: str = "agent") -> str:
    """归一化幂等键。

    Delivery 表没有 source 列，来源信息就带在幂等键前缀上：
    source='agent' 的投递统一补 `manual-reply:`，sender 再据此写 Message.source。
    幂等键是按「归一化之后的值」判重的，所以同一条人工消息不会因为前缀差异重复落库。
    """
    key = (idempotency_key or "").strip()
    if not key:
        raise ValueError("Idempotency-Key 不能为空")
    if source == "agent" and not key.startswith(MANUAL_REPLY_PREFIX):
        key = MANUAL_REPLY_PREFIX + key
    if len(key) > IDEMPOTENCY_KEY_MAX:
        raise ValueError(f"Idempotency-Key 长度不能超过 {IDEMPOTENCY_KEY_MAX}")
    return key


async def _get_by_key(session: AsyncSession, conversation_id: int, key: str) -> Delivery | None:
    return (
        await session.execute(
            select(Delivery).where(
                Delivery.conversation_id == conversation_id,
                Delivery.idempotency_key == key,
            )
        )
    ).scalar_one_or_none()


async def create_delivery(
    session: AsyncSession,
    conversation_id: int,
    idempotency_key: str,
    content: str,
    source: str = "agent",
) -> Delivery:
    """落一条待投递记录（只入队，不发送）。

    同 (conversation_id, 归一化后的 key) 幂等：重复调用返回已有记录；
    内容不同则视为误用，抛 ValueError。
    """
    key = normalize_key(idempotency_key, source)

    existing = await _get_by_key(session, conversation_id, key)
    if existing is not None:
        if existing.content != content:
            raise ValueError("该 Idempotency-Key 已用于不同内容的消息")
        return existing

    delivery = Delivery(
        conversation_id=conversation_id,
        idempotency_key=key,
        content=content,
        status=QUEUED,
    )
    session.add(delivery)
    try:
        await session.commit()
    except IntegrityError:
        # 并发下同一 key 抢先落库：回滚后按幂等语义返回
        await session.rollback()
        existing = await _get_by_key(session, conversation_id, key)
        if existing is None:
            raise
        if existing.content != content:
            raise ValueError("该 Idempotency-Key 已用于不同内容的消息") from None
        return existing
    await session.refresh(delivery)
    return delivery


# ─────────────────────────── 状态机 ───────────────────────────
async def mark(
    session: AsyncSession,
    delivery_id: int,
    status: str,
    *,
    reason: str | None = None,
    external_msgid: str | None = None,
    next_attempt_at: datetime | None = None,
    commit: bool = True,
) -> None:
    """把 delivery 迁到 `status`；非法迁移抛 ValueError。

    - `next_attempt_at` 默认 None，即「迁到终态就清空重试时间」；
      退避重试（sending → queued）要显式传入新的时间。
    - `commit=False` 让调用方把状态流转和副作用（写 Message）放进同一个事务。
    """
    if status not in STATUSES:
        raise ValueError(f"未知的投递状态: {status!r}")

    delivery = await session.get(Delivery, delivery_id)
    if delivery is None:
        raise LookupError(f"投递记录 {delivery_id} 不存在")

    current = delivery.status
    if status not in TRANSITIONS.get(current, frozenset()):
        raise ValueError(f"非法的投递状态流转: {current} -> {status}")

    delivery.status = status
    if reason is not None:
        delivery.blocked_reason = reason
    if external_msgid is not None:
        delivery.external_msgid = external_msgid
    delivery.next_attempt_at = next_attempt_at
    delivery.updated_at = utcnow()

    if commit:
        await session.commit()
    else:
        await session.flush()


# ─────────────────────────── 取候选 ───────────────────────────
def _supports_skip_locked(session: AsyncSession) -> bool:
    """只有支持行锁的方言才用 FOR UPDATE SKIP LOCKED。

    SQLite 没有 `SELECT ... FOR UPDATE`，其写锁是库级的，硬写会直接语法/语义报错。
    所以在 SQLite 下退化成普通条件查询：这里只挑候选，真正的抢占靠 sender 里
    `UPDATE ... WHERE status='queued'` 的 `rowcount`（`changes`）判断——
    单语句条件更新本身就是原子的，不会两条 worker 同时成功，因此不需要额外加锁。
    """
    bind = session.get_bind()
    dialect = getattr(bind, "dialect", None)
    return getattr(dialect, "name", "") in {"postgresql", "mysql", "mariadb"}


async def claim_batch(session: AsyncSession, limit: int = 20) -> list[int]:
    """挑出可以尝试投递的 delivery id（queued 且 next_attempt_at 已到点）。

    返回的是候选，不是已抢占的：抢占在 `WeComKfSender.send()` 里做。
    """
    now = utcnow()
    stmt = (
        select(Delivery.id)
        .where(
            Delivery.status == QUEUED,
            or_(Delivery.next_attempt_at.is_(None), Delivery.next_attempt_at <= now),
        )
        .order_by(Delivery.id)
        .limit(limit)
    )
    if _supports_skip_locked(session):
        stmt = stmt.with_for_update(skip_locked=True)
    return [int(row) for row in (await session.execute(stmt)).scalars().all()]


# ─────────────────────────── 观测 ───────────────────────────
async def stats(session: AsyncSession) -> dict[str, int]:
    """各状态计数，验收/看板用；没有记录的状态补 0。"""
    rows = (
        await session.execute(select(Delivery.status, func.count(Delivery.id)).group_by(Delivery.status))
    ).all()
    counts: dict[str, int] = {status: 0 for status in STATUSES}
    for status, count in rows:
        counts[str(status)] = int(count)
    return counts


__all__ = [
    "ACCEPTED",
    "BLOCKED",
    "FAILED",
    "MANUAL_REPLY_PREFIX",
    "QUEUED",
    "SENDING",
    "STATUSES",
    "TRANSITIONS",
    "UNKNOWN",
    "as_utc",
    "claim_batch",
    "create_delivery",
    "mark",
    "normalize_key",
    "stats",
    "utcnow",
]

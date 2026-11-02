"""企业微信客服消息同步：把 ``kf/sync_msg`` 的分页结果落库。

设计约束（对应 tests/test_sync_webhook.py）：

* 通道（``channel_accounts``）由配置里的 ``open_kfid`` 唯一确定，重复调用只建一条。
* 游标（``cursor``）**一页处理完才推进并 commit**：任何一步失败都回滚，保留旧游标，
  下一轮从同位置重拉；由于 ``messages.external_msgid`` 做了查重，重拉不会产生重复消息。
* ``msg.open_kfid`` 与当前通道不一致的报文直接跳过并计数，不整批失败。
  这是防御性校验：回调只带 ``open_kfid``，真正的消息体来自 sync_msg，混淆时宁可丢弃。
* 本阶段不做客户资料补全（不调 ``customer/batchget``），昵称/头像留空。
* 本阶段也没有自动回复：``send_time < channel.reply_after`` 的历史消息照常入库，
  只是通过 ``reply_deferred`` 计数标记「不进入待回复集合」。
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...models import ChannelAccount, Conversation, Customer, Delivery, Message
from .config import get_wecom_settings
from .errors import WeComApiError

__all__ = ["ensure_channel", "sync_channel"]

_log = logging.getLogger(__name__)

CHANNEL_TYPE = "wecom_kf"
CHANNEL_NAME = "企业微信客服"

#: 单次同步最多翻页数，防止异常响应把后台任务拖死
MAX_PAGES = 20

#: 建通道时 ``reply_after`` 的回溯秒数：只自动回复「刚建立连接之后」的消息
REPLY_AFTER_LOOKBACK_SECONDS = 5

#: msg.origin 取值（企微文档）
ORIGIN_SYSTEM = 4
ORIGIN_SERVICER = 5

EVENT_SESSION_STATUS_CHANGE = "session_status_change"
EVENT_MSG_SEND_FAIL = "msg_send_fail"

_PREVIEW_LIMIT = 255
_ERROR_LIMIT = 2000


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _dt_from_seconds(value: Any) -> datetime | None:
    seconds = _as_int(value, -1)
    if seconds < 0:
        return None
    try:
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _message_content(msg: dict[str, Any]) -> tuple[str, str]:
    """返回 ``(content_type, content)``。本阶段只取文本，其它类型留空占位。"""
    msgtype = str(msg.get("msgtype") or "text")
    if msgtype == "text":
        text = msg.get("text")
        if isinstance(text, dict):
            return msgtype, str(text.get("content") or "")
        return msgtype, ""
    if msgtype == "event":
        return msgtype, ""
    return msgtype, ""


def _preview(content: str, msgtype: str) -> str:
    text = content if content else f"[{msgtype}]"
    return text[:_PREVIEW_LIMIT]


# --------------------------------------------------------------------------- #
# 通道
# --------------------------------------------------------------------------- #
async def ensure_channel(session: AsyncSession) -> ChannelAccount | None:
    """按配置里的 ``open_kfid`` 取通道，没有就建。未配置时返回 ``None``。"""
    settings = get_wecom_settings()
    if not settings.configured:
        return None

    open_kfid = settings.open_kfid.strip()
    if not open_kfid:
        return None

    channel = (
        await session.execute(
            select(ChannelAccount).where(
                ChannelAccount.channel_type == CHANNEL_TYPE,
                ChannelAccount.external_id == open_kfid,
            )
        )
    ).scalar_one_or_none()

    if channel is not None:
        # 配置里换了 corp_id 时顺手对齐，避免旧值让回调校验一直失败
        if settings.corp_id and channel.corp_id != settings.corp_id:
            channel.corp_id = settings.corp_id
            await session.commit()
        return channel

    channel = ChannelAccount(
        channel_type=CHANNEL_TYPE,
        name=CHANNEL_NAME,
        external_id=open_kfid,
        corp_id=settings.corp_id,
        reply_after=int(time.time()) - REPLY_AFTER_LOOKBACK_SECONDS,
    )
    session.add(channel)
    await session.commit()
    _log.info("已按配置创建企业微信通道 open_kfid=%s id=%s", open_kfid, channel.id)
    return channel


# --------------------------------------------------------------------------- #
# 同步
# --------------------------------------------------------------------------- #
async def sync_channel(
    session: AsyncSession,
    channel: ChannelAccount,
    client: Any,
    limit: int = 1000,
) -> dict:
    """循环拉取并落库，直到 ``has_more != 1`` 或翻满 ``MAX_PAGES`` 页。"""
    stats: dict[str, int] = {
        "pages": 0,
        "received": 0,
        "new_messages": 0,
        "customers_created": 0,
        "status_changed": 0,
        "errors": 0,
        "reply_deferred": 0,
    }

    channel_id = channel.id
    cursor = channel.cursor or ""
    sync_token = channel.sync_token or ""

    for _ in range(MAX_PAGES):
        try:
            page = await client.sync_msg(channel.external_id, cursor, sync_token, limit)
        except WeComApiError as exc:
            # 拉取失败：回滚当前事务，只把错误写进通道，游标保持上一次成功的值
            await _record_error(session, channel_id, str(exc))
            raise

        if not isinstance(page, dict):
            await _record_error(session, channel_id, "sync_msg 响应不是对象")
            raise WeComApiError("sync_msg 响应不是对象")

        stats["pages"] += 1
        msg_list = page.get("msg_list")
        if not isinstance(msg_list, list):
            msg_list = []

        try:
            for msg in msg_list:
                if not isinstance(msg, dict):
                    stats["errors"] += 1
                    continue
                await _process_message(session, channel, msg, stats)
        except Exception as exc:  # noqa: BLE001 - 落库异常一律回滚，保留旧游标
            await session.rollback()
            await _record_error(session, channel_id, f"消息落库失败（{type(exc).__name__}）")
            raise

        # 整页处理成功后才推进游标并提交
        next_cursor = page.get("next_cursor")
        if isinstance(next_cursor, str) and next_cursor:
            channel.cursor = next_cursor
            cursor = next_cursor
        next_token = page.get("token")
        if isinstance(next_token, str) and next_token:
            channel.sync_token = next_token
            sync_token = next_token

        channel.last_sync_at = _utcnow()
        channel.last_error = None
        await session.commit()

        if _as_int(page.get("has_more")) != 1:
            break

    return stats


async def _record_error(session: AsyncSession, channel_id: int | None, message: str) -> None:
    """把错误写进 ``channel.last_error``。写失败只记日志，不掩盖原始异常。"""
    if channel_id is None:  # pragma: no cover - ensure_channel 保证了 id
        return
    try:
        channel = await session.get(ChannelAccount, channel_id)
        if channel is None:  # pragma: no cover - 通道被并发删除
            return
        channel.last_error = message[:_ERROR_LIMIT]
        await session.commit()
    except Exception:  # noqa: BLE001
        _log.exception("写 channel.last_error 失败 channel_id=%s", channel_id)


# --------------------------------------------------------------------------- #
# 单条消息
# --------------------------------------------------------------------------- #
async def _process_message(
    session: AsyncSession,
    channel: ChannelAccount,
    msg: dict[str, Any],
    stats: dict[str, int],
) -> None:
    stats["received"] += 1

    # 身份校验：不是本通道的消息一律跳过（计入 errors），不影响整批
    if str(msg.get("open_kfid") or "") != channel.external_id:
        stats["errors"] += 1
        _log.warning(
            "跳过 open_kfid 不匹配的消息 channel=%s msg_kfid=%s msgid=%s",
            channel.external_id,
            msg.get("open_kfid"),
            msg.get("msgid"),
        )
        return

    open_kfid = channel.external_id
    external_userid = str(msg.get("external_userid") or "")
    origin = _as_int(msg.get("origin"))
    msgtype = str(msg.get("msgtype") or "text")
    msgid = str(msg.get("msgid") or "")
    send_time = _as_int(msg.get("send_time"), -1)
    content_type, content = _message_content(msg)

    # 事件类消息只处理副作用，不进消息表
    if msgtype == "event":
        await _handle_event(
            session,
            channel,
            msg,
            external_userid=external_userid,
            open_kfid=open_kfid,
            stats=stats,
        )
        return

    if not external_userid:
        # 没有客户标识就无法归属会话，只能丢弃
        stats["errors"] += 1
        _log.warning("消息缺少 external_userid，已跳过 msgid=%s", msgid)
        return

    customer = await _get_or_create_customer(session, channel, external_userid, stats)
    conversation = await _get_or_create_conversation(session, channel, customer, stats)

    if origin == ORIGIN_SYSTEM:
        # 系统消息（例如「客户已进入会话」）只记录事件，不入消息表
        _log.info(
            "系统消息已忽略 channel=%s user=%s msgid=%s type=%s",
            open_kfid,
            external_userid,
            msgid,
            msgtype,
        )
        return

    if origin == ORIGIN_SERVICER:
        direction, source = "outbound", "agent"
        # 接待人员亲自下场后，AI 必须让位
        if not conversation.takeover:
            conversation.takeover = True
            stats["status_changed"] += 1
    else:
        direction, source = "inbound", "customer"

    if await _message_exists(session, msgid):
        # 重复投递：计入 received，但不重复入库
        return

    if 0 <= send_time < (channel.reply_after or 0):
        # 历史消息照常入库，但不进入自动回复候选集合
        stats["reply_deferred"] += 1

    session.add(
        Message(
            conversation_id=conversation.id,
            direction=direction,
            source=source,
            content_type=content_type,
            content=content,
            external_msgid=msgid or None,
        )
    )
    # 立刻 flush：同一页内重复的 msgid 才能被上方的查重看到
    await session.flush()
    stats["new_messages"] += 1

    conversation.last_message_at = _dt_from_seconds(send_time) or _utcnow()
    conversation.last_message_preview = _preview(content, content_type)


async def _handle_event(
    session: AsyncSession,
    channel: ChannelAccount,
    msg: dict[str, Any],
    *,
    external_userid: str,
    open_kfid: str,
    stats: dict[str, int],
) -> None:
    event = msg.get("event")
    event_type = str((event or {}).get("event_type") or "") if isinstance(event, dict) else ""

    if event_type == EVENT_SESSION_STATUS_CHANGE:
        if not external_userid:
            stats["errors"] += 1
            return
        customer = await _get_or_create_customer(session, channel, external_userid, stats)
        conversation = await _get_or_create_conversation(session, channel, customer, stats)
        if not conversation.takeover:
            conversation.takeover = True
            stats["status_changed"] += 1
        _log.info(
            "会话状态变更，已置人工接待 channel=%s user=%s msgid=%s",
            open_kfid,
            external_userid,
            msg.get("msgid"),
        )
        return

    if event_type == EVENT_MSG_SEND_FAIL:
        fail_msgid = str(event.get("fail_msgid") or "") if isinstance(event, dict) else ""
        if not fail_msgid:
            stats["errors"] += 1
            return
        delivery = (
            await session.execute(
                select(Delivery).where(Delivery.external_msgid == fail_msgid).limit(1)
            )
        ).scalar_one_or_none()
        if delivery is None:
            _log.warning("发送失败事件找不到投递记录 fail_msgid=%s", fail_msgid)
            stats["errors"] += 1
            return
        delivery.status = "failed"
        delivery.blocked_reason = event_type
        delivery.updated_at = _utcnow()
        stats["status_changed"] += 1
        return

    # 其它事件（enter_session / msg_audio 等）本阶段只落 received 计数
    _log.debug(
        "未处理的事件 channel=%s user=%s msgid=%s event=%s",
        open_kfid,
        external_userid,
        msg.get("msgid"),
        event_type,
    )


async def _get_or_create_customer(
    session: AsyncSession,
    channel: ChannelAccount,
    external_userid: str,
    stats: dict[str, int],
) -> Customer:
    customer = (
        await session.execute(
            select(Customer).where(
                Customer.channel_account_id == channel.id,
                Customer.external_userid == external_userid,
            )
        )
    ).scalar_one_or_none()
    if customer is not None:
        return customer

    # 昵称/头像本阶段留空，后续再调 customer/batchget 补全
    customer = Customer(
        channel_account_id=channel.id,
        external_userid=external_userid,
        nickname=None,
        avatar=None,
    )
    session.add(customer)
    await session.flush()
    stats["customers_created"] += 1
    return customer


async def _get_or_create_conversation(
    session: AsyncSession,
    channel: ChannelAccount,
    customer: Customer,
    stats: dict[str, int],
) -> Conversation:
    conversation = (
        await session.execute(
            select(Conversation).where(
                Conversation.channel_account_id == channel.id,
                Conversation.customer_id == customer.id,
            )
        )
    ).scalar_one_or_none()
    if conversation is not None:
        return conversation

    conversation = Conversation(
        channel_account_id=channel.id,
        customer_id=customer.id,
        state="active",
        takeover=False,
    )
    session.add(conversation)
    await session.flush()
    return conversation


async def _message_exists(session: AsyncSession, msgid: str) -> bool:
    """按 ``external_msgid`` 查重。空 msgid 无法查重，交给数据库顺序插入。"""
    if not msgid:
        return False
    row = (
        await session.execute(
            select(Message.id).where(Message.external_msgid == msgid).limit(1)
        )
    ).first()
    return row is not None

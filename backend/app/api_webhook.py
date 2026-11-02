"""企业微信客服回调入口（公开路由，不走 JWT）。

企微要求 5 秒内响应，否则会重推并最终判定回调地址不可用。因此这里只做：

1. 验签 + 解密（纯本地计算，毫秒级）
2. 校验 ``ToUserName`` / ``OpenKfId`` 与配置一致
3. 按 ``sha256(raw_body)`` 写 ``webhook_events`` 去重
4. 立刻返回 ``success``
5. 真正的 ``kf/sync_msg`` 拉取交给后台任务（自建 session、异常只记日志）

回调只告诉「有新消息」，不携带消息体，所以必须再拉一次 sync_msg 才能落库。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.exc import IntegrityError

from .channels.wecom_kf.crypto import WeComCrypto, parse_callback_xml
from .channels.wecom_kf.errors import WeComApiError

__all__ = ["router"]

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhook"])

_SUCCESS = "success"
_PAYLOAD_LIMIT = 4000


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def _resolve_crypto() -> tuple[WeComCrypto | None, Any]:
    """取解密器。未配置或配置不合法时返回 ``(None, settings)``。"""
    from .channels.wecom_kf.config import get_wecom_settings

    settings = get_wecom_settings()
    if not settings.configured:
        return None, settings
    try:
        crypto = WeComCrypto(settings.callback_token, settings.encoding_aes_key, settings.corp_id)
    except ValueError:
        _log.error("企业微信回调凭证不合法（请检查 APP_WECOM_ENCODING_AES_KEY）")
        return None, settings
    return crypto, settings


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


async def _remember_event(dedupe_hash: str, payload: str, event_type: str) -> bool:
    """写回调去重记录。返回 ``True`` 表示首次出现（需要触发同步）。"""
    from .channels.wecom_kf.sync import ensure_channel
    from .db import SessionLocal
    from .models import WebhookEvent

    try:
        async with SessionLocal() as session:
            channel = await ensure_channel(session)
            session.add(
                WebhookEvent(
                    dedupe_hash=dedupe_hash,
                    channel_account_id=channel.id if channel is not None else None,
                    event_type=event_type,
                    payload=payload[:_PAYLOAD_LIMIT],
                )
            )
            await session.commit()
            return True
    except IntegrityError:
        # 唯一索引冲突 = 重复推送，直接视为已处理
        return False


async def _background_sync(channel_id: int | None = None) -> None:
    """后台跑一次全量增量同步。异常只记日志，绝不冒泡到事件循环。"""
    from .channels.wecom_kf.client import WeComClient
    from .channels.wecom_kf.config import get_wecom_settings
    from .channels.wecom_kf.sync import ensure_channel, sync_channel
    from .db import SessionLocal

    try:
        async with SessionLocal() as session:
            channel = await ensure_channel(session)
            if channel is None:
                _log.warning("回调触发的同步已跳过：企业微信未配置")
                return
            client = WeComClient(get_wecom_settings())
            try:
                stats = await sync_channel(session, channel, client)
            finally:
                await client.aclose()
            _log.info("回调触发的同步完成 channel_id=%s stats=%s", channel.id, stats)
    except Exception:  # noqa: BLE001 - 后台任务不能把异常抛给事件循环
        _log.exception("回调触发的同步失败 channel_id=%s", channel_id)


#: 持有后台任务引用，避免被 GC 提前回收
_background_tasks: set[asyncio.Task] = set()


def _spawn_background_sync(channel_id: int | None) -> None:
    task = asyncio.create_task(_background_sync(channel_id))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# --------------------------------------------------------------------------- #
# GET：URL 验证
# --------------------------------------------------------------------------- #
@router.get("/wecom", response_class=PlainTextResponse)
async def verify_url(
    msg_signature: str = Query(default=""),
    timestamp: str = Query(default=""),
    nonce: str = Query(default=""),
    echostr: str = Query(default=""),
) -> PlainTextResponse:
    crypto, _ = _resolve_crypto()
    if crypto is None:
        return PlainTextResponse("企业微信回调未配置", status_code=503)

    try:
        plain = crypto.decrypt(echostr, msg_signature, timestamp, nonce)
    except WeComApiError as exc:
        _log.warning("回调 URL 验证失败：%s", exc)
        return PlainTextResponse("invalid signature", status_code=403)

    return PlainTextResponse(plain)


# --------------------------------------------------------------------------- #
# POST：事件通知
# --------------------------------------------------------------------------- #
@router.post("/wecom", response_class=PlainTextResponse)
async def receive_callback(
    request: Request,
    msg_signature: str = Query(default=""),
    timestamp: str = Query(default=""),
    nonce: str = Query(default=""),
) -> PlainTextResponse:
    crypto, settings = _resolve_crypto()
    if crypto is None:
        return PlainTextResponse("企业微信回调未配置", status_code=503)

    raw = await request.body()

    try:
        envelope = parse_callback_xml(raw)
        encrypt = envelope.get("Encrypt") or ""
        if not encrypt:
            raise WeComApiError("回调缺少 Encrypt 字段")
        plain = crypto.decrypt(encrypt, msg_signature, timestamp, nonce)
        inner = parse_callback_xml(plain)

        to_user = (inner.get("ToUserName") or "").strip()
        open_kfid = (inner.get("OpenKfId") or "").strip()
        if to_user != settings.corp_id:
            raise WeComApiError("回调企业 ID 不匹配")
        if open_kfid and open_kfid != settings.open_kfid:
            raise WeComApiError("回调客服账号不匹配")
    except WeComApiError as exc:
        _log.warning("回调验签/解密失败：%s", exc)
        return PlainTextResponse("invalid callback", status_code=403)

    event_type = (inner.get("Event") or inner.get("MsgType") or "").strip()

    fresh = await _remember_event(_sha256(raw), plain, event_type)
    if not fresh:
        # 重复推送：不再触发同步，但仍要回 success，避免企微重试
        return PlainTextResponse(_SUCCESS)

    # 先回包再拉消息：企微的 5 秒限制比「落库完成」优先
    _spawn_background_sync(None)
    return PlainTextResponse(_SUCCESS)

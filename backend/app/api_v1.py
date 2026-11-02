"""P0 端点：登录、设备、通道。业务接口（会话/消息）在 P2 加。"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .deps import AdminUser, CurrentUser, DeviceDep, SessionDep
from .models import ChannelAccount, Device, User
from .schemas import (
    ChannelCreate,
    ChannelOut,
    ChannelStatus,
    DeviceCreate,
    DeviceCreated,
    DeviceOut,
    HeartbeatIn,
    HeartbeatOut,
    LoginRequest,
    TokenResponse,
    UserOut,
)
from .security import create_access_token, verify_password

router = APIRouter(prefix="/api/v1")


# ─────────────────────────── 认证 ───────────────────────────
@router.post("/auth/login", response_model=TokenResponse, tags=["auth"])
async def login(payload: LoginRequest, session: SessionDep) -> TokenResponse:
    user = (
        await session.execute(select(User).where(User.username == payload.username))
    ).scalar_one_or_none()
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")
    token, expires_in = create_access_token(str(user.id), {"role": user.role, "username": user.username})
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.get("/auth/me", response_model=UserOut, tags=["auth"])
async def me(user: CurrentUser) -> User:
    return user


# ─────────────────────────── 设备 ───────────────────────────
@router.get("/devices", response_model=list[DeviceOut], tags=["devices"])
async def list_devices(user: CurrentUser, session: SessionDep) -> list[Device]:
    rows = (await session.execute(select(Device).order_by(Device.id.desc()))).scalars().all()
    return list(rows)


@router.post("/devices", response_model=DeviceCreated, status_code=201, tags=["devices"])
async def create_device(payload: DeviceCreate, admin: AdminUser, session: SessionDep) -> Device:
    exists = (
        await session.execute(select(Device).where(Device.device_code == payload.device_code))
    ).scalar_one_or_none()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "device_code 已存在")
    device = Device(
        device_code=payload.device_code,
        name=payload.name or payload.device_code,
        device_token="dt_" + secrets.token_urlsafe(24),
        status="offline",
    )
    session.add(device)
    await session.commit()
    await session.refresh(device)
    return device


@router.get("/devices/{device_code}", response_model=DeviceOut, tags=["devices"])
async def get_device(device_code: str, user: CurrentUser, session: SessionDep) -> Device:
    device = (
        await session.execute(select(Device).where(Device.device_code == device_code))
    ).scalar_one_or_none()
    if not device:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "设备不存在")
    return device


@router.post("/devices/{device_code}/heartbeat", response_model=HeartbeatOut, tags=["devices"])
async def heartbeat(
    device_code: str, payload: HeartbeatIn, device: DeviceDep, session: SessionDep
) -> HeartbeatOut:
    if device.device_code != device_code:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "设备 Token 与路径不匹配")
    device.status = "online"
    device.agent_version = payload.agent_version
    device.last_heartbeat_at = datetime.now(timezone.utc)
    await session.commit()
    return HeartbeatOut(server_time=datetime.now(timezone.utc))


# ─────────────────────────── 通道 ───────────────────────────
@router.get("/channels", response_model=list[ChannelOut], tags=["channels"])
async def list_channels(user: CurrentUser, session: SessionDep) -> list[ChannelAccount]:
    rows = (await session.execute(select(ChannelAccount).order_by(ChannelAccount.id))).scalars().all()
    return list(rows)


@router.post("/channels", response_model=ChannelOut, status_code=201, tags=["channels"])
async def create_channel(
    payload: ChannelCreate, admin: AdminUser, session: SessionDep
) -> ChannelAccount:
    if not payload.external_id.startswith("wk"):
        raise HTTPException(422, "open_kfid 应以 wk 开头")
    dup = (
        await session.execute(
            select(ChannelAccount).where(ChannelAccount.external_id == payload.external_id)
        )
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, "该客服账号已存在")
    channel = ChannelAccount(
        device_id=payload.device_id,
        channel_type="wecom_kf",
        name=payload.name,
        external_id=payload.external_id,
        corp_id=payload.corp_id,
    )
    session.add(channel)
    await session.commit()
    await session.refresh(channel)
    return channel


@router.get("/channels/{channel_id}/status", response_model=ChannelStatus, tags=["channels"])
async def channel_status(channel_id: int, admin: AdminUser, session: SessionDep) -> ChannelStatus:
    channel = await session.get(ChannelAccount, channel_id)
    if not channel:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "通道不存在")
    # P0：真正的就绪判断在 P1 接上企微凭证后实现，这里先给出结构
    blocked = None
    if channel.status != "enabled":
        blocked = "通道未启用"
    return ChannelStatus(
        id=channel.id,
        name=channel.name,
        external_id=channel.external_id,
        status=channel.status,
        cursor_set=bool(channel.cursor),
        last_sync_at=channel.last_sync_at,
        last_error=channel.last_error,
        auto_reply_ready=blocked is None,
        blocked_reason=blocked,
    )


@router.post("/channels/{channel_id}/sync", tags=["channels"])
async def sync_channel_now(channel_id: int, admin: AdminUser, session: SessionDep) -> dict:
    """手动拉一轮消息。回调没配好时，这是唯一能验证凭证是否正确的手段。"""
    from .channels.wecom_kf.client import WeComClient
    from .channels.wecom_kf.config import get_wecom_settings
    from .channels.wecom_kf.errors import WeComApiError
    from .channels.wecom_kf.sync import sync_channel

    wecom = get_wecom_settings()
    if not wecom.configured:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"message": "企业微信未配置", "missing": wecom.missing},
        )

    channel = await session.get(ChannelAccount, channel_id)
    if not channel:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "通道不存在")
    if channel.external_id != wecom.open_kfid:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"该通道 open_kfid={channel.external_id} 与当前配置 {wecom.open_kfid} 不一致",
        )

    client = WeComClient(wecom)
    try:
        return await sync_channel(session, channel, client)
    except WeComApiError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    finally:
        await client.aclose()

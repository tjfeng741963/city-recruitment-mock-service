"""依赖注入：数据库会话、当前用户、管理员校验、设备自证。"""

from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import Device, User
from .security import decode_token

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(
    session: SessionDep, authorization: Annotated[str | None, Header()] = None
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "缺少 Bearer Token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token 已过期") from None
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token 无效") from None
    user_id = int(payload.get("sub", 0))
    user = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户不存在或已禁用")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def require_admin(user: CurrentUser) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "需要管理员权限")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


async def get_device_by_token(
    session: SessionDep, x_device_token: Annotated[str | None, Header()] = None
) -> Device:
    if not x_device_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "缺少 X-Device-Token")
    device = (
        await session.execute(select(Device).where(Device.device_token == x_device_token))
    ).scalar_one_or_none()
    if not device:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "设备 Token 无效")
    if device.status == "disabled":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "设备已停用")
    return device


DeviceDep = Annotated[Device, Depends(get_device_by_token)]

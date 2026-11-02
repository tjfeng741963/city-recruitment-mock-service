"""数据库装配：async engine + session 依赖 + 建表与种子数据。"""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from .models import Base, User
from .security import hash_password
from .settings import settings

# SQLite 需要目录存在；Postgres 不需要但无副作用
if settings.database_url.startswith("sqlite"):
    Path("data").mkdir(exist_ok=True)

# SQLite 用 NullPool：避免连接被绑定到某个事件循环后，在另一个循环里复用报 OSError。
# （pytest 每个用例一个事件循环，不关掉池会踩这个坑；Sqlite 本身也不需要连接池。）
_engine_kwargs: dict = {"echo": settings.sql_echo, "future": True}
if settings.database_url.startswith("sqlite"):
    _engine_kwargs["poolclass"] = NullPool

engine = create_async_engine(settings.database_url, **_engine_kwargs)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def seed_admin() -> str | None:
    """用户表为空时建一个管理员，返回随机生成的初始密码（若用了默认值则返回 None）。"""
    async with SessionLocal() as session:
        existing = (await session.execute(select(User).limit(1))).scalar_one_or_none()
        if existing:
            return None
        password = settings.seed_admin_password
        generated = None
        if password in ("", "random"):
            generated = secrets.token_urlsafe(12)
            password = generated
        session.add(
            User(
                username=settings.seed_admin_username,
                password_hash=hash_password(password),
                display_name="管理员",
                role="admin",
            )
        )
        await session.commit()
        return generated

"""FastAPI 装配入口。"""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api_v1 import router as api_v1
from .api_v1_conversations import router as conversations_router
from .api_webhook import router as webhook_router
from .db import init_db, seed_admin
from .settings import settings
from .ws.hub import router as ws_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    generated = await seed_admin()
    if generated:
        print(f"[seed] 已创建管理员 {settings.seed_admin_username}，初始密码：{generated}")
    print(f"[boot] env={settings.env} db={settings.database_url}")

    worker_task: asyncio.Task | None = None
    sync_task: asyncio.Task | None = None
    if settings.outbox_worker:
        from .workers.outbox import run_forever

        worker_task = asyncio.create_task(run_forever(settings.outbox_interval))
        print(f"[boot] 发件箱 worker 已启动，间隔 {settings.outbox_interval}s")

    if settings.sync_worker:
        from .channels.wecom_kf.config import get_wecom_settings
        from .workers.wecom_sync import run_forever as sync_forever

        if get_wecom_settings().configured:
            sync_task = asyncio.create_task(sync_forever(settings.sync_interval))
            print(f"[boot] 企微同步 worker 已启动，间隔 {settings.sync_interval}s")
        else:
            print("[boot] 企微未配置，同步 worker 未启动")

    try:
        yield
    finally:
        for task in (worker_task, sync_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


app = FastAPI(
    title="城市招聘 · 企业微信后端",
    version="0.2.0",
    description=(
        "企业微信客服单通道 + 多端客户端。\n\n"
        "- 认证 / 设备 / 通道：`/api/v1/*`\n"
        "- 会话 / 消息 / 客户：`/api/v1/*`\n"
        "- 企微回调：`/webhooks/wecom`（公开，验签）\n"
        "- 实时推送：`ws://<host>/ws?token=<JWT>`\n"
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_v1)
app.include_router(conversations_router)
app.include_router(webhook_router)
app.include_router(ws_router)


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict:
    from .ws.hub import hub

    return {
        "ok": True,
        "env": settings.env,
        "version": app.version,
        "ws": hub.stats(),
    }

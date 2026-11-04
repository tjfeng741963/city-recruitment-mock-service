"""FastAPI 装配入口。"""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api_v1 import router as api_v1
from .api_v1_conversations import router as conversations_router
from .api_agent import router as agent_router
from .api_kb import router as api_kb_router
from .api_lead import router as lead_router
from .api_webhook import router as webhook_router
from .db import init_db, seed_admin
from . import instance
from .settings import settings
from .ws.hub import router as ws_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    generated = await seed_admin()
    if generated:
        print(f"[seed] 已创建管理员 {settings.seed_admin_username}，初始密码：{generated}")
    info = instance.load_or_create()
    print(f"[boot] install_id={info['install_id']}")
    print(f"[boot] env={settings.env} db={settings.database_url}")
    _ensure_service_token()

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


def _ensure_service_token() -> None:
    """服务间令牌：没有就生成一个写进共享卷，供 Node 侧读取。

    为什么不手工在两处填同一个密钥：那需要在服务器上改两个 env 文件、
    还要保证两边一致，容易出错。这里让 Python 生成，Node 读同一个文件。

    已存在就沿用——重启不换令牌，免得 Node 拿到旧值。
    目录不可写（例如本地开发）就静默跳过，此时服务间调用不可用，
    但用户令牌路径照常工作。
    """
    import os
    import secrets
    from pathlib import Path

    if settings.kb_service_token:
        return  # 显式配置优先
    path = Path(settings.kb_service_token_file)
    try:
        if path.exists() and path.read_text().strip():
            settings.kb_service_token = path.read_text().strip()
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        token = secrets.token_hex(32)
        path.write_text(token + "\n", encoding="utf-8")
        os.chmod(path, 0o444)
        settings.kb_service_token = token
        print(f"[boot] 已生成服务令牌 -> {path}")
    except OSError:
        print(f"[boot] 服务令牌不可用（{path} 不可写），服务间调用关闭")


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
app.include_router(agent_router)
app.include_router(api_kb_router)
app.include_router(webhook_router)
app.include_router(lead_router)
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


@app.get("/api/v1/instance", tags=["ops"])
async def instance_info() -> dict:
    """实例身份（公开）。

    首次启动向导要能读到，所以不要求登录。
    只有 install_id 这类标识，不含任何配置或密钥。
    """
    return instance.public_view()

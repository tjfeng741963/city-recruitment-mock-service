"""测试公共夹具。

注意两点：
1. 环境变量必须在 import app.* 之前设置，因为 app.settings 是模块级单例。
2. 数据库文件从 APP_DATABASE_URL 推导，多个智能体/多个测试文件并行跑时
   用 `APP_DATABASE_URL=sqlite+aiosqlite:///./data/test_xxx.db` 隔离，互不干扰。
"""

from __future__ import annotations

import os
import pathlib

_DB_URL = os.environ.setdefault("APP_DATABASE_URL", "sqlite+aiosqlite:///./data/test.db")
os.environ.setdefault("APP_JWT_SECRET", "test-secret")
os.environ.setdefault("APP_SEED_ADMIN_USERNAME", "local-admin")
os.environ.setdefault("APP_SEED_ADMIN_PASSWORD", "local-demo-only")

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

TEST_DB = pathlib.Path(_DB_URL.split("///")[-1])


@pytest.fixture(scope="session", autouse=True)
def clean_test_db():
    TEST_DB.parent.mkdir(parents=True, exist_ok=True)
    if TEST_DB.exists():
        TEST_DB.unlink()
    yield
    if TEST_DB.exists():
        TEST_DB.unlink()


@pytest.fixture(autouse=True)
def _isolate_device_meta(monkeypatch):
    """接口测试不碰 4222 的 config 接口：设备 meta 一律回空（通配）。

    专门测 fetch_device_meta 的用例在测试体里自行 monkeypatch _fetch_meta，
    会覆盖这里的默认值。
    """
    from app.services import device_scripts

    async def no_meta(device_code: str, token: str, url: str) -> dict:
        # 知识库 v3 起 meta 还带品类/招工方 id；默认不绑（0），走通用问答
        return {"factory_name": "", "city": "", "vertical_id": 0, "employer_id": 0}

    monkeypatch.setattr(device_scripts, "_fetch_meta", no_meta)
    device_scripts.clear_cache()
    yield
    device_scripts.clear_cache()


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    from app.db import init_db, seed_admin
    from app.main import app

    await init_db()
    await seed_admin()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def admin_client(client: AsyncClient) -> AsyncClient:
    resp = await client.post(
        "/api/v1/auth/login",
        json={"username": "local-admin", "password": "local-demo-only"},
    )
    assert resp.status_code == 200, resp.text
    client.headers["Authorization"] = f"Bearer {resp.json()['access_token']}"
    return client

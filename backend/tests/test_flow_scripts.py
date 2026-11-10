"""flow 串接测试：jobs 数据源切换 + config 话术命中（mock 网络，不打真请求）。

数据源优先级：config.scripts 命中 → 整段直发不过模型；
未命中 → 4222 真实岗位优先 → DEMO_JOBS 回落。
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.services import device_scripts, job_lookup
from app.services.flow_engine import set_remote_jobs

pytestmark = pytest.mark.asyncio

REMOTE_JOBS = [
    {
        "factory_name": "观澜精密厂",
        "job_title": "观澜精密厂 质检",
        "wage_text": "23 元/小时",
        "hours_text": "两班倒，月休 4 天",
        "age_text": "18-40 岁",
        "welfare_text": "包吃包住",
        "place": "观澜大道 88 号",
    }
]


class ProviderProbe:
    """记录模型调用次数：config 话术命中时一次都不许调。"""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *args, **kwargs):  # noqa: ANN002, ANN003
        self.calls += 1
        raise RuntimeError("这段不该调模型")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch) -> None:  # noqa: ANN001
    """接口测试不碰真模型也不碰真网络。"""
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    yield
    job_lookup.clear_cache()  # 缓存是模块级的，别泄漏给后面的测试
    device_scripts.clear_cache()
    set_remote_jobs({})


async def _say(client: AsyncClient, key: str, text: str, **extra) -> dict:
    resp = await client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": text, **extra}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_send_info_uses_remote_jobs(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    async def fake_fetch(city: str, token: str, url: str) -> list[dict]:
        assert city == "深圳"
        return REMOTE_JOBS

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    info = await _say(admin_client, key, "深圳")

    # 段1 报的是 4222 的真实厂名/工价，不是 DEMO 数据
    assert "观澜精密厂" in info["reply"]
    assert "23 元/小时" in info["reply"]
    assert info["stage"] == "ask_interview"


async def test_send_info_falls_back_to_demo_jobs_on_failure(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("4222 down")

    monkeypatch.setattr(job_lookup, "_fetch_items", boom)
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    info = await _say(admin_client, key, "深圳")

    assert "龙华电子厂" in info["reply"]  # DEMO_JOBS 兜底
    assert info["stage"] == "ask_interview"


async def test_config_script_hit_bypasses_model(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    async def no_jobs(*args, **kwargs):  # noqa: ANN002, ANN003
        return []  # 岗位接口空 → 用 DEMO 数据填占位符

    monkeypatch.setattr(job_lookup, "_fetch_items", no_jobs)

    scripts = [
        {
            "stage": "send_info",
            "city": "深圳",
            "title": "龙华厂标准介绍",
            "content": "{{factory}}在招人，工价{{wage}}，面试地点{{place}}，时间{{window}}，过来看看？",
        }
    ]

    async def fake_scripts(device_code: str, token: str, url: str) -> list[dict]:
        assert device_code == "pc-office-07"
        return scripts

    monkeypatch.setattr(device_scripts, "_fetch_scripts", fake_scripts)

    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")

    probe = ProviderProbe()
    monkeypatch.setattr("app.api_flow.build_provider", lambda: probe)
    info = await _say(admin_client, key, "深圳", device_code="pc-office-07")

    # 整段直接作 parts，占位符已替换成岗位事实（DEMO 深圳 0 号岗）
    assert info["parts"] == [
        "龙华电子厂在招人，工价20 元/小时，面试地点龙华大浪街道，时间09:00-11:00，过来看看？"
    ]
    assert info["reply"] == info["parts"][0]
    assert info["stage"] == "ask_interview"
    assert probe.calls == 0  # 不过模型


async def test_config_script_miss_uses_original_logic(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    async def no_scripts(*args, **kwargs):  # noqa: ANN002, ANN003
        return []

    async def no_jobs(*args, **kwargs):  # noqa: ANN002, ANN003
        return []

    monkeypatch.setattr(device_scripts, "_fetch_scripts", no_scripts)
    monkeypatch.setattr(job_lookup, "_fetch_items", no_jobs)

    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    info = await _say(admin_client, key, "深圳")

    # 未命中 → 原逻辑：代码拼三段（厂名/工价/吃住 + 地点时间 + 邀约问句）
    assert "厂名：" in info["parts"][0] and "龙华电子厂" in info["parts"][0]
    assert any("这两天能不能过来面试" in part for part in info["parts"])
    assert info["stage"] == "ask_interview"


async def test_script_only_applies_to_send_info_turn(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    """邀约/收集阶段不该再发 send_info 话术。"""
    scripts = [
        {"stage": "send_info", "city": "深圳", "content": "话术整段"}
    ]

    async def fake_scripts(*args, **kwargs):  # noqa: ANN002, ANN003
        return scripts

    async def no_jobs(*args, **kwargs):  # noqa: ANN002, ANN003
        return []

    monkeypatch.setattr(device_scripts, "_fetch_scripts", fake_scripts)
    monkeypatch.setattr(job_lookup, "_fetch_items", no_jobs)

    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")  # 发信息轮：命中话术
    asked = await _say(admin_client, key, "可以")

    assert asked["stage"] == "collect"
    assert "话术整段" not in asked["reply"]

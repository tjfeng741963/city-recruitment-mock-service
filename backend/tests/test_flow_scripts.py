"""flow 串接测试：jobs 数据源切换 + config 话术命中（mock 网络，不打真请求）。

数据源优先级：config.scripts 命中 → 整段直发不过模型；
未命中 → 4222 注入的远端岗位；城市查不到岗位 → 「已记下，帮你问问」。
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


async def test_send_info_without_jobs_says_will_ask(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    """4222 挂了/查不到岗位：不编岗位，走「已记下，帮你问问」并记未知问题。"""
    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("4222 down")

    monkeypatch.setattr(job_lookup, "_fetch_items", boom)
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    info = await _say(admin_client, key, "深圳")

    assert "已记下" in info["reply"] and "帮你问问" in info["reply"]
    assert info["stage"] == "ask_city"
    # 不许出现编造的岗位事实
    assert "龙华电子厂" not in info["reply"] and "元/小时" not in info["reply"]


async def test_config_script_feeds_model_as_material(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    async def remote_jobs(city: str, token: str, url: str) -> list[dict]:
        return REMOTE_JOBS  # 岗位接口返回远端真实岗位 → 填占位符

    monkeypatch.setattr(job_lookup, "_fetch_items", remote_jobs)

    scripts = [
        {
            "stage": "send_info",
            "city": "深圳",
            "title": "观澜厂标准介绍",
            "content": "{{factory}}在招人，工价{{wage}}，面试地点{{place}}，时间{{window}}，过来看看？",
        }
    ]

    async def fake_scripts(device_code: str, token: str, url: str) -> list[dict]:
        assert device_code == "pc-office-07"
        return scripts

    monkeypatch.setattr(device_scripts, "_fetch_scripts", fake_scripts)

    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")

    # 新契约：话术作为素材进模型（模型可见占位符替换后的完整事实文本）
    seen_material: list[str] = []

    class MaterialProbe:
        def __init__(self) -> None:
            self.calls = 0

        async def complete(self, messages, *args, **kwargs):  # noqa: ANN002, ANN003
            self.calls += 1
            for m in messages if isinstance(messages, list) else []:
                body = str(m.get("content", "")) if isinstance(m, dict) else str(m)
                if "观澜精密厂" in body:
                    seen_material.append(body)
            return {
                "reply": "观澜精密厂在招人，工价23 元/小时，过来看看？",
                "stage": "send_info",
                "slots": {"city": "深圳"},
                "action": None,
            }

    probe = MaterialProbe()
    monkeypatch.setattr("app.api_flow.build_provider", lambda: probe)
    info = await _say(admin_client, key, "深圳", device_code="pc-office-07")

    # 模型被调用且素材里含渲染后的岗位事实
    assert probe.calls == 1
    assert seen_material, "话术素材没有进模型上下文"
    # 回复来自模型；stage 语义保持：已发岗位+邀约 → ask_interview
    assert info["stage"] == "ask_interview"
    assert "观澜精密厂" in info["reply"]


async def test_config_script_miss_uses_original_logic(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    async def no_scripts(*args, **kwargs):  # noqa: ANN002, ANN003
        return []

    async def remote_jobs(*args, **kwargs):  # noqa: ANN002, ANN003
        return REMOTE_JOBS

    monkeypatch.setattr(device_scripts, "_fetch_scripts", no_scripts)
    monkeypatch.setattr(job_lookup, "_fetch_items", remote_jobs)

    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    info = await _say(admin_client, key, "深圳")

    # 未命中 → 原逻辑：代码拼三段（厂名/工价/吃住 + 地点时间 + 邀约问句）
    assert "厂名：" in info["parts"][0] and "观澜精密厂" in info["parts"][0]
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

    async def remote_jobs(*args, **kwargs):  # noqa: ANN002, ANN003
        return REMOTE_JOBS

    monkeypatch.setattr(device_scripts, "_fetch_scripts", fake_scripts)
    monkeypatch.setattr(job_lookup, "_fetch_items", remote_jobs)

    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")  # 发信息轮：命中话术
    asked = await _say(admin_client, key, "可以")

    assert asked["stage"] == "collect"
    assert "话术整段" not in asked["reply"]

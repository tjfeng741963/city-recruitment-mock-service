"""device_scripts：按设备拉 config 话术 + 三级匹配 + 占位符渲染（mock 网络）。"""

from __future__ import annotations

import httpx
import pytest

from app.services import device_scripts

TOKEN = "test-profile-token"
SCRIPTS = [
    {"stage": "send_info", "city": "深圳", "title": "龙华厂标准介绍", "content": "A"},
    {"stage": "send_info", "city": "", "title": "通用介绍", "content": "B"},
    {"stage": "ask_interview", "city": "", "title": "邀约", "content": "C"},
]


@pytest.fixture(autouse=True)
def _reset(monkeypatch) -> None:  # noqa: ANN001
    device_scripts.clear_cache()
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", TOKEN)
    monkeypatch.delenv("FLOW_CONFIG_URL", raising=False)
    yield
    device_scripts.clear_cache()  # 缓存是模块级的，别泄漏给后面的测试


async def test_fetch_scripts_returns_items(monkeypatch) -> None:  # noqa: ANN001
    async def fake_fetch(device_code: str, token: str, url: str) -> list[dict]:
        assert device_code == "pc-office-05" and token == TOKEN
        assert "/bridge/devices/pc-office-05/config" in url
        return SCRIPTS

    monkeypatch.setattr(device_scripts, "_fetch_scripts", fake_fetch)
    assert await device_scripts.fetch_scripts("pc-office-05") == SCRIPTS


async def test_fetch_scripts_failure_returns_empty(monkeypatch) -> None:  # noqa: ANN001
    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise httpx.ConnectError("down")

    monkeypatch.setattr(device_scripts, "_fetch_scripts", boom)
    assert await device_scripts.fetch_scripts("pc-office-05") == []


async def test_fetch_scripts_without_token(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "")

    async def forbidden(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("token 为空就不该发请求")

    monkeypatch.setattr(device_scripts, "_fetch_scripts", forbidden)
    assert await device_scripts.fetch_scripts("pc-office-05") == []


async def test_fetch_scripts_cache_within_ttl(monkeypatch) -> None:  # noqa: ANN001
    calls: list[str] = []

    async def fake_fetch(device_code: str, token: str, url: str) -> list[dict]:
        calls.append(device_code)
        return SCRIPTS

    monkeypatch.setattr(device_scripts, "_fetch_scripts", fake_fetch)
    await device_scripts.fetch_scripts("pc-office-05")
    await device_scripts.fetch_scripts("pc-office-05")
    assert calls == ["pc-office-05"]  # 60s 内只发一次请求


def test_pick_script_prefers_exact_city() -> None:
    script = device_scripts.pick_script(SCRIPTS, "send_info", "深圳")
    assert script is not None and script["content"] == "A"


def test_pick_script_falls_back_to_blank_city() -> None:
    script = device_scripts.pick_script(SCRIPTS, "send_info", "东莞")
    assert script is not None and script["content"] == "B"


def test_pick_script_matches_stage_only() -> None:
    script = device_scripts.pick_script(SCRIPTS, "ask_interview", "深圳")
    assert script is not None and script["content"] == "C"


def test_pick_script_no_match() -> None:
    assert device_scripts.pick_script(SCRIPTS, "collect", "深圳") is None
    assert device_scripts.pick_script([], "send_info", "深圳") is None


def test_render_script_replaces_placeholders() -> None:
    job = {
        "factory_name": "龙华电子厂",
        "wage_text": "20 元/小时",
        "place": "龙华大浪街道",
    }
    raw = "{{factory}}工价{{wage}}，地点{{place}}，时间{{window}}"
    rendered = device_scripts.render_script(raw, job)
    # 替换前：占位符还在；替换后：全部变成岗位事实
    assert rendered == "龙华电子厂工价20 元/小时，地点龙华大浪街道，时间09:00-11:00"


def test_render_script_missing_job_fields_go_empty() -> None:
    rendered = device_scripts.render_script("厂{{factory}}/价{{wage}}", {})
    assert rendered == "厂/价"  # 不许把 {{x}} 发给客户

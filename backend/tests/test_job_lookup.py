"""job_lookup：按城市查 4222 真实岗位（mock 网络，不打真请求）。"""

from __future__ import annotations

import httpx
import pytest

from app.services import job_lookup

TOKEN = "test-profile-token"
JOBS = [
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


@pytest.fixture(autouse=True)
def _reset(monkeypatch) -> None:  # noqa: ANN001
    job_lookup.clear_cache()
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", TOKEN)
    monkeypatch.delenv("FLOW_JOBS_URL", raising=False)
    yield
    job_lookup.clear_cache()  # 缓存是模块级的，别泄漏给后面的测试


async def test_lookup_returns_remote_items(monkeypatch) -> None:  # noqa: ANN001
    calls: list[str] = []

    async def fake_fetch(city: str, token: str, url: str) -> list[dict]:
        calls.append(city)
        assert token == TOKEN
        return JOBS

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    assert await job_lookup.lookup_jobs("深圳") == JOBS
    assert calls == ["深圳"]


async def test_lookup_empty_without_token(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "")

    async def forbidden(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("token 为空就不该发请求")

    monkeypatch.setattr(job_lookup, "_fetch_items", forbidden)
    assert await job_lookup.lookup_jobs("深圳") == []


async def test_lookup_failure_returns_empty(monkeypatch) -> None:  # noqa: ANN001
    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(job_lookup, "_fetch_items", boom)
    assert await job_lookup.lookup_jobs("深圳") == []


async def test_cache_hits_within_ttl(monkeypatch) -> None:  # noqa: ANN001
    calls: list[str] = []

    async def fake_fetch(city: str, token: str, url: str) -> list[dict]:
        calls.append(city)
        return JOBS

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    assert await job_lookup.lookup_jobs("深圳") == JOBS
    assert await job_lookup.lookup_jobs("深圳") == JOBS
    assert await job_lookup.lookup_jobs("深圳") == JOBS
    assert calls == ["深圳"]  # 60s 内只发一次请求


async def test_failure_is_cached_too(monkeypatch) -> None:  # noqa: ANN001
    calls: list[str] = []

    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        calls.append("x")
        raise httpx.ConnectError("down")

    monkeypatch.setattr(job_lookup, "_fetch_items", boom)
    assert await job_lookup.lookup_jobs("深圳") == []
    assert await job_lookup.lookup_jobs("深圳") == []
    assert len(calls) == 1  # 4222 挂了也别每个请求都白等 3s


async def test_request_carries_city_and_token(monkeypatch) -> None:  # noqa: ANN001
    """真 URL 拼装走一遍 MockTransport：city 参数 + X-Profile-Token 头。"""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get("X-Profile-Token")
        return httpx.Response(200, json={"items": JOBS})

    real_client = job_lookup.httpx.AsyncClient

    def client_factory(**kwargs):  # noqa: ANN003
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(job_lookup.httpx, "AsyncClient", client_factory)
    items = await job_lookup.lookup_jobs("深圳")
    assert items == JOBS
    assert seen["url"].startswith("http://127.0.0.1:4222/api/v1/agent/jobs?")
    assert "city=%E6%B7%B1%E5%9C%B3" in seen["url"]
    assert seen["token"] == TOKEN


# ── job_scope：按设备的岗位口径（网页可远程切换）────────────────────────────

MIXED_JOBS = [
    {
        "factory_name": "广州地铁安检",
        "job_title": "广州地铁安检 安全员",
        "wage_text": "22 元/小时",
        "hours_text": "8 小时",
        "welfare_text": "包吃住",
        "place": "体育西路站",
    },
    {
        "factory_name": "观澜精密厂",
        "job_title": "观澜精密厂 质检",
        "wage_text": "23 元/小时",
        "hours_text": "两班倒",
        "welfare_text": "包吃包住",
        "place": "观澜大道 88 号",
    },
]


def _patch_items(monkeypatch, items):  # noqa: ANN001
    async def fake_fetch(city: str, token: str, url: str) -> list[dict]:
        return list(items)

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)


async def test_only_subway_filters_factory_jobs(monkeypatch) -> None:  # noqa: ANN001
    _patch_items(monkeypatch, MIXED_JOBS)
    result = await job_lookup.lookup_jobs("广州", only_subway=True)
    assert [j["factory_name"] for j in result] == ["广州地铁安检"]


async def test_all_scope_keeps_factory_jobs(monkeypatch) -> None:  # noqa: ANN001
    _patch_items(monkeypatch, MIXED_JOBS)
    result = await job_lookup.lookup_jobs("广州", only_subway=False)
    assert [j["factory_name"] for j in result] == ["广州地铁安检", "观澜精密厂"]


async def test_none_follows_env_default_and_keeps_compat(monkeypatch) -> None:  # noqa: ANN001
    _patch_items(monkeypatch, MIXED_JOBS)
    monkeypatch.setenv("FLOW_ONLY_SUBWAY", "1")
    assert len(await job_lookup.lookup_jobs("广州")) == 1
    job_lookup.clear_cache()
    monkeypatch.setenv("FLOW_ONLY_SUBWAY", "0")
    assert len(await job_lookup.lookup_jobs("广州")) == 2


async def test_subway_scope_falls_back_to_all_when_no_subway_jobs(monkeypatch) -> None:  # noqa: ANN001
    # 防呆：关键词漏配时不能一条岗位都不推
    _patch_items(monkeypatch, [MIXED_JOBS[1]])
    result = await job_lookup.lookup_jobs("广州", only_subway=True)
    assert [j["factory_name"] for j in result] == ["观澜精密厂"]


async def test_cache_is_keyed_by_scope(monkeypatch) -> None:  # noqa: ANN001
    # 同一城市两种口径缓存必须分开，否则先查 subway 会把工厂岗漏给 all 号
    _patch_items(monkeypatch, MIXED_JOBS)
    assert len(await job_lookup.lookup_jobs("广州", only_subway=True)) == 1
    assert len(await job_lookup.lookup_jobs("广州", only_subway=False)) == 2

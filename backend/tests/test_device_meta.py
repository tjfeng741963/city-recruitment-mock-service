"""fetch_device_meta：拉设备绑定的工厂/城市（mock 网络，不打真请求）。

契约 docs/对齐-设备工厂绑定与资料导入.md §2：
任何失败回空值（通配），60s 缓存与 fetch_scripts 同款。
"""

from __future__ import annotations

import pytest

from app.services import device_scripts

pytestmark = pytest.mark.asyncio

META = {"factory_name": "松下万宝(广州)压缩机有限公司", "city": "广州"}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.delenv("FLOW_PROFILE_TOKEN", raising=False)
    monkeypatch.delenv("FLOW_CONFIG_URL", raising=False)
    device_scripts.clear_cache()
    yield
    device_scripts.clear_cache()  # 缓存是模块级的，别泄漏给后面的测试


async def test_returns_factory_and_city(monkeypatch) -> None:  # noqa: ANN001
    captured: dict = {}

    async def fake_fetch(device_code: str, token: str, url: str) -> dict:
        captured.update({"device_code": device_code, "token": token, "url": url})
        return META

    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok-meta")
    monkeypatch.setattr(device_scripts, "_fetch_meta", fake_fetch)
    assert await device_scripts.fetch_device_meta("pc-win-01") == META
    assert captured == {
        "device_code": "pc-win-01",
        "token": "tok-meta",
        # {device_code} 占位符按现有 fetch_scripts 的拼法替换
        "url": device_scripts.DEFAULT_CONFIG_URL.format(device_code="pc-win-01"),
    }


async def test_failure_falls_back_to_empty(monkeypatch) -> None:  # noqa: ANN001
    """4222 挂了 → 空 meta（通配），流程不中断。"""

    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("4222 down")

    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok-meta")
    monkeypatch.setattr(device_scripts, "_fetch_meta", boom)
    # 用 EMPTY_META 本身比对：以后加字段（vertical_id / employer_id / position_id…）
    # 不用再改这三处断言，只有「失败要回空」这个语义是关键
    assert await device_scripts.fetch_device_meta("pc-win-01") == dict(device_scripts.EMPTY_META)


async def test_no_token_means_no_request(monkeypatch) -> None:  # noqa: ANN001
    called: list = []

    async def spy(*args, **kwargs):  # noqa: ANN002, ANN003
        called.append(args)
        return META

    monkeypatch.setattr(device_scripts, "_fetch_meta", spy)
    # 用 EMPTY_META 本身比对：以后加字段（vertical_id / employer_id / position_id…）
    # 不用再改这三处断言，只有「失败要回空」这个语义是关键
    assert await device_scripts.fetch_device_meta("pc-win-01") == dict(device_scripts.EMPTY_META)
    assert called == []


async def test_cache_hits_within_ttl(monkeypatch) -> None:  # noqa: ANN001
    calls: list = []

    async def fake_fetch(*args, **kwargs):  # noqa: ANN002, ANN003
        calls.append(args)
        return META

    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok-meta")
    monkeypatch.setattr(device_scripts, "_fetch_meta", fake_fetch)
    assert await device_scripts.fetch_device_meta("pc-win-01") == META
    assert await device_scripts.fetch_device_meta("pc-win-01") == META
    assert await device_scripts.fetch_device_meta("pc-win-01") == META
    assert len(calls) == 1  # 60s 内只打一次
    # 缓存按设备号分开
    assert await device_scripts.fetch_device_meta("pc-win-02") == META
    assert len(calls) == 2


async def test_cache_expires(monkeypatch) -> None:  # noqa: ANN001
    calls: list = []

    async def fake_fetch(*args, **kwargs):  # noqa: ANN002, ANN003
        calls.append(args)
        return META

    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok-meta")
    monkeypatch.setattr(device_scripts, "_fetch_meta", fake_fetch)
    assert await device_scripts.fetch_device_meta("pc-win-01") == META
    device_scripts._meta_cache["pc-win-01"] = (
        device_scripts.time.monotonic() - 1,
        META,
    )  # 人为过期
    assert await device_scripts.fetch_device_meta("pc-win-01") == META
    assert len(calls) == 2


async def test_empty_device_code_skips_request() -> None:
    assert await device_scripts.fetch_device_meta("") == dict(device_scripts.EMPTY_META)

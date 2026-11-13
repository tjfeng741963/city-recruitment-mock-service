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
    assert await device_scripts.fetch_device_meta("pc-win-01") == {
        "factory_name": "",
        "city": "",
        "job_scope": "",
    }


async def test_no_token_means_no_request(monkeypatch) -> None:  # noqa: ANN001
    called: list = []

    async def spy(*args, **kwargs):  # noqa: ANN002, ANN003
        called.append(args)
        return META

    monkeypatch.setattr(device_scripts, "_fetch_meta", spy)
    assert await device_scripts.fetch_device_meta("pc-win-01") == {
        "factory_name": "",
        "city": "",
        "job_scope": "",
    }
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
    assert await device_scripts.fetch_device_meta("") == {
        "factory_name": "",
        "city": "",
        "job_scope": "",
    }


# ── job_scope：按设备的岗位口径（网页可远程切换）────────────────────────────

# ── job_scope：按设备的岗位口径（网页可远程切换）────────────────────────────

def test_normalize_meta_passes_valid_job_scope() -> None:
    assert device_scripts._normalize_meta({"job_scope": "all"})["job_scope"] == "all"
    assert device_scripts._normalize_meta({"job_scope": "subway"})["job_scope"] == "subway"
    # 大小写与首尾空白都容忍
    assert device_scripts._normalize_meta({"job_scope": "  All  "})["job_scope"] == "all"


def test_normalize_meta_dumps_dirty_job_scope_to_empty() -> None:
    # 一个错字不能把工厂岗全下架或全放出来 → 脏值一律当空，跟随环境变量默认
    for dirty in ("SUBWAY_ONLY", "1", "subway_only", None, 123, ["all"], ""):
        assert device_scripts._normalize_meta({"job_scope": dirty})["job_scope"] == "", dirty


def test_normalize_meta_keeps_other_fields() -> None:
    meta = device_scripts._normalize_meta({"factory_name": "广州地铁", "city": "广州", "job_scope": "subway"})
    assert meta == {"factory_name": "广州地铁", "city": "广州", "job_scope": "subway"}
    # 非 dict 输入整体回落空值
    assert device_scripts._normalize_meta(None) == {"factory_name": "", "city": "", "job_scope": ""}

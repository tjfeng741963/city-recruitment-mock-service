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
    assert meta["factory_name"] == "广州地铁"
    assert meta["city"] == "广州"
    assert meta["job_scope"] == "subway"
    # 非 dict 输入整体回落空值
    assert device_scripts._normalize_meta(None) == dict(device_scripts.EMPTY_META)


# ── factory_ids / factories：设备绑定的工厂（4222 config 新下发）──────────────


def test_normalize_meta_parses_factory_bindings() -> None:
    meta = device_scripts._normalize_meta(
        {
            "factory_ids": [3, 7],
            "factories": [
                {"id": 3, "name": "松下万宝(广州)压缩机有限公司"},
                {"id": 7, "name": "观澜精密厂"},
            ],
        }
    )
    assert meta["factory_ids"] == [3, 7]
    assert meta["factories"] == [
        {"id": 3, "name": "松下万宝(广州)压缩机有限公司"},
        {"id": 7, "name": "观澜精密厂"},
    ]


def test_normalize_meta_tolerates_dirty_factory_bindings() -> None:
    # 缺失 / 类型不对 → 空列表，绝不抛异常：字段错了不能连累 employer_id 等过滤
    for dirty in (None, "3,7", 123, {"id": 1}, [None], True):
        meta = device_scripts._normalize_meta({"factory_ids": dirty, "factories": dirty})
        assert meta["factory_ids"] == [], dirty
        assert meta["factories"] == [], dirty
    # 列表里混脏数据：只丢脏的，好的保留
    meta = device_scripts._normalize_meta(
        {
            "factory_ids": [3, "x", True, None, 7],
            "factories": [{"id": 3}, {"name": 5}, "oops", None],
        }
    )
    assert meta["factory_ids"] == [3, 7]
    assert meta["factories"] == [{"id": 3, "name": ""}, {"id": None, "name": "5"}]
    # 缺字段就是空列表，不是缺键
    empty = device_scripts._normalize_meta({"city": "广州"})
    assert empty["factory_ids"] == [] and empty["factories"] == []
    # 每次返回的列表是独立对象，改一个不会污染 EMPTY_META
    empty["factory_ids"].append(9)
    assert device_scripts.EMPTY_META["factory_ids"] == []


def test_normalize_meta_parses_employer_and_location_ids() -> None:
    meta = device_scripts._normalize_meta(
        {"employer_id": 12, "location_id": 34, "position_id": 56}
    )
    assert (meta["employer_id"], meta["location_id"], meta["position_id"]) == (12, 34, 56)
    # bool 是 int 子类：显式排除，脏值归 0
    dirty = device_scripts._normalize_meta({"location_id": True, "employer_id": "12"})
    assert (dirty["employer_id"], dirty["location_id"]) == (0, 0)


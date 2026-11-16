"""首句直发岗位卡（POST /api/v1/flow/greet）。

业务前提（2026-11-13 与 HR 对齐）：一个微信号只做一个板块，品类在账号层面
定死，所以新好友进来不需要先问「你想找怎样的工作」，直接发该板块的岗位卡。

三种不发卡的情况都必须 skipped=True，让客户端转而发问句：
  * 设备没绑板块
  * 地铁号没绑城市
  * 板块下没有在招岗位
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.services import device_scripts, job_lookup
from tests.fixture_jobs import JOBS_BY_CITY

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _fake_jobs_and_meta(monkeypatch) -> None:  # noqa: ANN001
    """不碰真模型、不碰 4222：岗位用夹具，设备 meta 由各用例注入。"""
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")

    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
        return JOBS_BY_CITY.get(city, [])

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    yield
    job_lookup.clear_cache()
    device_scripts.clear_cache()


def _stub_meta(monkeypatch, **meta) -> None:  # noqa: ANN001
    base = dict(device_scripts.EMPTY_META)
    base.update(meta)

    async def fake_meta(device_code: str) -> dict:
        return dict(base)

    monkeypatch.setattr("app.api_flow.fetch_device_meta", fake_meta)


async def _greet(client: AsyncClient, device_code: str = "", key: str | None = None) -> dict:
    session_key = key or f"greet-{uuid.uuid4().hex[:8]}"
    resp = await client.post(
        "/api/v1/flow/greet",
        json={"session_key": session_key, "device_code": device_code},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_factory_device_gets_job_card_directly(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """工厂号绑了城市：直接发岗位卡，不问方向。"""
    _stub_meta(monkeypatch, vertical_code="factory", vertical_id=1, city="广州")
    body = await _greet(admin_client, "pc-factory-01")
    assert body["skipped"] is False
    assert body["stage"] == "send_info"
    assert body["parts"], "必须有多段内容"
    text = body["reply"]
    # 数字与岗位数据逐字一致（首句绝不能编工价）
    assert "16 元/小时" in text
    assert "利口福食品厂" in text
    # 不问方向
    assert "哪个城市" not in text


async def test_subway_device_with_city_sends_checker_card(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    _stub_meta(monkeypatch, vertical_code="subway", vertical_id=2, city="深圳")
    body = await _greet(admin_client, "pc-subway-01")
    assert body["skipped"] is False
    assert body["stage"] == "send_info"
    assert "龙华电子厂" in body["reply"]


async def test_subway_device_without_city_asks_city_first(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """地铁号没绑城市：不知道发哪个城市的安检岗，先问城市（但仍不问方向）。"""
    _stub_meta(monkeypatch, vertical_code="subway", vertical_id=2, city="")
    body = await _greet(admin_client, "pc-subway-02")
    assert body["skipped"] is True
    assert body["stage"] == "ask_city"
    assert "城市" in body["detail"]


async def test_device_without_vertical_skips(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """没绑板块（老数据 / 运营没配）：不猜，交回上层走问句。"""
    _stub_meta(monkeypatch, vertical_code="", vertical_id=0, city="广州")
    body = await _greet(admin_client, "pc-unbound-01")
    assert body["skipped"] is True or "未绑定" in body["detail"]


async def test_board_without_jobs_skips(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """板块下没有在招岗位：不瞎编，交回上层走「帮你问问」。"""
    _stub_meta(monkeypatch, vertical_code="factory", vertical_id=1, city="南宁")
    body = await _greet(admin_client, "pc-empty-01")
    assert body["skipped"] is True
    assert "没有在招岗位" in body["detail"]


async def test_factory_binding_narrows_to_that_factory(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """设备绑了具体工厂：只发这家的岗位卡。"""
    _stub_meta(
        monkeypatch,
        vertical_code="factory",
        vertical_id=1,
        city="广州",
        factory_name="利口福食品厂",
    )
    body = await _greet(admin_client, "pc-factory-02")
    assert body["skipped"] is False
    assert "利口福食品厂" in body["reply"]


async def test_greet_writes_session_events(admin_client: AsyncClient, monkeypatch) -> None:  # noqa: ANN001
    """首句要落事件，后续对话才能接着这个 stage 走。"""
    _stub_meta(monkeypatch, vertical_code="factory", vertical_id=1, city="广州")
    key = f"greet-ev-{uuid.uuid4().hex[:8]}"
    await _greet(admin_client, "pc-factory-03", key=key)
    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    assert state.status_code == 200
    assert state.json()["stage"] == "send_info"

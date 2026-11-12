"""流程接口测试：走真实 DB，验证五阶段、parts 与未知问题落库。"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.services import job_lookup
from tests.fixture_jobs import JOBS_BY_CITY

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _no_llm_and_remote_jobs(monkeypatch) -> None:  # noqa: ANN001
    """接口测试不碰真模型也不碰 4222：岗位查询单测替身注入岗位夹具。"""
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")

    async def fake_fetch(city: str, token: str, url: str) -> list[dict]:
        return JOBS_BY_CITY.get(city, [])

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    job_lookup.clear_cache()
    yield
    job_lookup.clear_cache()


async def _say(client: AsyncClient, key: str, text: str, **extra) -> dict:
    resp = await client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": text, **extra}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_flow_over_http(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"

    r1 = await _say(admin_client, key, "你好")
    assert r1["stage"] == "ask_city" and "哪个城市" in r1["reply"]

    r2 = await _say(admin_client, key, "东莞")
    assert r2["stage"] == "ask_interview"
    assert "长安五金厂" in r2["reply"]
    assert len(r2["parts"]) >= 2
    assert r2["reply"] == "\n".join(r2["parts"])
    assert r2["attachments"] == []

    r3 = await _say(admin_client, key, "可以")
    assert r3["stage"] == "collect"
    assert "姓名" in r3["reply"] and "手机" in r3["reply"]

    r4 = await _say(admin_client, key, "张三 13800138000")
    assert r4["stage"] == "done" and r4["finished"] is True
    assert r4["action"] == "book_interview"
    assert r4["profile"]["name"] == "张三"
    assert r4["profile"]["phone"] == "13800138000"
    assert r4["slots"]["interview_at"].startswith("20")

    r5 = await _say(admin_client, key, "我到了找谁")
    assert r5["finished"] is True and r5["reply"] == "" and r5["parts"] == []

    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    assert state.status_code == 200
    body = state.json()
    assert body["stage"] == "done"
    assert body["slots"]["city"] == "东莞"
    assert body["slots"]["name"] == "张三"
    assert body["turns"] == 5
    assert body["actions"][-1]["name"] == "book_interview"


async def test_refusal_ends_flow_as_disqualified(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "广州")
    refused = await _say(admin_client, key, "这两天来不了")

    assert refused["stage"] == "done"
    assert refused["action"] == "gave_up"
    assert refused["slots"]["recruit_status"] == "disqualified"

    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    assert state.json()["stage"] == "done"


async def test_reset_clears_projection(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "广州")
    await _say(admin_client, key, "可以")

    resp = await admin_client.post("/api/v1/flow/reset", params={"session_key": key})
    assert resp.status_code == 204

    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    body = state.json()
    assert body["stage"] == "ask_city"
    assert body["slots"].get("city") in (None, "")
    assert body["slots"].get("name") in (None, "")


async def test_kb_miss_is_recorded_as_unknown_question(
    admin_client: AsyncClient, monkeypatch
) -> None:  # noqa: ANN001
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "广州")

    sent: list[dict] = []

    async def fake_record(text: str, device_code: str = "", session_key: str = "") -> bool:
        sent.append({"text": text, "device_code": device_code, "session_key": session_key})
        return True

    monkeypatch.setattr("app.api_flow.unknown_questions.record", fake_record)

    missed = await _say(admin_client, key, "宿舍有没有空调", device_code="pc-office-05")
    assert "这个我确认一下，稍后回你" in missed["reply"]
    assert missed["stage"] == "ask_interview"
    assert sent == [
        {"text": "宿舍有没有空调", "device_code": "pc-office-05", "session_key": key}
    ]

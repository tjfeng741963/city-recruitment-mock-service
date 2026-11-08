"""流程接口测试：走真实 DB，验证事件流能落库、能投影回来。"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def _say(client: AsyncClient, key: str, text: str) -> dict:
    resp = await client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": text}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_flow_over_http(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"

    r1 = await _say(admin_client, key, "你好")
    assert r1["stage"] == "ask_city" and "哪个城市" in r1["reply"]

    r2 = await _say(admin_client, key, "东莞")
    assert r2["stage"] == "ask_gender"
    assert "长安五金厂" in r2["reply"]

    r3 = await _say(admin_client, key, "男")
    assert r3["stage"] == "ask_record"

    r4 = await _say(admin_client, key, "没有")
    assert r4["stage"] == "confirm"
    assert r4["slots"]["city"] == "东莞"
    assert r4["slots"]["interview_at"].startswith("20")

    r5 = await _say(admin_client, key, "可以")
    assert r5["stage"] == "done" and r5["finished"] is True
    assert r5["action"] == "book_interview"

    r6 = await _say(admin_client, key, "我到了找谁")
    assert r6["finished"] is True and r6["reply"] == ""

    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    assert state.status_code == 200
    body = state.json()
    assert body["stage"] == "done"
    assert body["slots"]["gender"] == "男"
    assert body["turns"] == 6
    assert body["actions"][-1]["name"] == "book_interview"


async def test_reset_clears_projection(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "广州")
    await _say(admin_client, key, "女")

    resp = await admin_client.post("/api/v1/flow/reset", params={"session_key": key})
    assert resp.status_code == 204

    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    body = state.json()
    assert body["stage"] == "ask_city"
    assert body["slots"].get("gender") in (None, "")

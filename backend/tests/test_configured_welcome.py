"""Configured greetings do not require a customer question or an available job."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest

from app.services import device_scripts

pytestmark = pytest.mark.asyncio
CONTENT = "你好，欢迎咨询招聘岗位。\n---\n我先帮你了解一下。\n---\n请问你现在在哪个城市？"
PARTS = ["你好，欢迎咨询招聘岗位。", "我先帮你了解一下。", "请问你现在在哪个城市？"]


@pytest.fixture
def welcome(monkeypatch):
    meta = {**device_scripts.EMPTY_META, "vertical_code": "factory", "city": "广州"}
    scripts = [{"position_id": 0, "stage": "greet", "content": CONTENT}]
    jobs = [{"position_id": 7, "factory_name": "测试工厂", "city": "广州", "wage_text": "本岗工资"}]
    monkeypatch.setattr("app.api_flow.fetch_device_meta", AsyncMock(side_effect=lambda _: dict(meta)))
    monkeypatch.setattr("app.api_flow.fetch_position_scripts", AsyncMock(side_effect=lambda _: list(scripts)))
    lookup = AsyncMock(side_effect=lambda *a, **kw: list(jobs))
    monkeypatch.setattr("app.api_flow.lookup_jobs", lookup)
    provider = AsyncMock(side_effect=AssertionError("固定欢迎语不能调模型"))
    monkeypatch.setattr("app.api_flow.build_provider", provider)
    return meta, scripts, jobs, provider


async def greet(client):
    key = "welcome-" + uuid.uuid4().hex[:12]
    response = await client.post("/api/v1/flow/greet", json={"session_key": key, "device_code": "test-welcome-device"})
    assert response.status_code == 200, response.text
    return key, response.json()


async def test_configured_welcome_returns_ordered_parts_and_persists_without_customer_text(admin_client, welcome):
    key, body = await greet(admin_client)
    assert body["parts"] == PARTS
    assert body["reply"] == "\n".join(PARTS)
    assert body["stage"] == "ask_city"
    assert body["skipped"] is False
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["slots"]["scripted_sent"]["greet"] is True
    assert state["turns"] == 0  # No fabricated customer message.
    welcome[3].assert_not_called()


@pytest.mark.parametrize("missing", ["jobs", "city", "vertical"])
async def test_general_welcome_can_ask_city_before_job_configuration_is_complete(admin_client, welcome, missing):
    meta, _, jobs, _ = welcome
    if missing == "jobs":
        jobs.clear()
    elif missing == "city":
        meta.update(vertical_code="subway", city="")
    else:
        meta.update(vertical_code="", vertical_id=0)
    _, body = await greet(admin_client)
    assert body["parts"] == PARTS
    assert body["skipped"] is False


async def test_exact_position_welcome_wins_and_splits_before_placeholder_rendering(admin_client, welcome):
    _, scripts, jobs, _ = welcome
    jobs[0]["factory_name"] = "工厂名\n---\n包含符号"
    scripts.append({"position_id": 7, "stage": "greet", "content": "你好\n欢迎咨询{{factory}}。\n---\n你在哪个城市？"})
    scripts.append({"position_id": 8, "stage": "greet", "content": "不应借用别的岗位"})
    _, body = await greet(admin_client)
    assert body["parts"] == ["你好\n欢迎咨询工厂名\n---\n包含符号。", "你在哪个城市？"]


async def test_single_multiline_greeting_stays_one_message(admin_client, welcome):
    welcome[1][0]["content"] = "你好。\n欢迎咨询。\n请问在哪个城市？"
    _, body = await greet(admin_client)
    assert body["parts"] == [welcome[1][0]["content"]]


async def test_welcome_preserves_job_interview_window(admin_client, welcome):
    welcome[1][0]["content"] = "面试时间：{{window}}"
    welcome[2][0]["interview_time"] = "测试面试时间"
    _, body = await greet(admin_client)
    assert body["parts"] == ["面试时间：测试面试时间"]

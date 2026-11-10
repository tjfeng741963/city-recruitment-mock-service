"""档案抽取（profile）与推送给 4222 的测试。

四条线：
1. 模型给的 profile 并进槽位，事件能回放出同一份档案
2. 没配 token 就不发请求（避免 4222 侧 403 噪音）
3. 推送炸了，客户照样收到回复（200 + reply）
4. interview_at 的 ISO → 4222 的 interview_date/interview_time
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from httpx import AsyncClient

from app.models_flow import FlowEvent
from app.services import flow_session as store
from app.services import profile_push
from app.services.flow_engine import new_state
from app.services.flow_llm import apply_result
from app.services.profile_push import build_profile, push

PROFILE = {
    "name": "张三",
    "phone": "13800138000",
    "district": "番禺",
    "age": 32,
    "notes": "要长白班",
}


def test_profile_merged_into_slots_and_replayed() -> None:
    state = new_state()
    result = apply_result(
        state,
        {
            "reply": "好嘞，广州这边有厂在招，你是男生还是女生？",
            "stage": "ask_interview",
            "slots": {"city": "广州"},
            "profile": PROFILE,
            "action": None,
            "finished": False,
        },
    )

    # 沿用同一份槽位，不另起一套
    assert result.slots["city"] == "广州"
    for key, value in PROFILE.items():
        assert result.slots[key] == value
    # 电话不许被改格式
    assert result.slots["phone"] == "13800138000"

    changes = store.diff_profile({}, result.slots)
    assert len(changes) == 1 and changes[0][0] == store.EVENT_PROFILE
    assert changes[0][1] == PROFILE

    # 用事件回放，档案必须能从日志里重建出来
    events = [
        FlowEvent(
            session_key="c1",
            seq=1,
            type=store.EVENT_SLOT,
            body=json.dumps({"key": "city", "value": "广州"}, ensure_ascii=False),
        ),
        FlowEvent(
            session_key="c1",
            seq=2,
            type=store.EVENT_PROFILE,
            body=json.dumps(PROFILE, ensure_ascii=False),
        ),
    ]
    projected = store.project(events)
    assert projected["profile"] == PROFILE
    assert projected["slots"]["city"] == "广州"
    assert store.profile_of(projected["slots"]) == PROFILE


def test_profile_does_not_overwrite_with_empty() -> None:
    state = new_state()
    state["slots"].update(PROFILE)
    result = apply_result(
        state,
        {
            "reply": "嗯，那咱就约明天中午 1 点，方便吗？",
            "stage": "collect",
            "slots": {"city": "广州", "gender": "男", "record": "无"},
            "profile": {"name": "", "phone": "", "age": None},
            "action": None,
            "finished": False,
        },
    )
    assert result.slots["name"] == "张三"
    assert store.diff_profile(PROFILE, result.slots) == []


@pytest.mark.asyncio
async def test_no_token_means_no_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FLOW_PROFILE_TOKEN", raising=False)
    called: list[Any] = []

    class Boom:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            called.append((args, kwargs))

    monkeypatch.setattr(profile_push.httpx, "AsyncClient", Boom)

    ok = await push("pc-office-01", "s-1", build_profile({"city": "广州"}))
    assert ok is False
    assert called == []


@pytest.mark.asyncio
async def test_push_swallows_transport_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok")

    class Boom:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("4222 挂了")

    monkeypatch.setattr(profile_push.httpx, "AsyncClient", Boom)
    assert await push("pc-office-01", "s-1", build_profile({"city": "广州"})) is False


@pytest.mark.asyncio
async def test_push_body_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok-1")
    captured: dict[str, Any] = {}

    class Resp:
        status_code = 200

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            captured["timeout"] = kwargs.get("timeout")

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict) -> Resp:
            captured.update({"url": url, "json": json, "headers": headers})
            return Resp()

    monkeypatch.setattr(profile_push.httpx, "AsyncClient", FakeClient)
    profile = build_profile({"city": "广州"})
    assert await push("pc-office-02", "sess-9", profile) is True

    assert captured["url"].endswith("/api/v1/agent/profile")
    assert captured["timeout"] == 3
    assert captured["headers"]["X-Profile-Token"] == "tok-1"
    assert captured["json"] == {
        "device_code": "pc-office-02",
        "external_conversation_id": "sess-9",
        "profile": profile,
    }
    # 空值不发：4222 认「出现的键才覆盖」，发空串会擦掉手填的档案
    assert "name" not in profile and "interview_date" not in profile


def test_interview_at_converts_to_date_and_time() -> None:
    slots = {
        "city": "东莞",
        "job_index": 0,
        "gender": "男",
        "record": "无",
        "interview_at": "2026-11-09T13:00:00+08:00",
    }
    profile = build_profile(slots, "done", "book_interview")

    assert profile["interview_date"] == "2026-11-09"
    assert profile["interview_time"] == "13:00"
    assert profile["stage"] == "booked"
    assert profile["job_title"] == "长安五金厂 操作工"
    assert profile["factory_name"] == "长安五金厂"
    assert profile["city"] == "东莞" and profile["gender"] == "男"


def test_stage_mapping() -> None:
    assert build_profile({"city": "广州"}, "ask_city", None)["stage"] == "asking"
    assert build_profile({"city": "广州"}, "send_info", None)["stage"] == "offered"
    assert build_profile({"city": "广州"}, "ask_interview", None)["stage"] == "offered"
    assert build_profile({"city": "广州"}, "collect", None)["stage"] == "offered"
    assert build_profile({"city": "广州"}, "done", "gave_up")["stage"] == "gave_up"
    assert build_profile({"city": "广州"}, "done", "handoff")["stage"] == "gave_up"
    assert build_profile({}, "", None)["stage"] == "asking"


def test_province_flows_into_profile_and_payload() -> None:
    """省字段（017）：slots 里有了就要带出去，前端拼「广东省广州市/白云区」。"""
    slots = {
        "city": "广州",
        "province": "广东省",
        "district": "白云区",
        "interview_at": "2026-11-09T09:00:00+08:00",
        "interview_window": "09:00-11:00",
    }
    profile = build_profile(slots, "done", "book_interview")

    assert profile["province"] == "广东省"
    assert profile["city"] == "广州"
    assert profile["district"] == "白云区"
    # 窗口比整点更准，前端展示要用这个
    assert profile["interview_time"] == "09:00-11:00"
    assert profile["interview_date"] == "2026-11-09"
    assert profile["stage"] == "booked"


def test_only_province_is_still_worth_pushing() -> None:
    assert profile_push.has_content(build_profile({"province": "广东省"})) is True


class ScriptedProvider:
    """只回一句话的模型，用来在接口层注入 profile。"""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    async def complete(self, messages, **kwargs):  # noqa: ANN001, ANN003
        return json.dumps(self.payload, ensure_ascii=False)


@pytest.mark.asyncio
async def test_flow_answer_survives_push_failure(
    admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """推送抛异常时接口仍然 200、reply 正常、事件照旧落库。"""
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok")
    monkeypatch.setattr(
        "app.api_flow.build_provider",
        lambda: ScriptedProvider(
            {
                "reply": "好嘞，广州这边有厂在招，你是男生还是女生？",
                "stage": "ask_interview",
                "slots": {"city": "广州"},
                "profile": PROFILE,
                "action": None,
                "finished": False,
            }
        ),
    )

    async def boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("4222 拒绝连接")

    monkeypatch.setattr("app.api_flow.profile_push.push", boom)

    key = f"push-{uuid.uuid4().hex[:8]}"
    resp = await admin_client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": "我在广州，我叫张三"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reply"]
    assert body["profile"]["name"] == "张三"

    state = await admin_client.get("/api/v1/flow/state", params={"session_key": key})
    assert state.status_code == 200
    assert state.json()["profile"] == PROFILE


@pytest.mark.asyncio
async def test_flow_answer_pushes_extracted_profile(
    admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """正常路径：抽到档案就推一份，带 device_code 与会话键。"""
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok")
    monkeypatch.setattr(
        "app.api_flow.build_provider",
        lambda: ScriptedProvider(
            {
                "reply": "好嘞，广州这边有厂在招，你是男生还是女生？",
                "stage": "ask_interview",
                "slots": {"city": "广州"},
                "profile": PROFILE,
                "action": None,
                "finished": False,
            }
        ),
    )
    sent: list[tuple[str, str, dict]] = []

    async def fake_push(device_code: str, session_key: str, profile: dict) -> bool:
        sent.append((device_code, session_key, profile))
        return True

    monkeypatch.setattr("app.api_flow.profile_push.push", fake_push)

    key = f"push-{uuid.uuid4().hex[:8]}"
    resp = await admin_client.post(
        "/api/v1/flow/answer",
        json={"session_key": key, "text": "我在广州，我叫张三", "device_code": "pc-office-09"},
    )
    assert resp.status_code == 200, resp.text

    assert len(sent) == 1
    device_code, session_key, profile = sent[0]
    assert device_code == "pc-office-09"
    assert session_key == key
    assert profile["city"] == "广州"
    assert profile["name"] == "张三"
    assert profile["phone"] == "13800138000"

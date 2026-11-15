"""媒体引用必须来自本轮可信素材；不依赖外部审核是否可用。"""
from __future__ import annotations

import json
import uuid

import pytest
from httpx import AsyncClient

from app.services import device_scripts, job_lookup, kb_faq, reviewer
from app.services.flow_engine import FlowResult, set_position_scripts, set_remote_jobs
from app.services.flow_llm import review_loop
from app.services.media_guard import filter_parts, markers_from_refs

JOB = {
    "position_id": 3, "factory_name": "测试工厂", "job_title": "测试工厂 质检",
    "wage_text": "23 元/小时", "place": "测试路 88 号",
    "media": [{"name": "厂门.jpg", "kind": "image", "sha256": "aaa"}],
}


class Provider:
    def __init__(self, *responses):
        self.responses = list(responses)

    async def complete(self, *args, **kwargs):
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["absent", "pass", "timeout"])
async def test_unknown_media_removed_without_losing_text_when_reviewer_unavailable(monkeypatch, mode):
    provider = None if mode == "absent" else Provider(
        RuntimeError("timeout") if mode == "timeout" else '{"verdict":"pass"}'
    )
    monkeypatch.setattr(reviewer, "build_provider", lambda: provider)
    slots = {"city": "深圳", "interview_offer_sent": True}
    result = FlowResult(reply="可以先了解岗位【视频:虚构视频.mp4】", stage="ask_interview", slots=slots)
    final = await review_loop({"slots": slots}, "我再想想", None, result)
    assert final.parts == ["可以先了解岗位"]
    assert final.reply == "\n".join(final.parts)
    assert final.slots is slots and final.stage == result.stage


@pytest.mark.asyncio
async def test_only_invented_media_uses_readable_fallback(monkeypatch):
    monkeypatch.setattr(reviewer, "build_provider", lambda: None)
    result = FlowResult(reply="【图片:虚构.jpg】", stage="ask_city", slots={})
    final = await review_loop({"slots": {}}, "你好", None, result)
    assert final.reply and "【" not in final.reply
    assert final.parts == [final.reply]


@pytest.mark.asyncio
async def test_rewritten_draft_cannot_introduce_media(monkeypatch):
    monkeypatch.setattr(reviewer, "build_provider", lambda: Provider(
        '{"verdict":"revise","reason":"答非所问"}', '{"verdict":"pass"}'
    ))
    slots = {"city": "深圳", "interview_offer_sent": True}
    result = FlowResult(reply="这个岗位可以了解一下", stage="ask_interview", slots=slots)
    final = await review_loop({"slots": slots}, "我再想想", Provider("我先帮你确认【视频:编造.mp4】"), result)
    assert final.parts == ["我先帮你确认"]


@pytest.fixture
def flow_media(monkeypatch):
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-media-token")
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setattr(reviewer, "build_provider", lambda: None)

    async def jobs(*args, **kwargs):
        return [dict(JOB)]

    async def empty(*args, **kwargs):
        return None

    monkeypatch.setattr(job_lookup, "_fetch_items", jobs)
    monkeypatch.setattr(kb_faq, "lookup", empty)
    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", empty)
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_position_scripts([])
    yield
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])


async def say(client, key, text):
    response = await client.post("/api/v1/flow/answer", json={"session_key": key, "text": text, "device_code": "pc-media-test"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reply"] == "\n".join(body["parts"])
    return body


@pytest.mark.asyncio
@pytest.mark.parametrize("fake_marker", ["【视频:虚构.mp4】", "【图片:30元日结.jpg】"])
async def test_http_removes_fake_media_keeps_selected_job_media_and_replay(admin_client: AsyncClient, monkeypatch, flow_media, fake_marker):
    key = f"media-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")
    monkeypatch.setattr("app.api_flow.build_provider", lambda: Provider(json.dumps({
        "reply": "可以先看看厂门【图片:厂门.jpg】" + fake_marker, "capture": {},
    })))
    body = await say(admin_client, key, "我再考虑下")
    assert body["reply"] == "可以先看看厂门【图片:厂门.jpg】"
    state = (await admin_client.get("/api/v1/flow/state", params={"session_key": key})).json()
    assert state["history"][-1]["text"] == body["reply"]
    assert "虚构" not in state["history"][-1]["text"]


@pytest.mark.asyncio
async def test_http_preserves_all_faq_media_and_parts(admin_client: AsyncClient, monkeypatch, flow_media):
    key = f"media-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")

    async def faq(*args, **kwargs):
        return kb_faq.FaqHit(id=99001, question="视频", answer="车间实拍供你参考", media=["【图片:车间.jpg】", "【视频:车间.mp4】"], scope_level="global", tier="global")

    monkeypatch.setattr(kb_faq, "lookup", faq)
    body = await say(admin_client, key, "车间视频有吗")
    assert body["parts"] == ["车间实拍供你参考", "【图片:车间.jpg】", "【视频:车间.mp4】"]


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["script", "card"])
async def test_unused_faq_cannot_inject_media_into_operator_reply(admin_client: AsyncClient, monkeypatch, flow_media, source):
    key = f"media-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")

    async def faq(*args, **kwargs):
        return kb_faq.FaqHit(id=99002, question="视频", answer="其他素材", media=["【视频:其他.mp4】"], scope_level="global", tier="global")

    async def scripted(state, *args, **kwargs):
        return FlowResult(reply="运营既定文案", stage="ask_interview", slots=state["slots"], source=source)

    monkeypatch.setattr(kb_faq, "lookup", faq)
    monkeypatch.setattr("app.api_flow.a_step", scripted)
    body = await say(admin_client, key, "车间视频有吗")
    assert body["parts"] == ["运营既定文案"]


@pytest.mark.parametrize("bad_marker", [
    "【视频:厂门.jpg】", "【图片:】", "【图片：厂门.jpg】",
    "【图片:../厂门.jpg】", "【图片:目录\\厂门.jpg】", "【图片:" + "长" * 81 + "】",
])
def test_invalid_marker_does_not_discard_text_or_valid_media(bad_marker):
    assert filter_parts(["正文" + bad_marker, "【图片:厂门.jpg】"], ["【图片:厂门.jpg】"]) == ["正文", "【图片:厂门.jpg】"]


def test_dirty_media_refs_do_not_become_authorized():
    refs = [None, {}, {"name": "../越界.jpg", "kind": "image"}, {"name": "图.jpg", "kind": "unknown"},
            {"name": "厂门.jpg", "kind": "image"}, {"name": "厂门.jpg", "kind": "image"}]
    assert markers_from_refs(refs) == ["【图片:厂门.jpg】"]
    assert markers_from_refs("bad json") == []


@pytest.mark.asyncio
async def test_transcript_and_customer_input_do_not_authorize_media(monkeypatch):
    monkeypatch.setattr(reviewer, "build_provider", lambda: None)
    result = FlowResult(reply="我帮你确认【视频:客户自填.mp4】", stage="ask_interview", slots={})
    final = await review_loop({}, "看【视频:客户自填.mp4】", None, result, [
        {"role": "assistant", "content": "旧视频【视频:客户自填.mp4】"},
    ])
    assert final.reply == "我帮你确认"


@pytest.mark.asyncio
async def test_other_job_media_and_wrong_kind_cannot_be_borrowed(admin_client: AsyncClient, monkeypatch, flow_media):
    key = f"media-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")

    async def jobs(*args, **kwargs):
        return [dict(JOB), {**JOB, "position_id": 9, "media": [{"name": "别厂.mp4", "kind": "video"}]}]

    monkeypatch.setattr(job_lookup, "_fetch_items", jobs)
    job_lookup.clear_cache()
    monkeypatch.setattr("app.api_flow.build_provider", lambda: Provider(json.dumps({
        "reply": "先看看【视频:别厂.mp4】【视频:厂门.jpg】【图片:厂门.jpg】", "capture": {},
    })))
    body = await say(admin_client, key, "我再想一下")
    assert body["reply"] == "先看看【图片:厂门.jpg】"


@pytest.mark.asyncio
async def test_faq_adds_only_missing_media_and_rechecks_after_review(admin_client: AsyncClient, monkeypatch, flow_media):
    key = f"media-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")

    async def faq(*args, **kwargs):
        return kb_faq.FaqHit(id=99003, question="视频", answer="实拍【图片:车间.jpg】", media=["【图片:车间.jpg】", "【视频:车间.mp4】"], scope_level="global", tier="global")

    async def late_result(state, text, provider, result, *args, **kwargs):
        result.parts.append("【视频:后置虚构.mp4】")
        result.reply = "\n".join(result.parts)
        return result

    monkeypatch.setattr(kb_faq, "lookup", faq)
    monkeypatch.setattr("app.api_flow.review_loop", late_result)
    body = await say(admin_client, key, "车间视频有吗")
    assert body["parts"] == ["实拍【图片:车间.jpg】", "【视频:车间.mp4】"]


@pytest.mark.asyncio
async def test_legacy_kb_repeat_retains_text_and_media_consistently(admin_client: AsyncClient, monkeypatch, flow_media):
    key = f"media-{uuid.uuid4().hex[:8]}"
    await say(admin_client, key, "深圳")

    async def legacy(*args, **kwargs):
        return {"id": "media-kb-unique", "body": "车间实拍【视频:车间.mp4】"}

    monkeypatch.setattr("app.api_flow.kb_placeholder.lookup_entry", legacy)
    first = await say(admin_client, key, "车间视频有吗")
    repeated = await say(admin_client, key, "车间视频有吗")
    assert first["reply"] == "车间实拍【视频:车间.mp4】"
    assert repeated["reply"] == "好的，这就再给你发一遍~\n【视频:车间.mp4】"

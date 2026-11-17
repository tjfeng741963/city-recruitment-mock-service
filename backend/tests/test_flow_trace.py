"""灰度诊断：每轮回复必须留下「为什么这么回」的证据。

背景：2026-11-16 灰度测试要求 AI 没有黑盒——线上每条回复都要能事后定位
是谁生成的、走了哪一步、命中了哪条知识库、审核动过没有。这个测试锁住三件事：

1. 每条回复都带 trace，缺了就是回归；
2. trace 不能泄露给客户端（FlowAnswerOut 里没有这个字段）；
3. 关键来源（card / collect / fact / kb / closing）必须能被区分出来。

只断言「有没有记录、记的是不是那一类」，不断言具体文案——文案会随对话调整，
锁死会让测试天天红。
"""

from __future__ import annotations

import json
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models_flow import FlowEvent
from app.services import job_lookup
from tests.fixture_jobs import JOBS_BY_CITY

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _no_llm_and_remote_jobs(monkeypatch) -> None:  # noqa: ANN001
    """与 test_flow_api 同口径：不碰真模型、不碰 4222，岗位用夹具。"""
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")

    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
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


async def _reply_traces(key: str) -> list[dict]:
    """按顺序取出该会话所有 reply 事件的 trace。"""
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(FlowEvent)
                .where(FlowEvent.session_key == key, FlowEvent.type == "reply")
                .order_by(FlowEvent.seq)
            )
        ).scalars().all()
    traces = []
    for row in rows:
        body = json.loads(row.body or "{}")
        traces.append(body.get("trace") or {})
    return traces


async def test_every_reply_carries_trace(admin_client: AsyncClient) -> None:
    """走一遍完整流程：每条回复都要有 trace，且来源可辨认。"""
    key = f"trace-{uuid.uuid4().hex[:8]}"

    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "东莞")
    await _say(admin_client, key, "可以")
    await _say(admin_client, key, "张三 13800138000")

    traces = await _reply_traces(key)
    assert len(traces) == 4, f"应该有 4 条回复，实际 {len(traces)}"
    for index, trace in enumerate(traces):
        assert trace, f"第 {index + 1} 条回复没有 trace —— 灰度就变成黑盒了"
        # 这四个字段是定位的最小集合：谁生成的、从哪步到哪步、什么动作。
        for field in ("source", "stage_from", "stage_to", "action"):
            assert field in trace, f"第 {index + 1} 条回复的 trace 缺 {field}"

    # 来源必须能区分出代码渲染与模型自由发挥。
    sources = [trace["source"] for trace in traces]
    assert any(source in {"card", "fact", "collect"} for source in sources), sources

    # 阶段推进要落下来，否则不知道这句话是在哪个流程节点说的。
    assert traces[-1]["stage_to"] == "done", traces[-1]


async def test_trace_records_kb_and_review(admin_client: AsyncClient) -> None:
    """知识库命中与审核动作也要留痕——这是灰度里最常见的两类问题来源。"""
    key = f"trace-kb-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "东莞")

    traces = await _reply_traces(key)
    # kb_entry_id 可能是空串（没命中 kb_faq），但字段必须存在，便于区分
    # 「没命中」和「没记录」——后者说明埋点丢了。
    assert all("kb_entry_id" in trace for trace in traces)
    assert all("review" in trace for trace in traces), "审核判定必须留痕，否则无法判断这句话是谁改的"


async def test_trace_never_reaches_client(admin_client: AsyncClient) -> None:
    """诊断字段只在库里，绝不能出现在 API 响应里。"""
    key = f"trace-leak-{uuid.uuid4().hex[:8]}"
    payload = await _say(admin_client, key, "你好")
    assert "trace" not in payload
    for value in payload.values():
        assert "trace" not in json.dumps(value, ensure_ascii=False, default=str)


async def test_llm_calls_are_recorded(monkeypatch) -> None:  # noqa: ANN001
    """模型调用必须留痕：模型名、耗时、token、prompt、原始返回、失败原因。

    这是「AI 没有黑盒」的核心——灰度里客户收到一句莫名其妙的话，
    要能查到当时发的是什么 prompt、模型原样返回了什么、有没有重试。

    不打真网络：把 httpx 客户端换成桩，返回固定的 choices + usage。
    """
    from app.services import llm_provider

    class _Resp:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "choices": [{"message": {"content": "广州有地铁安检岗"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 5, "total_tokens": 16},
            }

    class _Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def post(self, *_args: object, **_kwargs: object) -> _Resp:
            return _Resp()

    monkeypatch.setattr(llm_provider.httpx, "AsyncClient", _Client)
    # 确保正文采集是开的——关掉就该只有元数据，这是隐私开关的语义。
    monkeypatch.setattr(llm_provider, "_trace_options", lambda: (True, 2000))

    provider = llm_provider.OpenAICompatibleProvider(
        base_url="http://stub", api_key="test-key", model="doubao-pro-32k"
    )
    llm_provider.begin_llm_trace()
    reply = await provider.complete(
        [
            llm_provider.ChatMessage("system", "你是招聘客服"),
            llm_provider.ChatMessage("user", "广州有工作吗"),
        ],
        temperature=0.7,
        max_tokens=700,
    )
    calls = llm_provider.collect_llm_trace()

    assert reply == "广州有地铁安检岗"
    assert len(calls) == 1, f"应该记录 1 次调用，实际 {len(calls)}"
    call = calls[0]
    assert call["model"] == "doubao-pro-32k"
    assert call["ok"] is True
    assert call["attempts"] == 1
    assert isinstance(call["ms"], int)
    assert call["tokens"]["total_tokens"] == 16
    # prompt 与原始返回都要留，否则复盘时看不到「发了什么、回了什么」
    assert "你是招聘客服" in call["prompt"] and "广州有工作吗" in call["prompt"]
    assert call["raw"] == "广州有地铁安检岗"
    # 密钥绝不能进 trace
    assert "test-key" not in json.dumps(call, ensure_ascii=False)


async def test_llm_failure_is_recorded(monkeypatch) -> None:  # noqa: ANN001
    """调用失败也要留痕——否则「为什么这轮走了兜底话术」永远查不出来。"""
    from app.services import llm_provider

    class _Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def post(self, *_args: object, **_kwargs: object) -> object:
            raise llm_provider.httpx.ConnectError("connection refused")

    monkeypatch.setattr(llm_provider.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(llm_provider, "_trace_options", lambda: (True, 2000))

    provider = llm_provider.OpenAICompatibleProvider(
        base_url="http://stub", api_key="k", model="m", max_retries=1
    )
    llm_provider.begin_llm_trace()
    with pytest.raises(llm_provider.LLMUnavailable):
        await provider.complete([llm_provider.ChatMessage("user", "hi")])
    calls = llm_provider.collect_llm_trace()

    assert len(calls) == 1
    assert calls[0]["ok"] is False
    assert calls[0]["attempts"] == 2, "max_retries=1 应该尝试 2 次"
    assert "ConnectError" in calls[0]["error"]


async def test_refusal_is_traceable(admin_client: AsyncClient) -> None:
    """客户拒接必须能从 trace 里认出来。

    「说了不去还被追问」是业务红线，复盘时要能一眼找出这条链路。拒接有三段证据，
    各自留下的痕迹不同——这正是容易漏埋点的地方，所以三段都锁住：

    1. 拒接当场：走 gave_up 动作，``action='gave_up'`` 且 ``recruit_status='disqualified'``
       （此时 source 可能是 fact 或空串，**不能靠 source 判断拒接**）；
    2. 拒接后第一次再开口：``source='reopen'``，重新接待但**绝不邀约**
       （2026-11-17 起给一次回流机会，避免真回心转意的人永远没人接）；
    3. 回流额度用完之后：走 ``source='closing'``、``stage_to='done'``，不再推进阶段。
    """
    key = f"trace-refuse-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "东莞")
    await _say(admin_client, key, "我不去了")

    traces = await _reply_traces(key)
    gave_up = [
        trace
        for trace in traces
        if trace.get("action") == "gave_up" or trace.get("recruit_status") == "disqualified"
    ]
    assert gave_up, f"拒接当场没有留下痕迹：{traces}"

    # 拒接后第一次再开口：必须标成 reopen，且不能重新邀约
    first = await _say(admin_client, key, "在吗")
    assert "这两天能不能过来面试" not in first["reply"]
    assert "名额给你留着" not in first["reply"]
    traces = await _reply_traces(key)
    assert any(trace.get("source") == "reopen" for trace in traces), \
        f"拒接后的首次回流没有标成 reopen：{[t.get('source') for t in traces]}"

    # 再拒绝一次之后：回流额度用完，回到收尾语
    await _say(admin_client, key, "算了 还是不去了")
    await _say(admin_client, key, "在吗")
    traces = await _reply_traces(key)
    closing = [trace for trace in traces if trace.get("source") == "closing"]
    assert closing, f"回流额度用完后没有回到收尾语：{[t.get('source') for t in traces]}"
    assert closing[-1]["stage_to"] == "done", closing[-1]


async def test_code_rendered_replies_record_audit_bypass(admin_client: AsyncClient) -> None:
    """代码渲染的回复（card/fact/collect/kb）必须记下「跳过审核」。

    这类内容是灰度里出现最多的。如果不留痕，事后看到一条答错的卡片，
    就分不清是「审核放行了」还是「这类内容压根不走审核」。
    """
    key = f"trace-bypass-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "东莞")

    traces = await _reply_traces(key)
    rendered = [t for t in traces if t.get("source") in {"card", "fact", "collect", "kb"}]
    assert rendered, f"应该至少有一条代码渲染的回复：{[t.get('source') for t in traces]}"
    for trace in rendered:
        review = trace.get("review") or []
        assert any(
            isinstance(item, dict) and item.get("stage") == "bypass" for item in review
        ), f"代码渲染的回复没记 bypass：{review}"


"""双智能体架构：AgentSession 持久上下文 + A（对话执行）+ B（审核把关）。

契约（2026-11-14 双智能体改造冻结）：
- 每客户一个标准智能体上下文：客户消息（user）与 AI 实发内容（assistant，含
  话术/卡片段）都入 transcript；打回的草稿不入（客户没收到的东西不存在）
- A 聊天带岗位上下文（事实卡 + 同城候选岗位），支持 switch 切换岗位；
  _WANTS_MORE（"还有别的厂吗"）保持确定性通道，行为与 switch 落地同一条路径
- B 逐条把关：pass → 发；revise → A 重写一次再审；2 轮后仍 revise →
  兜底强制发送（事实卡直答 → 确定性提问 → 确认一下），绝不静默不发
- B 不可用（provider None/超时/乱码）→ 草稿直接放行（审核是增强不是闸门）
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime

import pytest

from app.models_flow import FlowEvent
from app.services import agent_session
from app.services import job_lookup
from app.services import reviewer as reviewer_mod
from app.services.flow_engine import (
    STAGE_ASK_INTERVIEW,
    TZ,
    new_state,
    set_position_scripts,
    set_remote_jobs,
    step as engine_step,
)
from app.services.flow_llm import a_step, build_decision_messages, review_loop
from app.services.reviewer import Reviewer
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=TZ)

JOB_A = {
    "position_id": 3,
    "employer_id": 7,
    "factory_name": "观澜精密厂",
    "job_title": "观澜精密厂 质检",
    "wage_text": "23 元/小时",
    "hours_text": "两班倒，月休 4 天",
    "age_text": "18-40 岁",
    "welfare_text": "包吃包住",
    "place": "观澜大道 88 号",
}
JOB_B = {
    "position_id": 9,
    "employer_id": 8,
    "factory_name": "龙华电子二厂",
    "job_title": "龙华电子二厂 组装",
    "wage_text": "21 元/小时",
    "hours_text": "长白班，月休 6 天",
    "age_text": "18-45 岁",
    "welfare_text": "包住",
    "place": "龙华大浪街道 12 号",
}


@pytest.fixture(autouse=True)
def _jobs():
    set_remote_jobs({**JOBS_BY_CITY, "深圳": [JOB_A, JOB_B]})
    yield
    set_remote_jobs({})
    set_position_scripts([])


class ScriptedProvider:
    """按预设逐个返回；Exception 项模拟超时/上游故障。"""

    def __init__(self, *replies) -> None:
        self.replies = list(replies)
        self.calls: list[list] = []

    async def complete(self, messages, **kwargs):  # noqa: ANN001, ANN003
        self.calls.append(messages)
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _event(seq: int, type_: str, body: dict) -> FlowEvent:
    return FlowEvent(
        session_key="c1", seq=seq, type=type_, body=json.dumps(body, ensure_ascii=False)
    )


def _carded_state() -> dict:
    """已发岗位卡（钉住岗位 A）的会话状态。"""
    state = new_state()
    engine_step(state, "深圳", now=NOW)
    assert state["slots"]["position_id"] == 3
    return state


def _decision(reply: str, **extra) -> str:
    return json.dumps({"reply": reply, "capture": {}, **extra}, ensure_ascii=False)


def _verdict(verdict: str, **extra) -> str:
    return json.dumps({"verdict": verdict, **extra}, ensure_ascii=False)


# ── AgentSession：轮次累积与压缩 ─────────────────────────────────


def test_transcript_records_user_and_sent_content() -> None:
    """客户消息与 AI 实发内容都入上下文；slot/stage 等非对话事件不入。"""
    events = [
        _event(1, "inbound", {"text": "深圳"}),
        _event(2, "slot_set", {"key": "city", "value": "深圳"}),
        _event(3, "reply", {"text": "厂名：观澜精密厂（质检）", "parts": ["a", "b"]}),
        _event(4, "inbound", {"text": "工资多少"}),
        _event(5, "reply", {"text": "工价：23 元/小时"}),
    ]
    transcript = agent_session.build_transcript(events)
    assert [item["role"] for item in transcript] == [
        "user", "assistant", "user", "assistant",
    ]
    assert transcript[0]["content"] == "深圳"
    assert transcript[1]["content"] == "厂名：观澜精密厂（质检）"
    assert transcript[3]["content"] == "工价：23 元/小时"


def test_transcript_surface_keeps_recent_12() -> None:
    """最简压缩：只保留最近 12 条轮次，更早的丢弃。"""
    events: list[FlowEvent] = []
    for i in range(10):
        events.append(_event(len(events) + 1, "inbound", {"text": f"消息{i}"}))
        events.append(_event(len(events) + 1, "reply", {"text": f"回复{i}"}))
    surfaced = agent_session.surface(agent_session.build_transcript(events))
    assert agent_session.TRANSCRIPT_LIMIT == 12
    assert len(surfaced) == 12
    assert surfaced[0]["content"] == "消息4"
    assert surfaced[-1]["content"] == "回复9"


def test_transcript_reset_clears_context() -> None:
    """reset 事件清空上下文（与 stage/slots 投影同一条规则）。"""
    events = [
        _event(1, "inbound", {"text": "深圳"}),
        _event(2, "reply", {"text": "你好"}),
        _event(3, "reset", {}),
        _event(4, "inbound", {"text": "在吗"}),
    ]
    transcript = agent_session.build_transcript(events)
    assert [item["content"] for item in transcript] == ["在吗"]


@pytest.mark.asyncio
async def test_transcript_over_http_user_and_ai_both_recorded(
    admin_client, monkeypatch
) -> None:
    """走真实 DB：客户消息与 AI 实发内容（含岗位卡）都能从事件日志投影出来。"""
    # 第 1 轮（发卡）模型措辞不采用，但决策调用仍会消费一条预设
    provider = ScriptedProvider(
        json.dumps({"reply": "占位", "capture": {"city": "深圳"}}, ensure_ascii=False),
        _decision("好的，想好了随时跟我说"),
    )
    monkeypatch.setattr("app.api_flow.build_provider", lambda: provider)
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: None)  # B 缺席
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")

    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list:
        return {"深圳": [JOB_A, JOB_B]}.get(city, [])

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)
    job_lookup.clear_cache()
    try:
        key = f"duo-{uuid.uuid4().hex[:8]}"
        resp = await admin_client.post(
            "/api/v1/flow/answer", json={"session_key": key, "text": "深圳"}
        )
        assert resp.status_code == 200, resp.text
        resp = await admin_client.post(
            "/api/v1/flow/answer", json={"session_key": key, "text": "我考虑一下"}
        )
        assert resp.status_code == 200, resp.text

        from app.db import SessionLocal

        async with SessionLocal() as db:
            transcript = await agent_session.load_transcript(db, key)
        assert transcript[0]["role"] == "user" and transcript[0]["content"] == "深圳"
        assistant = [t for t in transcript if t["role"] == "assistant"]
        assert any("观澜精密厂" in t["content"] for t in assistant)  # 卡片段入了上下文
        assert any("想好了随时跟我说" in t["content"] for t in assistant)
    finally:
        job_lookup.clear_cache()


# ── A：决策上下文带岗位信息 ──────────────────────────────────────


def test_decision_prompt_carries_transcript_and_candidates() -> None:
    """决策 Prompt：AgentSession 的 transcript + 同城候选岗位（名称+工价）。"""
    state = _carded_state()
    transcript = [
        {"role": "user", "content": "深圳"},
        {"role": "assistant", "content": "厂名：观澜精密厂（质检）"},
    ]
    messages = build_decision_messages(state, "有别的吗", now=NOW, transcript=transcript)
    system = messages[0].content
    assert "客户：深圳" in system
    assert "你：厂名：观澜精密厂（质检）" in system
    assert "龙华电子二厂" in system and "21 元/小时" in system  # 候选岗位简报
    assert "switch" in system  # 输出契约带 switch


@pytest.mark.asyncio
async def test_model_switch_sends_new_job_card() -> None:
    """A 输出 switch=true：job_index 切到候选岗位并发新岗位卡，快照/岗位 id 同步换。"""
    state = _carded_state()
    provider = ScriptedProvider(_decision("好嘞，给你换个厂看看", switch=True))
    result = await a_step(state, "这个厂我不想干了", provider, now=NOW)

    assert result.stage == STAGE_ASK_INTERVIEW
    assert any("龙华电子二厂" in part for part in result.parts)  # 新岗位卡
    assert state["slots"]["job_index"] == 1
    assert state["slots"]["position_id"] == 9
    assert state["slots"]["job_snapshot"]["factory_name"] == "龙华电子二厂"


@pytest.mark.asyncio
async def test_wants_more_deterministic_switch_sends_new_card() -> None:
    """「不想干这个有别的吗」走 _WANTS_MORE 确定性通道：同样切岗发新卡。"""
    state = _carded_state()
    result = await a_step(state, "不想干这个有别的吗", None, now=NOW)

    assert result.stage == STAGE_ASK_INTERVIEW
    assert any("龙华电子二厂" in part for part in result.parts)
    assert state["slots"]["position_id"] == 9
    assert state["slots"]["job_snapshot"]["factory_name"] == "龙华电子二厂"
    assert state["slots"]["interview_offer_sent"] is True


# ── B：审核循环 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_review_pass_sends_draft(monkeypatch) -> None:
    """B 通过 → 草稿原样直发，A 不重写。"""
    reviewer_provider = ScriptedProvider(_verdict("pass"))
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    state = _carded_state()
    provider = ScriptedProvider(_decision("这两天能不能过来面试？"))
    result = await a_step(state, "我再想想", provider, now=NOW)
    final = await review_loop(state, "我再想想", provider, result)

    assert final.parts == ["这两天能不能过来面试？"]
    assert len(provider.calls) == 1  # 只有决策调用，没有重写
    assert len(reviewer_provider.calls) == 1


@pytest.mark.asyncio
async def test_review_revise_once_then_rewrite_pass(monkeypatch) -> None:
    """B 打回一次 → A 重写（reason/suggestion 喂回）→ 再审通过 → 发重写稿。"""
    reviewer_provider = ScriptedProvider(
        _verdict("revise", reason="答非所问", suggestion="接住客户的话再推进"),
        _verdict("pass"),
    )
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    state = _carded_state()
    provider = ScriptedProvider(
        _decision("这两天能不能过来面试？"),
        "嗯嗯，那你想先了解哪方面？工价还是吃住？",
    )
    result = await a_step(state, "我再想想", provider, now=NOW)
    final = await review_loop(state, "我再想想", provider, result)

    assert final.parts == ["嗯嗯，那你想先了解哪方面？工价还是吃住？"]
    assert len(provider.calls) == 2  # 决策 1 次 + 重写 1 次
    rewrite_prompt = provider.calls[1][-1].content
    assert "答非所问" in rewrite_prompt and "接住客户的话" in rewrite_prompt
    assert len(reviewer_provider.calls) == 2  # B 审了 2 轮


@pytest.mark.asyncio
async def test_review_revise_twice_forced_fallback(monkeypatch) -> None:
    """打回两次 → 丢弃 B 意见，兜底强制发送（缺失清单第一项的确定性提问）。"""
    reviewer_provider = ScriptedProvider(
        _verdict("revise", reason="不行", suggestion="改"),
        _verdict("revise", reason="还是不行", suggestion="再改"),
    )
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    state = _carded_state()
    provider = ScriptedProvider(
        _decision("随便说点什么"),
        "我重新说一句完全不一样的话",
    )
    result = await a_step(state, "我再想想", provider, now=NOW)
    final = await review_loop(state, "我再想想", provider, result)

    assert final.reply  # 绝不静默不发
    assert final.parts == ["这两天能不能过来面试？"]  # 确定性兜底，不用重写稿
    assert len(reviewer_provider.calls) == 2  # B 最多审 2 轮


@pytest.mark.asyncio
async def test_forced_fallback_prefers_fact_answer(monkeypatch) -> None:
    """兜底顺序第一档：客户问岗位事实 → 事实卡直答（A 不在也照发）。"""
    reviewer_provider = ScriptedProvider(_verdict("revise", reason="重复", suggestion="换说法"))
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    state = _carded_state()
    from app.services.flow_engine import FlowResult

    result = FlowResult(
        reply="工价：23 元/小时",
        parts=["工价：23 元/小时"],
        stage=STAGE_ASK_INTERVIEW,
        slots=state["slots"],
    )
    final = await review_loop(state, "工资多少", None, result)
    assert final.parts == ["工价：23 元/小时"]


@pytest.mark.asyncio
async def test_reviewer_unavailable_sends_draft(monkeypatch) -> None:
    """B 没配（provider None）→ 草稿直接放行，无任何审核/重写调用。"""
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: None)
    state = _carded_state()
    provider = ScriptedProvider(_decision("这两天能不能过来面试？"))
    result = await a_step(state, "我再想想", provider, now=NOW)
    final = await review_loop(state, "我再想想", provider, result)
    assert final.parts == result.parts
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_reviewer_timeout_passes_draft(monkeypatch) -> None:
    """B 超时/异常 → 视为 pass，草稿直接放行（审核不是闸门）。"""
    reviewer_provider = ScriptedProvider(RuntimeError("upstream timeout"))
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    state = _carded_state()
    provider = ScriptedProvider(_decision("这两天能不能过来面试？"))
    result = await a_step(state, "我再想想", provider, now=NOW)
    final = await review_loop(state, "我再想想", provider, result)
    assert final.parts == ["这两天能不能过来面试？"]


@pytest.mark.asyncio
async def test_reviewer_flags_duplicate_of_recent_turn() -> None:
    """审核查重（代码级，无模型也生效）：与上一轮 AI 内容雷同 → 打回。"""
    reviewer = Reviewer(None)
    transcript = [
        {"role": "assistant", "content": "这个岗位包吃包住，两班倒。"},
        {"role": "user", "content": "哦哦"},
    ]
    verdict = await reviewer.review(
        transcript, ["这个岗位包吃包住，两班倒！"], "工价：23 元/小时", {}
    )
    assert verdict["verdict"] == "revise"
    assert "重复" in verdict["reason"]


@pytest.mark.asyncio
async def test_reviewer_flags_placeholder_residue() -> None:
    """占位符残留（{{x}}/{x}）→ 打回，绝不发给客户。"""
    reviewer = Reviewer(None)
    verdict = await reviewer.review([], ["工价是 {{wage}} 哦"], "工价：23 元/小时", {})
    assert verdict["verdict"] == "revise"
    assert "占位符" in verdict["reason"]


@pytest.mark.asyncio
async def test_rewrite_with_fake_wage_rejected_falls_back(monkeypatch) -> None:
    """重写稿编造工价 → _fact_guard 拦下 → 兜底强制发送，假数字不出现。"""
    reviewer_provider = ScriptedProvider(
        _verdict("revise", reason="答非所问", suggestion="直答"),
        _verdict("revise", reason="还是不行", suggestion="再改"),
    )
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    state = _carded_state()
    provider = ScriptedProvider(
        _decision("这个岗位很不错哦"),
        "跟你说实话，这个岗时薪30，别家给不了。",
    )
    result = await a_step(state, "我再想想", provider, now=NOW)
    final = await review_loop(state, "我再想想", provider, result)

    assert all("30" not in part for part in final.parts)
    assert final.parts == ["这两天能不能过来面试？"]  # 退确定性兜底


@pytest.mark.asyncio
async def test_script_reviewed_but_never_rewritten(monkeypatch) -> None:
    """话术草稿也送 B，但 B 只能查残留/重复（代码级）；LLM 意见不参与，原文直发。"""
    reviewer_provider = ScriptedProvider(
        _verdict("revise", reason="文案呆板", suggestion="活泼一点")
    )
    monkeypatch.setattr(reviewer_mod, "build_provider", lambda: reviewer_provider)
    set_position_scripts(
        [
            {
                "position_id": 3,
                "stage": "send_info",
                "content": "运营台词：观澜精密厂 23 元/小时【图片:厂门.jpg】",
            }
        ]
    )
    state = new_state()
    state["stage"] = "send_info"
    state["slots"].update({"city": "深圳", "position_id": 3})  # 之前发卡时已钉岗位 A
    result = await a_step(state, "深圳", None, now=NOW)
    assert result.source == "script"
    assert any("运营台词" in part for part in result.parts)

    final = await review_loop(state, "深圳", None, result, [])
    assert final.parts == result.parts  # 话术原文直发，不被改写
    assert len(reviewer_provider.calls) == 0  # LLM 意见不参与话术审核

    # 话术带占位符残留：代码级查到、打回渲染层；渲染层已确定性渲染过，
    # B 无权改写 → 按原文案强制发送（绝不静默不发）
    from app.services.flow_engine import FlowResult

    residue = FlowResult(
        reply="台词 {{wage}}",
        parts=["台词 {{wage}}"],
        stage="send_info",
        slots=state["slots"],
        source="script",
    )
    final = await review_loop(state, "深圳", None, residue, [])
    assert final.parts == ["台词 {{wage}}"]

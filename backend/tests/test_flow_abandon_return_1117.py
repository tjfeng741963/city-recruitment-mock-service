"""流失客户回流必须被接待，但只接待一次；且未真约成不许说「登记好了」。

2026-11-17 Evans_峰 实测复盘：
  1. 他说「我要后天才能到」没被认成同意 → 两小时后又追问面试 → 他答「不能」
     被判流失 → 此后连发 5 条「你好」一条都没回；
  2. 他给的手机号只有 10 位没采到，booked 从未置位，回复却说「登记好了」。

三条约束：回流第一条必回且解除标记；再次拒绝重新静音；没约成不许声称约成。
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.services import flow_engine as engine
from app.services import flow_llm
from app.services import job_lookup
from tests.fixture_jobs import JOBS_BY_CITY

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _no_llm_and_remote_jobs(monkeypatch):  # noqa: ANN001
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


async def _to_abandoned(client: AsyncClient, key: str) -> None:
    """走到「客户明确说不来」的终态。"""
    await _say(client, key, "东莞")
    last = await _say(client, key, "那我去不了面试")
    assert last["stage"] == "done"
    assert last["slots"]["recruit_status"] == "disqualified"


async def test_returning_customer_gets_reopen_reply_and_marker_cleared(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _to_abandoned(admin_client, key)

    back = await _say(admin_client, key, "你好")
    assert back["finished"] is False
    assert back["slots"]["recruit_status"] == ""
    assert back["slots"]["abandon_return_count"] == 1
    # 必须真的回了话，而且不是终止语
    assert back["reply"].strip()
    assert "不打扰" not in back["reply"]
    # 不能一回来就重新邀约（上一轮刚拒绝过）
    assert "这两天能不能过来面试" not in back["reply"]


async def test_second_refusal_after_return_silences_with_closing_line(admin_client: AsyncClient) -> None:
    key = f"test-{uuid.uuid4().hex[:8]}"
    await _to_abandoned(admin_client, key)
    await _say(admin_client, key, "你好")

    again = await _say(admin_client, key, "算了 我不去了")
    assert again["stage"] == "done"
    assert again["slots"]["recruit_status"] == "disqualified"
    assert "不打扰" in again["reply"]

    # 第三次再来消息：回流额度已用完，回到终止语，不再反复接待
    third = await _say(admin_client, key, "你好")
    assert "不打扰" in third["reply"]
    assert third["slots"]["abandon_return_count"] == 1


def test_arrival_day_counts_as_agreeing_not_as_plain_statement() -> None:
    assert engine.states_arrival_day("我要后天才能到")
    assert engine.agrees_to_interview("我要后天才能到")
    assert not engine.agrees_to_interview("我不去了")
    assert not engine.agrees_to_interview("后天能不能到？")


def test_claiming_booking_without_phone_is_rewritten_to_question() -> None:
    """模型说「登记好了」但手机号没采到时必须改口要手机号。"""
    # 直接调引擎（不经 HTTP）时必须自己注入岗位，否则会停在「该城市没有厂」分支
    engine.set_remote_jobs(JOBS_BY_CITY)
    try:
        state = engine.new_state()
        engine.step(state, "东莞")
        assert state["slots"].get("interview_offer_sent") is True
        state["stage"] = "collect"
        state["slots"]["interview_agreed"] = True
        state["slots"]["name"] = "万小姐"
        # 手机号故意留空：客户给的是 10 位数字，抽取器不认

        # apply_decision 是同步函数（只有 a_step 才是 async）
        result = flow_llm.apply_decision(
            state,
            {"reply": "收到啦万小姐，我这边登记好了，后天到了直接来。", "stage": "collect"},
            "万小姐，1233131213",
        )
    finally:
        engine.set_remote_jobs({})
    assert "登记好了" not in result.reply
    assert "手机" in result.reply or "电话" in result.reply
    assert not state["slots"].get("booked")


def test_claims_booking_detects_common_phrasings() -> None:
    assert engine.claims_booking("收到啦万小姐，我这边登记好了")
    assert engine.claims_booking("已经帮你登记好了，后天到了直接来")
    assert engine.claims_booking("预约成功，明天见")
    assert not engine.claims_booking("方便的话留个手机号我帮你登记")
    assert not engine.claims_booking("麻烦把姓名和手机号一起发我")

"""流程文字可配置（2026-11-17）。

背景：运营要「把流程每一步要说的话都在页面上改」，而原来只有 greet /
send_info / ask_interview / booked 四个时点能配，其余五句写死在代码里：
问城市、要姓名电话、放弃挽留、流失回流、流失后再来的收尾。

本次把这五句也接到 position_scripts 上（stage: ask_city / collect /
gave_up / reopen / closing）。规则与已有话术一致：

  * 配了就用运营原话，没配一律退回原来的内置默认——绝不能因为没配就不回话；
  * 发生在「还没钉岗位」的时候，所以基本命中 position_id=0 的通用条目；
  * 占位符由代码替换：{{cities}} 在招城市、{{missing}} 当前缺的资料、
    {{city}}/{{factory}} 客户上次的意向；不认识的占位符清空，绝不发给客户；
  * 绝不借别的岗位的文案（2026-11-14 串厂事故的同类风险）。
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.services import device_scripts, job_lookup
from app.services import flow_engine as engine
from app.services.flow_engine import set_position_scripts, set_remote_jobs

JOBS = [
    {
        "position_id": 3,
        "factory_name": "观澜精密厂",
        "job_title": "观澜精密厂 质检",
        "wage_text": "23 元/小时",
        "hours_text": "两班倒，月休 4 天",
        "age_text": "18-40 岁",
        "welfare_text": "包吃包住",
        "place": "观澜大道 88 号",
    }
]


@pytest.fixture(autouse=True)
def _isolate(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])
    yield
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])


@pytest.fixture
def remote_jobs(monkeypatch):  # noqa: ANN001, ANN201
    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
        return [dict(job) for job in JOBS]

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)


def _stub_scripts(monkeypatch, scripts: list[dict]) -> None:  # noqa: ANN001
    async def fake_position_scripts(device_code: str) -> list[dict]:
        return [dict(item) for item in scripts]

    monkeypatch.setattr("app.api_flow.fetch_position_scripts", fake_position_scripts)
    set_position_scripts([dict(item) for item in scripts])


async def _say(client: AsyncClient, key: str, text: str, **extra) -> dict:
    resp = await client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": text, **extra}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _general(stage: str, content: str) -> dict:
    return {"position_id": 0, "stage": stage, "title": stage, "content": content}


# ── ask_city ───────────────────────────────────────────────────────


def test_city_ask_uses_configured_text_and_cities_placeholder() -> None:
    set_position_scripts([_general("ask_city", "您好，请问您在哪个城市？我们{{cities}}都有岗位。")])
    text = engine._city_ask({})
    assert text.startswith("您好，请问您在哪个城市？")
    assert "{{" not in text


def test_city_ask_falls_back_to_builtin_when_unconfigured() -> None:
    """没配就必须还是原来那句——不能因为加了配置项就变成空回复。"""
    text = engine._city_ask({})
    assert "哪个城市" in text


def test_unknown_placeholder_is_stripped_never_sent() -> None:
    set_position_scripts([_general("ask_city", "你在哪个城市？{{not_a_real_placeholder}}")])
    text = engine._city_ask({})
    assert "{{" not in text and "}}" not in text


def test_city_ask_never_borrows_other_position_text() -> None:
    """只配了 3 号岗的 ask_city：别的岗位来问城市时不准套那段文案。"""
    set_position_scripts([{"position_id": 3, "stage": "ask_city", "content": "三号岗专问"}])
    assert engine._city_ask({"position_id": 9}) != "三号岗专问"
    # 精确命中时照用
    assert engine._city_ask({"position_id": 3}) == "三号岗专问"


# ── collect ────────────────────────────────────────────────────────


def test_collect_uses_configured_text_with_missing_placeholder() -> None:
    set_position_scripts([_general("collect", "麻烦把{{missing}}发我，我这边登记。")])
    assert engine._collect_ask("name") == "麻烦把姓名发我，我这边登记。"
    assert engine._collect_ask("phone") == "麻烦把手机号发我，我这边登记。"
    assert engine._collect_ask() == "麻烦把姓名和手机号发我，我这边登记。"


def test_collect_falls_back_to_builtin_per_missing_field() -> None:
    assert "姓名" in engine._collect_ask("name")
    assert "手机号" in engine._collect_ask("phone")
    both = engine._collect_ask()
    assert "姓名" in both and "手机号" in both


# ── gave_up ────────────────────────────────────────────────────────


def test_gave_up_uses_configured_text() -> None:
    set_position_scripts([_general("gave_up", "好的，祝您顺利。")])
    assert engine._gave_up_text({}) == "好的，祝您顺利。"


def test_gave_up_falls_back_when_unconfigured() -> None:
    assert "不打扰" in engine._gave_up_text({})


async def test_gave_up_text_actually_sent_on_refusal(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    _stub_scripts(monkeypatch, [_general("gave_up", "好的，那先这样，想好了随时找我。")])
    key = f"txt-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")
    refused = await _say(admin_client, key, "我不去了")
    assert refused["action"] == "gave_up"
    assert refused["reply"] == "好的，那先这样，想好了随时找我。"


# ── reopen / closing（流失回流）────────────────────────────────────


async def test_reopen_and_closing_use_configured_text(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    """回流语整场只发一次；第二次再来只发收尾语。两句都要能被后台改。"""
    _stub_scripts(
        monkeypatch,
        [
            _general("gave_up", "好的，那先这样。"),
            _general("reopen", "在的，{{factory}}这边还可以了解，你想看岗位还是安排面试？"),
            _general("closing", "好的，那不打扰了。"),
        ],
    )
    key = f"txt-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")
    await _say(admin_client, key, "我不去了")
    return_reply = await _say(admin_client, key, "你好，我还在考虑")

    assert return_reply["reply"].startswith("在的，观澜精密厂这边还可以了解")
    assert return_reply["slots"]["abandon_return_count"] == 1

    await _say(admin_client, key, "还是不去了")
    closing = await _say(admin_client, key, "在吗")
    assert closing["reply"] == "好的，那不打扰了。"


def test_reopen_message_cannot_smuggle_an_invite() -> None:
    """运营在回流语里写了带邀约的句子：客户表达顾虑时仍会被限流掉。

    限流规则来自 flow_engine.throttle_invite（顾虑词 / 已问满两次），
    不交给文案自己决定——回流语的第一句不该是「这两天能不能过来」。
    """
    parts = engine.throttle_invite(
        ["在的，这两天能不能过来面试？名额给你留着。"], {}, "你好，我还有点顾虑"
    )
    assert "面试" not in "\n".join(parts)


# ── 渲染细节 ───────────────────────────────────────────────────────


def test_stage_script_renders_job_facts_for_configured_text() -> None:
    set_remote_jobs({"深圳": [dict(job) for job in JOBS]})
    set_position_scripts([_general("reopen", "{{factory}}还在招，工价{{wage}}。")])
    slots = {"city": "深圳", "position_id": 3}
    text = engine._stage_script(slots, engine.SCRIPT_STAGE_REOPEN)
    assert text == "观澜精密厂还在招，工价23 元/小时。"


def test_stage_script_extra_placeholders_dont_override_job_facts() -> None:
    """extra 只补岗位没有的键：占位符不能盖掉岗位事实。"""
    set_remote_jobs({"深圳": [dict(job) for job in JOBS]})
    set_position_scripts([_general("reopen", "{{factory}}")])
    slots = {"city": "深圳", "position_id": 3}
    assert engine._stage_script(slots, engine.SCRIPT_STAGE_REOPEN, {"factory": "假厂"}) == "观澜精密厂"

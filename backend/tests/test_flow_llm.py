"""LLM 驱动层的测试：一轮只有一次模型调用，回复归模型，事实归代码。

红线：
1. 数字/地址必须能在素材里找到原文，编造的分句被剔除
2. 图片/视频只能引用素材清单里的名称
3. 已约好的客户不许再被推销岗位
4. 岗位介绍三段必须同源（不能混其他岗位的工价/地点/年龄）
5. 模型挂了，客户也必须有话说
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from app.services.flow_engine import (
    ACTION_BOOK,
    ACTION_GAVE_UP,
    INTERVIEW_WINDOW,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    STAGE_SEND_INFO,
    TZ,
    new_state,
    set_remote_jobs,
)
from app.services.flow_llm import a_step, build_material, build_messages, apply_result
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 8, 14, 0, tzinfo=TZ)


@pytest.fixture(autouse=True)
def _remote_jobs():
    """引擎只认注入的远端岗位：测试统一注入岗位夹具。"""
    set_remote_jobs(JOBS_BY_CITY)
    yield
    set_remote_jobs({})


class ScriptedProvider:
    def __init__(self, *replies: str | Exception) -> None:
        self.replies = list(replies)
        self.calls: list[list] = []

    async def complete(self, messages, **kwargs):  # noqa: ANN001, ANN003
        self.calls.append(messages)
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _state_after_info() -> dict:
    """信息已发、正在等客户表态。"""
    state = new_state()
    state["stage"] = STAGE_ASK_INTERVIEW
    state["slots"].update({"city": "东莞", "job_index": 0, "interview_offer_sent": True})
    state["history"] = [
        {"role": "customer", "text": "东莞的 有什么岗位吗"},
        {"role": "agent", "text": "厂名：长安五金厂……"},
    ]
    return state


@pytest.mark.asyncio
async def test_city_turn_model_organizes_info_parts() -> None:
    """说了城市：模型组织三段（岗位/地点时间/邀约），事实必须来自岗位素材。"""
    parts = [
        "厂名：长安五金厂（操作工）\n工价：19 元/小时\n班次：两班倒，月休 2 天\n"
        "年龄：18-50 岁\n吃住：包住，饭补 300 元/月",
        "面试地点：长安镇乌沙社区\n面试时间：明天（11月9日）09:00-11:00",
        "这两天能不能过来面试？能来的话我把名额给你留着。",
    ]
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "\n\n".join(parts),
                "parts": parts,
                "stage": "send_info",
                "slots": {"city": "东莞"},
            },
            ensure_ascii=False,
        )
    )
    state = new_state()
    result = await a_step(state, "东莞", provider, now=NOW)

    assert len(provider.calls) == 1
    assert result.stage == STAGE_ASK_INTERVIEW
    assert result.slots["interview_offer_sent"] is True
    assert len(result.parts) == 3
    assert "厂名：长安五金厂" in result.parts[0]
    assert "19 元/小时" in result.parts[0]
    assert INTERVIEW_WINDOW in result.parts[1]
    assert "能不能过来面试" in result.parts[2]


@pytest.mark.asyncio
async def test_model_reply_is_used_and_slots_applied() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "能来的话我这边给你留名额，你大概几点到？",
                "stage": "ask_interview",
                "slots": {"city": "东莞"},
                "action": None,
                "finished": False,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "我看看时间", provider, now=NOW)

    assert "留名额" in result.reply
    assert result.stage == STAGE_ASK_INTERVIEW
    assert result.slots["city"] == "东莞"


@pytest.mark.asyncio
async def test_fabricated_pay_falls_back() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "长安五金厂 30 元/小时，包吃包住，你来不来？",
                "stage": "ask_interview",
                "slots": {"city": "东莞"},
                "finished": False,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "工价多少", provider, now=NOW)
    assert "30 元" not in result.reply


@pytest.mark.asyncio
async def test_booking_requires_name_and_phone() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "好嘞，那就这么定了。",
                "stage": "done",
                "slots": {"city": "东莞"},
                "action": ACTION_BOOK,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    state["slots"]["interview_agreed"] = True
    state["stage"] = STAGE_COLLECT
    result = await a_step(state, "可以", provider, now=NOW)

    # 姓名手机没齐，不许约成
    assert result.stage == STAGE_COLLECT
    assert result.slots.get("booked") is None
    assert "姓名" in result.reply and "手机" in result.reply


@pytest.mark.asyncio
async def test_booking_time_comes_from_code() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "好嘞，明天见。",
                "stage": "done",
                "slots": {"city": "东莞"},
                "profile": {"name": "张三", "phone": "13800138000"},
                "action": ACTION_BOOK,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    state["slots"]["interview_agreed"] = True
    state["stage"] = STAGE_COLLECT
    result = await a_step(state, "张三 13800138000", provider, now=NOW)

    assert result.finished is True
    assert result.stage == STAGE_DONE
    assert result.slots["interview_at"] == "2026-11-09T09:00:00+08:00"
    assert result.slots["interview_place"] == "长安镇乌沙社区"
    assert result.slots["interview_window"] == INTERVIEW_WINDOW


@pytest.mark.asyncio
async def test_gave_up_action_ends_flow() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "行，那你想来再说。",
                "stage": "done",
                "action": ACTION_GAVE_UP,
                "finished": True,
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "这两天来不了", provider, now=NOW)

    assert result.stage == STAGE_DONE and result.finished is True
    assert result.action == ACTION_GAVE_UP
    assert result.slots["recruit_status"] == "disqualified"


@pytest.mark.asyncio
async def test_model_failure_still_replies() -> None:
    provider = ScriptedProvider(RuntimeError("upstream 502"))
    state = _state_after_info()
    result = await a_step(state, "可以", provider, now=NOW)
    assert result.reply
    assert result.stage == STAGE_COLLECT


@pytest.mark.asyncio
async def test_kb_question_uses_kb_material_in_one_call() -> None:
    """插问也由模型回，但知识库原文作为素材进上下文（不另起确定性分支）。"""
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "体检费先自己出，满一个月厂里报销。",
                "stage": "ask_interview",
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(
        state, "体检要花钱吗", provider, now=NOW, kb_answer="体检费先自己出，满一个月厂里报销。"
    )

    assert len(provider.calls) == 1
    system = provider.calls[0][0].content
    assert "体检费先自己出" in system
    assert result.parts[0] == "体检费先自己出，满一个月厂里报销。"
    assert result.stage == STAGE_ASK_INTERVIEW


@pytest.mark.asyncio
async def test_kb_miss_reports_unknown_question_with_model() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {"reply": "这个我确认一下，稍后回你", "stage": "ask_interview"},
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "宿舍有没有空调", provider, now=NOW)

    assert len(provider.calls) == 1
    assert result.unknown_question == "宿舍有没有空调"
    assert "这个我确认一下，稍后回你" in result.reply


def test_surface_only_carries_recent_context() -> None:
    state = _state_after_info()
    state["history"] = [
        {"role": "customer", "text": f"历史{i}"} for i in range(30)
    ] + [{"role": "customer", "text": "最新一句"}]
    messages = build_messages(state, "最新一句", now=NOW)
    user = messages[-1].content
    assert "最新一句" in user
    assert "历史0" not in user
    assert "19 元/小时" in messages[0].content  # 岗位数据在系统提示里


@pytest.mark.asyncio
async def test_booked_customer_gets_model_but_no_job_card() -> None:
    """已约客户：模型照常答疑/确认，但岗位卡必须被代码丢弃（反面案例护栏）。"""
    provider = ScriptedProvider(
        json.dumps(
            {
                "parts": [
                    "你约的是明天09:00-11:00，在番禺南村员岗地铁站附近，到了联系我就行。",
                    "厂名：利口福食品厂（普工）\n工价：16 元/小时\n班次：两班倒，月休 2-4 天",
                ],
                "stage": "done",
            },
            ensure_ascii=False,
        )
    )
    state = new_state()
    state["stage"] = STAGE_DONE
    state["slots"] = {"city": "广州", "booked": True}

    result = await a_step(state, "我到了找谁", provider, now=NOW)

    assert len(provider.calls) == 1
    assert "禁止再推销岗位" in provider.calls[0][0].content
    assert "厂名：" not in result.reply and "16 元" not in result.reply
    assert "员岗地铁站附近" in result.reply
    assert result.stage == STAGE_DONE and result.finished is True


@pytest.mark.asyncio
async def test_other_job_facts_are_rejected_as_mixed_source() -> None:
    """三段同源：混入其他岗位的地点 → 回退主推岗位的素材原文。"""
    provider = ScriptedProvider(
        json.dumps(
            {
                "parts": [
                    "厂名：利口福食品厂（普工）\n工价：16 元/小时",
                    "面试地点：白云区太和镇物流大道 9 号",  # 广州第二个岗位的地址
                ],
                "stage": "send_info",
                "slots": {"city": "广州"},
            },
            ensure_ascii=False,
        )
    )
    state = new_state()
    state["stage"] = STAGE_SEND_INFO
    state["slots"].update({"city": "广州", "job_index": 0})

    result = await a_step(state, "看看岗位", provider, now=NOW)

    # 混用被拦下 → 整轮回退主推岗位的三段素材
    assert "白云区太和镇" not in result.reply
    assert "番禺南村员岗地铁站附近" in result.reply
    assert "16 元/小时" in result.reply
    assert len(result.parts) == 3


@pytest.mark.asyncio
async def test_media_marker_outside_whitelist_is_removed() -> None:
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "体检在【图片:体检中心】这里，另外这个【视频:不存在】也看看。",
                "stage": "ask_interview",
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(
        state, "体检在哪", provider, now=NOW, kb_answer="体检在【图片:体检中心】"
    )

    assert "【图片:体检中心】" in result.reply
    assert "不存在" not in result.reply


@pytest.mark.asyncio
async def test_fabricated_age_time_address_are_dropped() -> None:
    """数字护栏扩展到年龄/时间/地址：编的整句剔除，回退素材原文。"""
    provider = ScriptedProvider(
        json.dumps(
            {
                "reply": "年龄 16-40 岁也可以。面试下午 15:30。地址在白云区太和镇。",
                "stage": "ask_interview",
            },
            ensure_ascii=False,
        )
    )
    state = _state_after_info()
    result = await a_step(state, "说下条件", provider, now=NOW)

    for fabricated in ("16-40 岁", "15:30", "白云区太和镇"):
        assert fabricated not in result.reply
    # 剔空后回退素材原文（邀约问句）
    assert "能不能过来面试" in result.reply


def test_kb_repeat_is_a_material_hint_not_a_code_override() -> None:
    """KB 二次命中：只在素材里提示「别整段重发」，不再用代码短句覆盖模型回复。"""
    state = _state_after_info()
    mat = build_material(
        state,
        "还有视频吗",
        now=NOW,
        kb_body="安检岗位工作视频【视频:安检工作】",
        kb_repeat=True,
    )
    messages = build_messages(state, "还有视频吗", now=NOW, material=mat)
    system = messages[0].content
    assert "以前已经发过" in system
    assert "【视频:安检工作】" in system

    result = apply_result(
        state,
        {
            "reply": "在的，视频再发你一次【视频:安检工作】",
            "stage": "ask_interview",
        },
        "还有视频吗",
        now=NOW,
        material=mat,
    )
    assert result.reply == "在的，视频再发你一次【视频:安检工作】"


def test_material_has_one_primary_and_only_job_names_for_others() -> None:
    """素材里只有一条主推岗位的完整字段，其余岗位只给名称。"""
    state = new_state()
    state["slots"].update({"city": "广州", "job_index": 0})
    mat = build_material(state, "广州", now=NOW)
    text = build_messages(state, "广州", now=NOW, material=mat)[0].content

    assert "16 元/小时" in text  # 主推岗位全字段
    assert "22 元/小时" not in text  # 其他岗位的工价不给
    assert "白云物流园" in text  # 但名称给，模型能说「还有一个」

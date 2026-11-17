"""灰度实测暴露的答非所问、编造现场动作、无休止邀约。

2026-11-17 灰度（真实企微对话）复盘：
  1. 桂花连问三次「工资什么时候结」→ 三次都收到同一张工价表，最后
     「你不和我说明白我不去面试」流失；
  2. 客户说「我在番禺钟村」，系统回「我在打印面试表，叫了我主管去门口接你进来」
     ——纯属编造，客户真去了会落空；
  3. Z 连问 5 个问题，每条回复末尾都挂「这两天能不能过来面试」，客户明说
     「你好多问题都没回答我，还有点顾虑」后仍被追问。
"""

from __future__ import annotations

import pytest

from app.services import flow_engine as engine
from app.services.reviewer import _fabricated_action, _hard_checks


@pytest.fixture(autouse=True)
def _clean_remote():
    engine.set_remote_jobs({})
    engine.set_position_scripts([])
    yield
    engine.set_remote_jobs({})
    engine.set_position_scripts([])


def _slots(**extra):
    snapshot = {
        "factory_name": "广州地铁安检",
        "wage_text": "试用期：120/班，连班240/天",
        "hours_text": "早班6:30-14:30\n晚班14:30-22:30",
        "age_text": "18-35岁",
        # 灰度里运营把线路写进了 welfare_text，line_text 为空
        "welfare_text": "安排线路：11-13-21号线，海珠有轨电车",
        # advance_text（发薪日）运营没配
        "advance_text": "",
        "place": "冠宇商务中心2楼224",
    }
    snapshot.update(extra.pop("snapshot", {}))
    slots = {"city": "广州", "job_snapshot": snapshot}
    slots.update(extra)
    return slots


def test_pay_date_question_never_answered_with_wage_table():
    """问「工资什么时候结」时快照没有发薪日：必须承认要确认，不能回工价表。"""
    slots = _slots()
    for text in ("工资什么时候结", "几号发工资", "工资是月结吗", "是什么时候发工资"):
        answer = engine._job_fact_answer(slots, text)
        assert "120/班" not in answer, f"{text!r} 又被工价表抢答：{answer!r}"


def test_pay_date_question_uses_configured_pay_date():
    """快照里配了发薪日就照实答，而不是答工价。"""
    slots = _slots(snapshot={"advance_text": "每月15号发上月工资"})
    answer = engine._job_fact_answer(slots, "几号发工资")
    assert "15号" in answer and "120/班" not in answer


def test_plain_wage_question_still_answers_wage():
    """「工资多少」问的是金额，不能被发薪日规则拦掉。"""
    slots = _slots()
    answer = engine._job_fact_answer(slots, "工资多少")
    assert "120/班" in answer


@pytest.mark.parametrize("text", [
    "我在打印面试表，叫了我主管去门口接你进来，你给他打个电话找他",
    "已经安排人去门口接你了",
    "我在楼下等你，到了给我打电话",
])
def test_fabricated_scene_actions_are_blocked(text):
    """编造「我在现场/已安排人接待」必须被硬拦截。"""
    verdict = _hard_checks([text], fact_card="", transcript=[])
    assert verdict is not None and verdict["verdict"] == "revise", text


@pytest.mark.parametrize("text", [
    "我在广州，你在哪里面试？",
    "这个我确认一下，核实好回你",
    "工作地点在冠宇商务中心2楼224",
])
def test_normal_replies_are_not_blocked(text):
    """地点陈述、承诺核实、正常地点答复都不该被误杀。"""
    assert _fabricated_action(text) == ""


def test_invite_is_throttled_after_repeated_asking():
    """客户没提面试、且已问过两次：本轮回复不许再挂邀约。"""
    slots = {"invite_ask_count": engine._INVITE_ASK_LIMIT}
    parts = ["住宿是4人间，空调热水都有。", "这两天能不能过来面试？能来的话我把名额给你留着。"]
    out = engine.throttle_invite(parts, slots, "住宿是几人间")
    joined = "\n".join(out)
    assert "面试" not in joined and "名额" not in joined
    assert "4人间" in joined, "只删邀约，不能连答案一起删"


def test_invite_suppressed_when_customer_voices_concern():
    """客户表达顾虑时，即使没到次数也禁止邀约。"""
    slots = {"invite_ask_count": 0}
    parts = ["这几项我确认后回你。", "这两天方便过来面试吗？"]
    out = engine.throttle_invite(parts, slots, "你好多问题都没回答我，还有点顾虑")
    assert "面试" not in "\n".join(out)


def test_invite_kept_when_customer_asks_about_interview():
    """客户自己提面试时，邀约不算骚扰，保留并计数。"""
    slots = {"invite_ask_count": engine._INVITE_ASK_LIMIT}
    parts = ["面试时间是周一至周六上午11:00-11:30。", "你哪天方便过来？"]
    out = engine.throttle_invite(parts, slots, "我明天想过去面试")
    assert "哪天方便过来" in "\n".join(out)


def test_invite_removed_entirely_falls_back_to_neutral_line():
    """整条回复只有邀约时，不能发出空消息。"""
    slots = {"invite_ask_count": engine._INVITE_ASK_LIMIT}
    out = engine.throttle_invite(["这两天能不能过来面试？"], slots, "还有什么要求")
    assert out and out[0].strip() and "面试" not in out[0]

"""老客户识别（客户原话：从客户聊天后，AI 判断转为老友）。

判定后 4222 会把他标成「不可聊」，AI 不再自动回复——误判的代价是客户被静音，
所以这里锁死「只认客户自述」这一条边界，并明确拒绝几类看似像、其实不该判的句子。
"""
from __future__ import annotations

import pytest

from app.services.old_friend import detect_old_friend, old_friend_fields


@pytest.mark.parametrize(
    "text",
    [
        "我之前来过你们这",
        "上次面试没去成，这次还能约吗",
        "以前在你们厂干过",
        "又来问一下现在还招不招",
        "我是老客户了",
        "之前跟你们聊过的",
    ],
)
def test_detects_customer_self_reported_past_visits(text):
    assert detect_old_friend(text) != ""


@pytest.mark.parametrize(
    "text",
    [
        "你们现在还招人吗",
        "工资多少",
        "之前说的工资是多少",          # 「之前」单独出现，谈的是本次对话内容
        "明天能过去面试吗",
        "我想找个包吃住的",
        "",
    ],
)
def test_does_not_flag_normal_inquiries(text):
    assert detect_old_friend(text) == ""


def test_returns_the_matched_phrase_for_audit():
    phrase = detect_old_friend("我之前来过你们这，现在还想干")
    assert phrase
    assert phrase in "我之前来过你们这，现在还想干"


def test_profile_fields_only_appear_on_hit():
    assert old_friend_fields("你们还招人吗") == {}
    fields = old_friend_fields("上次面试没去成")
    assert fields["old_friend"] is True
    assert fields["old_friend_reason"]

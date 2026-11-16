"""话术分段 + 面试通知（2026-11-15 线上实测回归）。

背景（客户实测原话）：「1消息分段发，AI现在融在一起了 … 3面试通知」。
现象：运营在岗位话术里写好的【用人要求】【上班时间】【工资待遇】三条，
客户端只收到一条糊在一起的长消息；约上面试后后台配的「面试通知模板」
一个字都没发出去。

两条行为都要保住：
  * 分段只按空行/行首【标题】切，段内一个字都不许改（工价是事故级数据）
  * 面试通知只在约成后发一次，模板为空就不发，绝不编内容
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.services.flow_engine import (
    STAGE_COLLECT,
    TZ,
    new_state,
    set_position_scripts,
    set_remote_jobs,
    split_by_section_heads,
    split_script_sections,
    step,
)
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=TZ)

SECTIONS = (
    "【用人要求】18-45岁，男女不限，能吃苦\n"
    "\n"
    "【上班时间】长白班，8:00-20:00\n"
    "\n"
    "【工资待遇】纯工价18元/小时，包吃包住"
)

JOB = {
    "position_id": 5,
    "employer_id": 9,
    "factory_name": "观澜精密厂",
    "job_title": "观澜精密厂 质检",
    "wage_text": "23 元/小时",
    "hours_text": "两班倒，月休 4 天",
    "age_text": "18-40 岁",
    "welfare_text": "包吃包住",
    "place": "观澜大道 88 号",
    "interview_time": "上午09:00-11:00",
    "interview_notice": "【面试须带】身份证原件、复印件两张\n\n【到了找谁】到了打 13800138000",
}


@pytest.fixture(autouse=True)
def _jobs():
    set_remote_jobs({**JOBS_BY_CITY, "深圳": [JOB]})
    yield
    set_remote_jobs({})
    set_position_scripts([])


# ── 分段 ────────────────────────────────────────────────────────


def test_split_on_blank_lines() -> None:
    parts = split_script_sections(SECTIONS)
    assert len(parts) == 3
    assert parts[0] == "【用人要求】18-45岁，男女不限，能吃苦"
    assert parts[2] == "【工资待遇】纯工价18元/小时，包吃包住"


def test_split_on_section_headers_without_blank_lines() -> None:
    """运营常常不敲空行，只写【标题】——这种也必须切开。"""
    parts = split_script_sections("【用人要求】18-45岁\n【上班时间】长白班\n【工资待遇】18元/小时")
    assert parts == ["【用人要求】18-45岁", "【上班时间】长白班", "【工资待遇】18元/小时"]


def test_plain_text_is_not_split() -> None:
    """一段普通话术不许被拆成碎片——只有一段就原样返回。"""
    text = "深圳电子厂招普工，工价18元/小时，包吃住，明天可以来面试"
    assert split_script_sections(text) == [text]


def test_media_marker_stays_inside_its_section() -> None:
    """图片标记不能被切成单独一段：客户端会把纯标记段当成空文本跳过。"""
    parts = split_script_sections("【岗位信息】工价 18 元/小时\n【图片:厂门.jpg】\n\n【上班时间】长白班")
    assert parts[0] == "【岗位信息】工价 18 元/小时\n【图片:厂门.jpg】"
    assert parts[1] == "【上班时间】长白班"


def test_empty_input_returns_nothing() -> None:
    assert split_script_sections("") == []
    assert split_script_sections("   \n\n  ") == []


# ── 模型回复的分段收口 ──────────────────────────────────────────
# 设备级话术会作为素材交给模型组织，模型会把三段塞进同一条回复里。
# 收口只认行首【标题】，且至少 2 个标题才动手。


def test_section_heads_split_model_reply() -> None:
    parts = split_by_section_heads("【用人要求】18-45岁\n【上班时间】长白班\n【工资待遇】18元/小时")
    assert parts == ["【用人要求】18-45岁", "【上班时间】长白班", "【工资待遇】18元/小时"]


def test_section_heads_do_not_split_ordinary_prose() -> None:
    """模型自己的正文也用空行分段——按空行拆会把正常回复拆碎。"""
    text = "深圳这边有岗，工价18元/小时。\n\n这周就能面试，你方便吗？"
    assert split_by_section_heads(text) == [text]


def test_section_heads_single_header_stays_whole() -> None:
    text = "【岗位信息】工价18元/小时，包吃住"
    assert split_by_section_heads(text) == [text]


def test_section_heads_keep_media_marker_with_its_section() -> None:
    parts = split_by_section_heads("【岗位信息】工价18元\n【图片:厂门.jpg】\n【上班时间】长白班")
    assert parts == ["【岗位信息】工价18元\n【图片:厂门.jpg】", "【上班时间】长白班"]


def test_section_heads_empty_input() -> None:
    assert split_by_section_heads("") == []
    assert split_by_section_heads("  \n ") == []


def test_send_info_script_goes_out_as_separate_messages() -> None:
    """整链路：话术命中 → result.parts 是 3 段，客户端逐条发。"""
    set_position_scripts([{"position_id": 5, "stage": "send_info", "title": "岗位介绍", "content": SECTIONS}])
    state = new_state()
    result = step(state, "深圳", now=NOW)

    assert len(result.parts) == 3
    assert result.reply == "\n".join(result.parts)
    # 工价一个字都不许改
    assert "纯工价18元/小时" in result.parts[2]


# ── 面试通知 ────────────────────────────────────────────────────


def _book_flow():
    """走到「约成」这一步：问城市 → 答应面试 → 报姓名电话。"""
    state = new_state()
    result = step(state, "深圳", now=NOW)
    state["stage"] = result.stage
    result = step(state, "可以，明天过去面试", now=NOW)
    state["stage"] = result.stage
    assert state["stage"] == STAGE_COLLECT
    return step(state, "张三 13800138000", now=NOW)


def test_interview_notice_is_sent_after_booking() -> None:
    result = _book_flow()
    assert result.finished is True
    joined = "\n".join(result.parts)
    # 通知按段落拆开，不是糊成一坨
    assert any("身份证原件" in part for part in result.parts)
    assert any("到了找谁" in part for part in result.parts)
    assert "身份证原件" in joined


def test_interview_notice_renders_placeholders() -> None:
    job = dict(JOB, interview_notice="【面试地点】{{place}} {{window}}")
    set_remote_jobs({**JOBS_BY_CITY, "深圳": [job]})
    result = _book_flow()
    joined = "\n".join(result.parts)
    assert "观澜大道 88 号" in joined
    assert "{{place}}" not in joined


def test_no_notice_configured_sends_no_notice() -> None:
    job = {key: value for key, value in JOB.items() if key != "interview_notice"}
    set_remote_jobs({**JOBS_BY_CITY, "深圳": [job]})
    result = _book_flow()
    joined = "\n".join(result.parts)
    # 只有代码拼的确认语，不编造面试通知
    assert "登记好了" in joined
    assert "身份证" not in joined


def test_notice_sent_only_once() -> None:
    """改期会再走一次 _book，但通知不能重复轰炸客户。"""
    result = _book_flow()
    assert result.finished is True
    assert result.slots.get("interview_notice_sent") is True

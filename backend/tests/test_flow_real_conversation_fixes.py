"""2026-11-13 真实测试截图暴露的 5 类问题，逐条锁死。

1. 客户说「我是去工厂，不是去安检」→ 不能再推地铁
2. 客户说「后天」→ 不能回成「明天」
3. 答非所问 → 不能把同一句邀约连发三遍
4. 客户单独回「不能」→ 必须当成拒绝
5. 编造「我在打印面试表/叫主管去门口接你」→ prompt 里禁止
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.services import flow_llm, job_lookup
from app.services.flow_engine import (
    INTERVIEW_WINDOW,
    TZ,
    day_label,
    extract_day_offset,
    interview_window_of,
    is_agree,
    is_disagree,
    new_state,
    next_interview,
    set_remote_jobs,
    step,
)
from tests.fixture_jobs import JOBS_BY_CITY

NOW = datetime(2026, 11, 13, 10, 0, tzinfo=TZ)  # 与截图同一天


@pytest.fixture(autouse=True)
def _remote_jobs():
    set_remote_jobs(JOBS_BY_CITY)
    yield
    set_remote_jobs({})


# ── 1. 客户说「后天」─────────────────────────────────────────────
class TestInterviewDay:
    def test_extract_tomorrow_today(self) -> None:
        assert extract_day_offset("我明天过去") == 1
        assert extract_day_offset("今天下午能到") == 0
        # 「大后天」含「后天」，必须先匹配长的
        assert extract_day_offset("大后天吧") == 3
        assert extract_day_offset("后天面试是吧") == 2
        assert extract_day_offset("我知道了") is None

    def test_next_interview_respects_offset(self) -> None:
        today = next_interview(NOW, 0)
        tomorrow = next_interview(NOW, 1)
        day_after = next_interview(NOW, 2)
        assert today.day == 13
        assert tomorrow.day == 14
        assert day_after.day == 15
        for when in (today, tomorrow, day_after):
            assert (when.hour, when.minute) == (9, 0)

    def test_day_label_says_the_right_relative_word(self) -> None:
        assert day_label(next_interview(NOW, 0), NOW).startswith("今天")
        assert day_label(next_interview(NOW, 1), NOW).startswith("明天")
        # 截图里客户说后天，系统回了「明天（11月14日）」
        assert day_label(next_interview(NOW, 2), NOW) == "后天（11月15日）"
        assert day_label(next_interview(NOW, 3), NOW).startswith("大后天")

    def test_step_keeps_day_after_tomorrow_across_turns(self) -> None:
        """复现截图顺序：客户先说「后天」，下一轮才说城市，卡片上必须是后天。

        截图里客户说「后天面试是吧」，卡片却写「明天（11月14日）09:00-11:00」。
        """
        state = new_state()
        step(state, "后天面试是吧", now=NOW)      # 还没有城市 → 反问城市
        assert state["slots"]["interview_day_offset"] == 2
        result = step(state, "深圳", now=NOW)     # 这轮发卡片
        assert "后天（11月15日）" in result.reply
        assert "明天（11月14日）" not in result.reply


def test_interview_window_prefers_job_data() -> None:
    """岗位里填了真实时段就用它，不再发写死的 09:00-11:00。"""
    job = {"interview_time": "周一至周六 上午11:00-12:00、下午14:00-17:00"}
    assert interview_window_of(job) == "周一至周六 上午11:00-12:00、下午14:00-17:00"
    assert interview_window_of({}) == INTERVIEW_WINDOW


# ── 2. 客户回「不能」要算拒绝 ────────────────────────────────────
class TestDisagree:
    def test_plain_refusals(self) -> None:
        for text in ("不能", "不行", "不去了", "算了", "这两天来不了"):
            assert is_disagree(text), text

    def test_question_forms_are_not_refusals(self) -> None:
        # 「能不能过来」里含「不能」，但那是问句
        for text in ("能不能过来", "我能不能明天来", "可不可以后天"):
            assert not is_disagree(text), text

    def test_agree_still_works(self) -> None:
        assert is_agree("可以")
        assert not is_agree("不能")

    def test_step_gives_up_on_plain_no(self) -> None:
        state = new_state()
        step(state, "深圳", now=NOW)
        result = step(state, "不能", now=NOW)
        assert result.stage == "done"
        assert result.finished is True


# ── 3. 不重复同一句 ─────────────────────────────────────────────
def test_repeated_question_varies_wording() -> None:
    state = new_state()
    step(state, "深圳", now=NOW)                    # 发卡片，进邀约阶段
    asked = [step(state, "哦", now=NOW).reply for _ in range(3)]  # 三次答非所问
    # 同一句话不许连发：连续两次追问必须不同
    assert asked[0] != asked[1], asked
    assert asked[1] != asked[2], asked


# ── 4. 客户说工厂就不能推地铁 ────────────────────────────────────
class TestVerticalHint:
    def test_factory_words_map_to_factory(self) -> None:
        for text in ("我是去工厂", "想进厂", "普工有吗", "车间累不累", "我会焊工"):
            assert job_lookup.vertical_hint_of(text) == "factory", text

    def test_subway_words_map_to_subway(self) -> None:
        assert job_lookup.vertical_hint_of("地铁安检还要人吗") == "subway"

    def test_no_hint_when_unclear(self) -> None:
        assert job_lookup.vertical_hint_of("深圳") == ""

    async def test_factory_hint_beats_subway_only_flag(self, monkeypatch) -> None:
        """FLOW_ONLY_SUBWAY=1 时，客户说工厂也能拿到工厂岗。"""
        monkeypatch.setenv("FLOW_PROFILE_TOKEN", "tok")
        monkeypatch.setenv("FLOW_ONLY_SUBWAY", "1")
        job_lookup.clear_cache()
        items = [
            {"factory_name": "深圳地铁安检", "job_title": "安检员", "wage_text": "150/班"},
            {"factory_name": "华智汽车部件", "job_title": "普工", "wage_text": "24-26"},
        ]

        async def fake(city: str, token: str, url: str):  # noqa: ANN001
            return items

        monkeypatch.setattr(job_lookup, "_fetch_items", fake)
        factory = await job_lookup.lookup_jobs("深圳", "factory")
        subway = await job_lookup.lookup_jobs("深圳", "subway")
        default = await job_lookup.lookup_jobs("深圳")
        assert [j["job_title"] for j in factory] == ["普工"]
        assert [j["job_title"] for j in subway] == ["安检员"]
        # 客户没表态时仍然按运营意图只推地铁
        assert [j["job_title"] for j in default] == ["安检员"]
        job_lookup.clear_cache()


# ── 5. 不许编造线下动作 ─────────────────────────────────────────
def test_prompt_forbids_fake_actions() -> None:
    prompt = flow_llm.SYSTEM_PROMPT
    for phrase in ("打印面试表", "主管", "工号"):
        assert phrase in prompt, f"prompt 没有点名禁止「{phrase}」"
    assert "不要重复上一句" in prompt


def test_prompt_tells_model_to_use_real_window() -> None:
    assert "面试时间" in flow_llm.SYSTEM_PROMPT

"""预约后流程审计 F：约成后记录什么 + 改期能不能走通（只读，不改源码）。

复现方式与线上一致：
- api_flow.flow_answer 在 stage=="done" 时会把阶段重置成 ask_interview
  （backend/app/api_flow.py:178-185），然后才调 flow_engine.step。
- 所以每个用例都按「上一轮约成 -> 下一条客户消息」的顺序走，
  并且复刻这一步 stage 重置；否则会测出与线上不同的静默行为。

运行：
  backend\\.venv\\Scripts\\python.exe 过程文件\\agent-tests\\audit_post_booking_flow_F.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import flow_engine as engine  # noqa: E402
from app.services import profile_push  # noqa: E402
from app.services.flow_engine import TZ  # noqa: E402

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=TZ)  # 固定「今天」，明天=11-16

BASE_JOB = {
    "position_id": 101,
    "city": "广州",
    "factory_name": "利口福食品厂",
    "job_title": "利口福食品厂 普工",
    "wage_text": "16 元/小时",
    "hours_text": "两班倒",
    "age_text": "18-48 岁",
    "welfare_text": "包吃包住",
    "place": "番禺南村员岗地铁站",
}
SINGLE = {**BASE_JOB, "interview_time": "14:00-16:00"}
DOUBLE = {**BASE_JOB, "interview_time": "上午9:00-12:00\n下午14:30-17:00"}


def use_job(job: dict) -> None:
    engine.set_remote_jobs({"广州": [job]})
    engine.set_remote_cities([{"city_name": "广州", "districts": ["番禺", "天河"]}])


def turn(state: dict, text: str) -> engine.FlowResult:
    """一轮对话：复刻 api_flow 的 done 重激活 + step。"""
    if str(state.get("stage")) == "done" and str(
        (state.get("slots") or {}).get("recruit_status") or ""
    ) not in {"disqualified", "gave_up"}:
        state["stage"] = "ask_interview"
    result = engine.step(state, text, now=NOW)
    state["stage"] = result.stage
    return result


def book(job: dict) -> tuple[dict, engine.FlowResult]:
    """标准约成路径：报城市 -> 可以 -> 姓名手机。"""
    use_job(job)
    state = engine.new_state()
    for text in ("广州", "可以", "张三 13800138000"):
        result = turn(state, text)
    return state, result


def brief(result: engine.FlowResult) -> dict:
    return {
        "reply": result.reply.replace("\n", " | "),
        "stage": result.stage,
        "action": result.action,
        "finished": result.finished,
        "period": result.slots.get("interview_period", ""),
        "interview_at": result.slots.get("interview_at", ""),
        "interview_window": result.slots.get("interview_window", ""),
        "interview_place": result.slots.get("interview_place", ""),
        "booked": result.slots.get("booked"),
        "agreed": result.slots.get("interview_agreed"),
        "name": result.slots.get("name", ""),
        "phone": result.slots.get("phone", ""),
        "recruit_status": result.slots.get("recruit_status", ""),
    }


def profile_of(result: engine.FlowResult) -> dict:
    return profile_push.build_profile(result.slots, result.stage, result.action)


def push_would_fire(before_profile: dict, result: engine.FlowResult) -> bool:
    """复刻 api_flow:541 的推送条件。"""
    changed = any(
        result.slots.get(key) != before_profile.get(key)
        for key in ("name", "phone", "province", "district", "age", "notes")
    )
    return bool((changed or result.action) and profile_push.has_content(profile_of(result)))


def section(title: str) -> None:
    print("\n" + "=" * 88)
    print(title)
    print("=" * 88)


def main() -> None:
    out: dict = {}

    # ── 流程一：约成那一刻 ────────────────────────────────────────────
    section("A. 约成那一刻（单场次 14:00-16:00）")
    state, booked = book(SINGLE)
    print("reply   :", booked.reply.replace("\n", " | "))
    print("stage   :", booked.stage, "action:", booked.action, "finished:", booked.finished)
    print("slots   :", json.dumps(brief(booked), ensure_ascii=False))
    prof = profile_of(booked)
    print("profile :", json.dumps(prof, ensure_ascii=False))
    out["booking_single"] = {"result": brief(booked), "profile": prof}

    section("A2. 双场次（上午9-12 / 下午14:30-17）默认约哪场")
    state2, booked2 = book(DOUBLE)
    print("reply   :", booked2.reply.replace("\n", " | "))
    print("slots   :", json.dumps(brief(booked2), ensure_ascii=False))
    print("profile :", json.dumps(profile_of(booked2), ensure_ascii=False))
    out["booking_double"] = {"result": brief(booked2), "profile": profile_of(booked2)}

    # ── 流程一 Q2：先给资料，后改时间 ─────────────────────────────────
    section("B. 约成后改时间：槽位与档案是否跟着更新（面试改到后天下午）")
    # A2 把全局岗位换成了双场次；这里必须切回单场次，否则测的是另一份岗位数据
    use_job(SINGLE)
    before_slots = dict(booked.slots)
    before_profile = {k: before_slots.get(k) for k in ("name", "phone", "province", "district", "age", "notes")}
    r = turn(state, "面试改到后天下午")
    after_prof = profile_of(r)
    print("reply   :", r.reply.replace("\n", " | "))
    print("before  :", before_slots.get("interview_at"), before_slots.get("interview_window"), before_slots.get("interview_place"))
    print("after   :", r.slots.get("interview_at"), r.slots.get("interview_window"), r.slots.get("interview_place"))
    print("profile date/time:", after_prof.get("interview_date"), after_prof.get("interview_time"), "stage:", after_prof.get("stage"))
    print("push would fire  :", push_would_fire(before_profile, r))
    out["reschedule_ok"] = {"result": brief(r), "profile": after_prof,
                            "push": push_would_fire(before_profile, r)}

    section("B2. 约成后补发/更改姓名电话（我叫李四 13900139000）")
    state_b, _ = book(SINGLE)
    before_b = {k: state_b["slots"].get(k) for k in ("name", "phone", "province", "district", "age", "notes")}
    rb = turn(state_b, "我叫李四 13900139000")
    print("reply   :", rb.reply.replace("\n", " | "))
    print("name/phone before:", before_b.get("name"), before_b.get("phone"))
    print("name/phone after :", rb.slots.get("name"), rb.slots.get("phone"))
    print("push would fire  :", push_would_fire(before_b, rb))
    print("profile name/phone:", profile_of(rb).get("name"), profile_of(rb).get("phone"), "stage:", profile_of(rb).get("stage"))
    out["post_booking_identity"] = {"result": brief(rb), "push": push_would_fire(before_b, rb),
                                    "profile": profile_of(rb)}

    section("B3. 约成后只补一个电话（13900139000）")
    state_b3, _ = book(SINGLE)
    before_b3 = {k: state_b3["slots"].get(k) for k in ("name", "phone", "province", "district", "age", "notes")}
    rb3 = turn(state_b3, "13900139000")
    print("reply   :", rb3.reply.replace("\n", " | "))
    print("phone after:", rb3.slots.get("phone"), "push:", push_would_fire(before_b3, rb3))
    out["post_booking_phone"] = {"result": brief(rb3), "push": push_would_fire(before_b3, rb3)}

    # 对照：不经 api_flow 重置（step 原文语义）会怎样
    section("B4. 对照：不重置 stage（纯 flow_engine.step）时补发资料")
    state_raw = engine.new_state()
    for text in ("广州", "可以", "张三 13800138000"):
        res = engine.step(state_raw, text, now=NOW)
        state_raw["stage"] = res.stage
    raw = engine.step(state_raw, "我叫李四 13900139000", now=NOW)
    print("reply   :", repr(raw.reply), "stage:", raw.stage, "finished:", raw.finished)
    print("name before/after:", state_raw["slots"].get("name"))
    out["raw_engine_after_booking"] = {"reply": raw.reply, "stage": raw.stage,
                                       "finished": raw.finished}

    # ── 流程一 Q5：缺字段会不会看不到线索 ─────────────────────────────
    section("C. 缺字段对「报名成功」的影响")
    cases = {
        "完整": BASE_JOB,
        "缺 factory_name": {**BASE_JOB, "factory_name": ""},
        "缺 place": {**BASE_JOB, "place": ""},
        "缺 interview_time（走默认窗口）": {**BASE_JOB, "interview_time": ""},
        "缺 city": {**BASE_JOB, "city": ""},
    }
    field_rows = []
    for label, job in cases.items():
        s, r = book({**job, "interview_time": job.get("interview_time", "14:00-16:00")})
        p = profile_of(r)
        invited = bool(p.get("registration_text")) and p.get("stage") == "booked"
        row = {
            "case": label,
            "stage": p.get("stage"),
            "factory_name": p.get("factory_name", ""),
            "city": p.get("city", ""),
            "interview_date": p.get("interview_date", ""),
            "interview_time": p.get("interview_time", ""),
            "registration_text": p.get("registration_text", ""),
            "invited": invited,
        }
        field_rows.append(row)
        print(json.dumps(row, ensure_ascii=False))
    out["missing_fields"] = field_rows

    # ── 流程二：改期句子实测 ──────────────────────────────────────────
    section("D. 改期说法实测（单场次 14:00-16:00，已约成）")
    single_sentences = [
        "面试改到下午",
        "面试时间改成明天上午",
        "面试改到后天下午",
        "面试改到上午",
        "面试改到晚上",
        "面试时间改到下午吧",
        "面试改到下午可以吗",
        "我明天有事，能改后天吗",
        "能改到下午吗",
        "能改到后天吗",
        "改到后天",
        "我晚点到一个小时",
        "能提前吗",
        "改天行不行",
        "明天下午可以吗",
        "那就下午吧",
        "我明天有事，改后天吧",
        "面试改到后天",
        "面试改到明天下午两点",
        "改到下午两点行吗",
    ]
    rows = []
    for sentence in single_sentences:
        s, _ = book(SINGLE)
        before = dict(s["slots"])
        r = turn(s, sentence)
        p = profile_of(r)
        p_changed = (p.get("interview_date"), p.get("interview_time")) != (
            profile_of(engine.FlowResult(reply="", stage="done", slots=before)).get("interview_date"),
            profile_of(engine.FlowResult(reply="", stage="done", slots=before)).get("interview_time"),
        )
        row = {
            "say": sentence,
            "reply": r.reply.replace("\n", " | "),
            "stage": r.stage,
            "action": r.action,
            "at_before": before.get("interview_at"),
            "at_after": r.slots.get("interview_at"),
            "window_after": r.slots.get("interview_window"),
            "place_after": r.slots.get("interview_place"),
            "profile_date_after": p.get("interview_date"),
            "profile_time_after": p.get("interview_time"),
            "profile_changed": p_changed,
            "recruit_status": r.slots.get("recruit_status", ""),
        }
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False))
    out["single_window_reschedule"] = rows

    section("E. 改期说法实测（双场次 上午9-12 / 下午14:30-17，已约成）")
    double_sentences = [
        "面试改到上午",
        "面试改到下午",
        "面试时间改成后天下午",
        "我明天有事，能改后天吗",
        "能改到下午吗",
        "我晚点到一个小时",
        "能提前吗",
        "改到后天",
    ]
    rows2 = []
    for sentence in double_sentences:
        s, _ = book(DOUBLE)
        before = dict(s["slots"])
        r = turn(s, sentence)
        p = profile_of(r)
        base_p = profile_of(engine.FlowResult(reply="", stage="done", slots=before))
        row = {
            "say": sentence,
            "reply": r.reply.replace("\n", " | "),
            "stage": r.stage,
            "at_before": before.get("interview_at"),
            "at_after": r.slots.get("interview_at"),
            "window_after": r.slots.get("interview_window"),
            "profile_date_after": p.get("interview_date"),
            "profile_time_after": p.get("interview_time"),
            "profile_changed": (p.get("interview_date"), p.get("interview_time"))
            != (base_p.get("interview_date"), base_p.get("interview_time")),
            "recruit_status": r.slots.get("recruit_status", ""),
        }
        rows2.append(row)
        print(json.dumps(row, ensure_ascii=False))
    out["double_window_reschedule"] = rows2

    section("F. 改期失败后客户回「可以」会怎样（单场次，先发 面试改到上午）")
    s, _ = book(SINGLE)
    r1 = turn(s, "面试改到上午")
    print("第1轮:", r1.reply.replace("\n", " | "), "| stage:", r1.stage, "| at:", r1.slots.get("interview_at"))
    r2 = turn(s, "可以")
    print("第2轮:", r2.reply.replace("\n", " | "), "| stage:", r2.stage, "| at:", r2.slots.get("interview_at"))
    out["conflict_then_confirm"] = {"first": brief(r1), "second": brief(r2)}

    section("G. 尚未约成时问「能不能改天」会不会被判流失")
    pre_sentences = ["能改天吗", "改天行不行", "我明天有事，能改后天吗", "可以晚两天吗"]
    pre_rows = []
    for sentence in pre_sentences:
        use_job(SINGLE)
        st = engine.new_state()
        for text in ("广州", "可以"):  # 已发卡、已答应，正在收姓名电话
            res = turn(st, text)
        r = turn(st, sentence)
        row = {
            "say": sentence,
            "reply": r.reply.replace("\n", " | "),
            "stage": r.stage,
            "action": r.action,
            "recruit_status": r.slots.get("recruit_status", ""),
            "name": r.slots.get("name", ""),
        }
        pre_rows.append(row)
        print(json.dumps(row, ensure_ascii=False))
    out["pre_booking_change_day"] = pre_rows

    section("G2. 刚发完岗位卡（ask_interview）就问「改天」")
    for sentence in ("能改天吗", "改天行不行", "我明天有事，能改后天吗"):
        use_job(SINGLE)
        st = engine.new_state()
        turn(st, "广州")  # 已发卡，正等客户答复来不来
        r = turn(st, sentence)
        print(json.dumps({
            "say": sentence,
            "reply": r.reply.replace("\n", " | "),
            "stage": r.stage,
            "action": r.action,
            "recruit_status": r.slots.get("recruit_status", ""),
        }, ensure_ascii=False))

    section("G3. 「能改天吗」被当姓名后，补手机号会约成什么")
    use_job(SINGLE)
    st = engine.new_state()
    for text in ("广州", "可以", "能改天吗", "13800138000"):
        res = turn(st, text)
    print("final reply:", res.reply.replace("\n", " | "))
    print("name/phone:", res.slots.get("name"), res.slots.get("phone"), "stage:", res.stage)
    print("profile  :", json.dumps(profile_of(res), ensure_ascii=False))
    out["name_pollution_chain"] = {"result": brief(res), "profile": profile_of(res)}

    # ── 保存原始结果 ──────────────────────────────────────────────────
    target = ROOT / "过程文件" / "agent-tests" / "audit_post_booking_flow_F_result.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n结果已写入:", target)


if __name__ == "__main__":
    main()

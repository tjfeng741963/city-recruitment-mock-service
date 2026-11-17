# -*- coding: utf-8 -*-
"""只读验证：面试时段死锁是否真的修好 + 回归场景。

不修改任何源码/测试文件，仅在 过程文件/agent-tests/ 下运行。
用法：backend\\.venv\\Scripts\\python.exe 过程文件/agent-tests/verify_interview_period_deadlock.py
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"C:\Users\a2436\Desktop\code\city-recruitment-mock-service\backend")

import asyncio
import copy
from datetime import datetime

from app.services import flow_engine as engine, flow_llm

NOW = datetime(2026, 11, 15, 8, tzinfo=engine.TZ)

# 只有下午一场（模拟线上陈村基地）
JOB = {"position_id": 16, "employer_id": 11, "city": "广东城际",
       "factory_name": "广东城际地铁安检", "job_title": "安检员",
       "place": "陈村基地", "wage_text": "陈村安保220/天",
       "interview_time": "14:00-16:00"}
JOB_MORNING = {**JOB, "interview_time": "上午9:00-12:00"}

engine.set_remote_cities([{"city_name": "广东城际"}])
engine.set_position_scripts([])


def use_job(job):
    engine.set_remote_jobs({"广东城际": [dict(job)]})


async def turn(state, text, model=False):
    return (await flow_llm.a_step(state, text, None, now=NOW) if model
            else engine.step(state, text, now=NOW))


def fmt(res):
    s = res.slots or {}
    return (f"stage={res.stage} | period={s.get('interview_period') or '-'} | "
            f"window={s.get('interview_window') or '-'} | action={res.action or '-'}")


def clip(t, n=50):
    t = (t or "").replace("\n", " / ")
    return t if len(t) <= n else t[:n] + "…"


class Snap:
    """FlowResult.slots 与 state 同引用，必须深拷贝后再判定。"""

    def __init__(self, res):
        self.reply = res.reply or ""
        self.stage = res.stage
        self.slots = copy.deepcopy(res.slots or {})
        self.action = res.action
        self.finished = res.finished


async def run_dialog(name, texts, model):
    print(f"\n===== {name} | model={model} =====")
    state = engine.new_state()
    out = []
    for text in texts:
        res = await turn(state, text, model)
        snap = Snap(res)
        print(f"客户:{text} -> 我方:{clip(snap.reply)!r} | {fmt(snap)}")
        out.append((text, snap))
    return out


# ───────────────────── 判定 ─────────────────────
def has_options(reply):
    return "可选场次" in (reply or "")


def judge_1(rs):
    """第3轮不能卡死（应提示可选场次）；第4轮 done + 下午窗口 + book_interview。"""
    p = []
    r3 = rs[2][1]
    if not (r3.reply or "").strip():
        p.append("第3轮空回复（卡死）")
    elif not (has_options(r3.reply) or "14:00-16:00" in r3.reply):
        p.append(f"第3轮未提示可选场次: {clip(r3.reply)!r}")
    if r3.stage != "collect":
        p.append(f"第3轮 stage={r3.stage} 非 collect")
    r4 = rs[3][1]
    if r4.stage != "done":
        p.append(f"第4轮 stage={r4.stage} 非 done")
    if r4.action != "book_interview":
        p.append(f"第4轮 action={r4.action} 非 book_interview")
    if r4.slots.get("interview_window") != "下午14:00-16:00":
        p.append(f"第4轮 window={r4.slots.get('interview_window')!r}")
    if r4.slots.get("interview_period") != "下午":
        p.append(f"第4轮 period={r4.slots.get('interview_period')!r}")
    if (r4.reply or "").strip() == (r3.reply or "").strip():
        p.append("第4轮与第3轮同一句原样重复")
    return p


def judge_2(rs):
    """第4轮「确认」应就近接受下午场并 done，不能重复「暂时无法确认上午场」。"""
    p = []
    r4 = rs[3][1]
    if r4.stage != "done":
        p.append(f"第4轮 stage={r4.stage} 非 done")
    if r4.action != "book_interview":
        p.append(f"第4轮 action={r4.action} 非 book_interview")
    if r4.slots.get("interview_window") != "下午14:00-16:00":
        p.append(f"第4轮 window={r4.slots.get('interview_window')!r}")
    if "暂时无法确认上午场" in (r4.reply or ""):
        p.append("第4轮仍在说『暂时无法确认上午场』")
    return p


def judge_3(rs):
    """连续三次「上午」：不无限循环 / 每轮给可选场次 / 同一句不得连发 4 次。"""
    p = []
    tail = [s for _, s in rs[2:]]
    for i, s in enumerate(tail, start=3):
        if not (s.reply or "").strip():
            p.append(f"第{i}轮空回复")
        elif not has_options(s.reply):
            p.append(f"第{i}轮未给出可选场次: {clip(s.reply)!r}")
    # 最长连续同句长度
    longest, run = 1, 1
    for prev, cur in zip(tail, tail[1:]):
        run = run + 1 if prev.reply.strip() == cur.reply.strip() else 1
        longest = max(longest, run)
    if longest >= 4:
        p.append(f"同一句连续重复 {longest} 次（≥4 不合格）")
    return p


def judge_4(rs):
    """已约后改期：仍 done、日期变后天(11-17)、window 不变。"""
    p = []
    r4 = rs[3][1]
    if r4.stage != "done":
        p.append(f"第4轮 stage={r4.stage} 非 done")
    at = str(r4.slots.get("interview_at") or "")
    if not at.startswith("2026-11-17"):
        p.append(f"第4轮 interview_at={at!r} 未变后天")
    if r4.slots.get("interview_window") != "下午14:00-16:00":
        p.append(f"第4轮 window={r4.slots.get('interview_window')!r} 被改动")
    return p


def judge_5(rs):
    """只有上午场、客户说下午：提示可选场次，不能静默卡住。"""
    p = []
    r3 = rs[2][1]
    if not (r3.reply or "").strip():
        p.append("第3轮空回复（静默卡住）")
    elif "上午09:00-12:00" not in r3.reply:
        p.append(f"第3轮未列出上午可选场次: {clip(r3.reply)!r}")
    if r3.stage != "collect":
        p.append(f"第3轮 stage={r3.stage} 非 collect")
    if r3.slots.get("booked"):
        p.append("第3轮被静默约成 booked")
    return p


DIALOGS = [
    ("1) 陈村下午场：说上午 -> 改下午两点",
     ["广东城际", "可以，明天上午过去面试", "我叫陈志强 13800138000", "那就下午两点吧"],
     JOB, judge_1),
    ("2) 陈村下午场：说上午 -> 确认（就近接受）",
     ["广东城际", "可以，明天上午过去面试", "我叫陈志强 13800138000", "确认"],
     JOB, judge_2),
    ("3) 陈村下午场：连续三次说上午",
     ["广东城际", "可以，明天上午去面试", "我叫陈志强 13800138000", "上午", "上午", "上午"],
     JOB, judge_3),
    ("4) 已约下午场后改期到后天下午",
     ["广东城际", "可以，明天下午过去面试", "我叫陈志强 13800138000", "面试时间改到后天下午"],
     JOB, judge_4),
    ("5) 只有上午场时客户要下午",
     ["广东城际", "可以，明天下午过去面试", "我叫陈志强 13800138000"],
     JOB_MORNING, judge_5),
]


async def main():
    summary = []
    for name, texts, job, judge in DIALOGS:
        for model in (False, True):
            use_job(job)
            rs = await run_dialog(name, texts, model)
            problems = judge(rs)
            summary.append((name, model, problems))
            print(f"-- {name} | model={model}: {'PASS' if not problems else 'FAIL'}")
            for msg in problems:
                print(f"   ! {msg}")

    print("\n================ 汇总 ================")
    ok = 0
    for name, model, problems in summary:
        status = "PASS" if not problems else "FAIL"
        ok += status == "PASS"
        print(f"[{status}] {name} | model={model}")
    print(f"\n合计 {ok}/{len(summary)} 通过")
    return ok, len(summary)


if __name__ == "__main__":
    asyncio.run(main())

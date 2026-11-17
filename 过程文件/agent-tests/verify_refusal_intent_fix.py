# -*- coding: utf-8 -*-
"""只读验证：口语反悔（算了 就这个吧）是否仍被误判 disqualified + 回归检查。

不修改任何源码/测试文件，仅在 过程文件/agent-tests/ 下运行。
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"C:\Users\a2436\Desktop\code\city-recruitment-mock-service\backend")

import asyncio
import copy
from datetime import datetime

from app.services import flow_engine as engine, flow_llm

NOW = datetime(2026, 11, 15, 8, tzinfo=engine.TZ)

JOB = {"position_id": 16, "employer_id": 11, "city": "广东城际",
       "factory_name": "广东城际地铁安检", "job_title": "安检员",
       "place": "陈村基地", "wage_text": "陈村安保220/天",
       "welfare_text": "安排线路：广东城际全线路", "interview_time": "14:00-16:00"}

engine.set_remote_cities([{"city_name": "广东城际"}])
engine.set_remote_jobs({"广东城际": [JOB]})
engine.set_position_scripts([])


async def turn(state, text, model=False):
    return (await flow_llm.a_step(state, text, None, now=NOW) if model
            else engine.step(state, text, now=NOW))


def fmt(res):
    s = res.slots or {}
    return (f"stage={res.stage} | recruit_status={s.get('recruit_status') or '-'} | "
            f"name={s.get('name') or '-'} phone={s.get('phone') or '-'} "
            f"win={s.get('interview_window') or '-'} at={s.get('interview_at') or '-'} "
            f"action={res.action or '-'}")

def clip(t, n=40):
    t = (t or "").replace("\n", " / ")
    return t if len(t) <= n else t[:n] + "…"


class Snap:
    """单轮结果快照：FlowResult.slots 与 state 同引用，必须深拷贝后再判定。"""

    def __init__(self, res):
        self.reply = res.reply or ""
        self.stage = res.stage
        self.slots = copy.deepcopy(res.slots or {})
        self.action = res.action
        self.finished = res.finished


async def run_dialog(name, texts, model):
    print(f"\n===== {name} | model={model} =====")
    state = engine.new_state()
    results = []
    for text in texts:
        res = await turn(state, text, model)
        snap = Snap(res)
        print(f"客户:{text} -> 我方:{clip(snap.reply)!r} | {fmt(snap)}")
        results.append((text, snap, len(snap.reply)))
    return results


# ───────────────────── 判定 ─────────────────────
def judge_1(rs):
    """原场景：第2轮 collect 问姓名电话且不判死；第3轮 done 且有槽位；第4轮答地点。"""
    p = []
    r2 = rs[1][1]
    s2 = r2.slots or {}
    if r2.stage != "collect" or ("姓名" not in r2.reply and "电话" not in r2.reply):
        p.append(f"第2轮未进 collect 且问姓名电话 (stage={r2.stage}, reply={clip(r2.reply)!r})")
    if s2.get("recruit_status") == "disqualified":
        p.append("第2轮被判 disqualified")
    if "不打扰" in (r2.reply or ""):
        p.append("第2轮出现『不打扰你了』")

    r3 = rs[2][1]
    s3 = r3.slots or {}
    if r3.stage != "done" or r3.action != "book_interview":
        p.append(f"第3轮未 done/book (stage={r3.stage}, action={r3.action})")
    if s3.get("name") != "陈志强":
        p.append(f"name={s3.get('name')!r}")
    if s3.get("phone") != "13800138000":
        p.append(f"phone={s3.get('phone')!r}")
    if "14:00-16:00" not in (s3.get("interview_window") or ""):
        p.append(f"interview_window={s3.get('interview_window')!r} 不含 14:00-16:00")

    r4 = rs[3][1]
    if not (r4.reply or "").strip():
        p.append("第4轮空回复")
    elif "陈村基地" not in r4.reply:
        p.append(f"第4轮未回答地点: {clip(r4.reply)!r}")
    elif (r4.reply or "").strip() == (r3.reply or "").strip():
        p.append("第4轮与上一轮重复同一句")
    return p


def judge_2(rs):
    r2 = rs[1][1]
    p = []
    if r2.stage != "collect":
        p.append(f"stage={r2.stage} 非 collect")
    if (r2.slots or {}).get("recruit_status") == "disqualified":
        p.append("被判 disqualified")
    if "不打扰" in (r2.reply or ""):
        p.append("出现『不打扰』")
    return p


def judge_3(rs):
    r2 = rs[1][1]
    p = []
    if r2.stage != "collect":
        p.append(f"stage={r2.stage} 非 collect")
    if (r2.slots or {}).get("recruit_status") == "disqualified":
        p.append("被判 disqualified")
    if (r2.slots or {}).get("interview_day_offset") != 1:
        p.append(f"day_offset={(r2.slots or {}).get('interview_day_offset')!r}")
    return p


def judge_4(rs):
    r2 = rs[1][1]
    p = []
    if r2.stage != "done":
        p.append(f"stage={r2.stage} 非 done")
    if (r2.slots or {}).get("recruit_status") != "disqualified":
        p.append(f"未判 disqualified: {(r2.slots or {}).get('recruit_status')!r}")
    if "不打扰" not in (r2.reply or ""):
        p.append(f"缺少『不打扰』: {clip(r2.reply)!r}")
    return p


def judge_5(rs):
    r2, r3 = rs[1][1], rs[2][1]
    p = []
    if (r2.slots or {}).get("recruit_status") != "disqualified":
        p.append("第2轮未判 disqualified（前置不成立）")
    if r3.stage != "done" or r3.action != "book_interview":
        p.append(f"第3轮未复活完成登记 (stage={r3.stage}, action={r3.action})")
    s3 = r3.slots or {}
    if s3.get("name") != "陈志强" or s3.get("phone") != "13800138000":
        p.append(f"槽位缺失 name={s3.get('name')!r} phone={s3.get('phone')!r}")
    return p


def judge_6(rs):
    r2 = rs[1][1]
    p = []
    if r2.stage == "done" and (r2.slots or {}).get("recruit_status") == "disqualified":
        p.append("被判 disqualified")
    if (r2.slots or {}).get("recruit_status") == "disqualified":
        p.append("recruit_status=disqualified")
    if "220" not in (r2.reply or "") and "工价" not in (r2.reply or "") and "工资" not in (r2.reply or ""):
        p.append(f"未回答工价: {clip(r2.reply)!r}")
    return p


DIALOGS = [
    ("1) 原场景：算了 就这个吧 怎么面试 + 追问地点",
     ["广东城际", "算了 就这个吧 怎么面试", "我叫陈志强 13800138000", "面试到底在哪儿啊"],
     judge_1),
    ("2) 算了 就这个吧（无问句）",
     ["广东城际", "算了 就这个吧"], judge_2),
    ("3) 算了 帮我登记一下 明天去",
     ["广东城际", "算了 帮我登记一下 明天去"], judge_3),
    ("4) 真拒绝：算了 我不去了",
     ["广东城际", "算了 我不去了"], judge_4),
    ("5) 真拒绝后复活",
     ["广东城际", "算了 我不去了", "我叫陈志强 13800138000"], judge_5),
    ("6) 问句不是拒绝：工资算了吗",
     ["广东城际", "工资算了吗"], judge_6),
]


async def main():
    summary = []
    for name, texts, judge in DIALOGS:
        base = None
        per_model = {}
        for model in (False, True):
            rs = await run_dialog(name, texts, model)
            problems = judge(rs)
            per_model[model] = problems
            summary.append((name, model, problems))
            if base is None:
                base = [(t, r.stage, r.reply) for t, r, _ in rs]
            else:
                diff = [(t, (s1, r1), (snap2.stage, snap2.reply))
                        for (t, s1, r1), (_, snap2, __) in zip(base, rs)
                        if (s1, r1) != (snap2.stage, snap2.reply)]
                if diff:
                    print("  [路径差异] model=False vs model=True：")
                    for t, a, b in diff:
                        print(f"    「{t}」engine: stage={a[0]} reply={clip(a[1])!r} "
                              f"|| llm: stage={b[0]} reply={clip(b[1])!r}")
        print(f"-- {name}: model=False {'PASS' if not per_model[False] else 'FAIL'} | "
              f"model=True {'PASS' if not per_model[True] else 'FAIL'}")
        for m in (False, True):
            for msg in per_model[m]:
                print(f"   model={m}: {msg}")

    print("\n================ 汇总 ================")
    ok = 0
    for name, model, problems in summary:
        status = "PASS" if not problems else "FAIL"
        ok += (status == "PASS")
        print(f"[{status}] {name} | model={model}")
    print(f"\n合计 {ok}/{len(summary)} 通过")
    return ok, len(summary)


if __name__ == "__main__":
    asyncio.run(main())

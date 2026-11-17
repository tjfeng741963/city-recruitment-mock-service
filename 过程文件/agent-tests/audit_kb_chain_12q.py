"""知识库问答链路审计脚本（只读源码，不改业务代码）。

用途：对 12 个真实客户问题，分别走两条「能答的层」：
  1) 直接调 flow_engine._job_fact_answer(slots, q) —— 看岗位事实层能不能答；
  2) 调 flow_engine.step(state, q, kb_answer=None) —— 看没有 KB 时的真实兜底回复。

不起数据库、不调模型。岗位夹具按 4222 契约
（src/modules/agent/profile.routes.ts:554-595）构造，含 interview_time，
welfare_text 是「安排线路：…」的地铁安检岗。

运行：
  backend\\.venv\\Scripts\\python.exe 过程文件/agent-tests/audit_kb_chain_12q.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import flow_engine as engine  # noqa: E402
from app.services.kb_search import extract_age_from_query  # noqa: E402

# ── 4222 真实契约岗位夹具（地铁安检）────────────────────────────────
# 字段名全部来自 profile.routes.ts 的 items 映射；welfare_text 故意填「安排线路」，
# 复现线上「吃住字段被线路占用」的真实数据形态。
SUBWAY_JOB = {
    "position_id": 16,
    "employer_id": 11,
    "city": "广东城际",
    "factory_name": "广东城际地铁安检",
    "job_title": "安检员",
    "vertical_code": "subway",
    "employer_label": "线路",
    "place": "陈村基地",
    "wage_text": "陈村安保220/天",
    "hours_text": "8小时/天，两班倒，月休4天",
    "age_text": "18-45岁",
    "welfare_text": "安排线路：广东城际全线路",
    "line_text": "广东城际全线路",
    "rest_text": "月休4天",
    "height_text": "男168cm以上，女158cm以上",
    "tattoo_policy": "手臂无明显纹身",
    "ethnicity_policy": "不限民族",
    "cert_text": "身份证原件",
    "medical_text": "体检费80元，入职满一个月报销",
    "insurance_text": "转正后购买社保",
    "regular_text": "试用期1个月",
    "advance_text": "每周可预支500元",
    "dorm_text": "6人间，空调热水齐全",
    "interview_time": "周一至周六 上午11:00-12:00、下午14:00-17:00",
    "province": "广东",
    "city_name": "广东城际",
    "media": [],
}

# 对照组：普通工厂岗，welfare_text 是真正的吃住描述
FACTORY_JOB = {
    "position_id": 31,
    "employer_id": 12,
    "city": "广州",
    "factory_name": "番禺某电子厂",
    "job_title": "普工",
    "vertical_code": "factory",
    "employer_label": "厂名",
    "place": "番禺区石楼",
    "wage_text": "22元/小时，月综合6500-7500",
    "hours_text": "10小时/天，长白班",
    "age_text": "16-48岁",
    "welfare_text": "包吃包住，宿舍6人间有空调",
    "dorm_text": "6人间，空调热水",
    "interview_time": "每天12:00-12:30",
    "media": [],
}

QUESTIONS = [
    "包吃住吗",
    "宿舍几人间有空调吗",
    "要押金吗",
    "多大年龄能做",
    "什么时候面试",
    "面试在哪儿",
    "一天上几个小时",
    "工资多少",
    "有日结吗",
    "体检费谁出",
    "纹身能不能进",
    "我52了还能去吗",
]


def make_state(job: dict) -> dict:
    """构造「岗位卡已发、正在邀约面试」的真实会话状态。"""
    state = engine.new_state()
    slots = state["slots"]
    slots.update(
        {
            "city": job["city"],
            "job_index": 0,
            "interview_offer_sent": True,
            "interview_agreed": False,
            "booked": False,
        }
    )
    engine.pin_position(slots, job)  # 同时写入 position_id/employer_id/job_snapshot
    state["stage"] = engine.STAGE_ASK_INTERVIEW
    state["node"] = engine.STAGE_ASK_INTERVIEW
    return state


def run(job: dict, questions: list[str]) -> list[dict]:
    rows: list[dict] = []
    engine.set_remote_cities([{"city_name": job["city"]}])
    engine.set_remote_jobs({job["city"]: [dict(job)]})
    engine.set_position_scripts([])
    for q in questions:
        slots = make_state(job)["slots"]
        fact = engine._job_fact_answer(slots, q)

        state = make_state(job)
        result = engine.step(state, q, kb_answer=None)
        reply = result.reply or "（空回复）"

        # 判定实际回复来自哪一层
        if result.source == "fact":
            source = "fact"
        elif result.source == "kb":
            source = "kb"
        elif reply.startswith("这个我确认一下"):
            source = "兜底-确认一下"
        elif "能不能过来面试" in reply or "方便过来" in reply or "给你留着" in reply:
            source = "兜底-邀约（答非所问）"
        else:
            source = result.source or "其他"

        rows.append(
            {
                "问题": q,
                "fact直调": fact or "（空）",
                "step实际回复": reply.replace("\n", " / "),
                "来源": source,
                "stage": result.stage,
                "unknown_question": result.unknown_question,
                "slots带答案": {
                    k: job.get(k)
                    for k in (
                        "wage_text", "hours_text", "age_text", "welfare_text",
                        "line_text", "dorm_text", "tattoo_policy", "medical_text",
                        "advance_text", "interview_time", "place",
                    )
                    if job.get(k)
                },
            }
        )
    return rows


def main() -> None:
    main_rows = run(SUBWAY_JOB, QUESTIONS)
    control_rows = run(FACTORY_JOB, ["包吃住吗", "宿舍几人间有空调吗", "有日结吗"])
    age_probe = {
        "extract_age_from_query('我52了还能去吗')": extract_age_from_query("我52了还能去吗"),
        "岗位age_text": SUBWAY_JOB["age_text"],
        "flow是否调用该函数": False,
    }

    payload = {
        "fixture": {"subway": SUBWAY_JOB, "factory": FACTORY_JOB},
        "subway_rows": main_rows,
        "factory_control_rows": control_rows,
        "age_probe": age_probe,
    }
    out = Path(__file__).with_name("audit_kb_chain_12q_result.json")
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=" * 100)
    print("主夹具：地铁安检岗（welfare_text=安排线路：…）")
    print("=" * 100)
    for i, r in enumerate(main_rows, 1):
        print(f"{i:>2}. {r['问题']}")
        print(f"    fact直调 : {r['fact直调']}")
        print(f"    step实回 : {r['step实际回复']}")
        print(f"    来源     : {r['来源']} | stage={r['stage']} | 记未知={bool(r['unknown_question'])}")
        print()

    print("=" * 100)
    print("对照：普通工厂岗（welfare_text=包吃包住）")
    print("=" * 100)
    for r in control_rows:
        print(f"  {r['问题']} -> fact={r['fact直调']} | step={r['step实际回复']} | {r['来源']}")
    print()
    print("年龄探针：", age_probe)
    print(f"\n结果 JSON: {out}")


if __name__ == "__main__":
    main()

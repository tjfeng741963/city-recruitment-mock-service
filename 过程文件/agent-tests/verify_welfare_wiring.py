"""缺陷取证：问题1「吃住：安排线路：广东城际全线路」内容串线（只读，不改源码）。

跑法：
  backend\\.venv\\Scripts\\python.exe 过程文件\\agent-tests\\verify_welfare_wiring.py
"""
from __future__ import annotations

import sys
from datetime import datetime

sys.path.insert(0, r"C:\Users\a2436\Desktop\code\city-recruitment-mock-service\backend")

from app.services import flow_engine as engine  # noqa: E402

JOB = {
    "position_id": 16,
    "employer_id": 11,
    "city": "广东城际",
    "factory_name": "广东城际地铁安检",
    "job_title": "安检员",
    "place": "陈村基地",
    "wage_text": "陈村安保220/天",
    "welfare_text": "安排线路：广东城际全线路",
    "interview_time": "14:00-16:00",
}
NOW = datetime(2026, 11, 15, 10, 0)


def section(title: str) -> None:
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)


def main() -> None:
    engine.set_remote_cities([{"city_name": "广东城际"}])
    engine.set_remote_jobs({"广东城际": [JOB]})

    section("A. 首轮发卡（step 走 ask_city -> enter_info_result）")
    state = engine.new_state()
    result = engine.step(state, "广东城际", now=NOW)
    print("stage =", result.stage, "| source =", result.source)
    for i, part in enumerate(result.parts or [], 1):
        print(f"  part{i}: {part!r}")
    print("job_snapshot.welfare_text =", repr(state["slots"]["job_snapshot"]["welfare_text"]))

    section("B. 插问事实（_job_fact_answer，已钉住岗位快照）")
    for q in ("包吃住吗", "有宿舍吗", "安排哪条线路"):
        print(f"  {q} => {engine._job_fact_answer(state['slots'], q)!r}")

    section("C. 卡片渲染：position_schema 不存在（老路径五段）")
    job_no_schema = dict(JOB)
    for line in engine._job_card_lines(job_no_schema):
        print("  " + line)

    section("D. 卡片渲染：position_schema 含 key=welfare_text,label=吃住")
    job_schema_welfare = dict(JOB)
    job_schema_welfare["position_schema"] = [
        {"key": "wage_text", "label": "薪资"},
        {"key": "welfare_text", "label": "吃住"},
    ]
    for line in engine._job_card_lines(job_schema_welfare):
        print("  " + line)

    section("E. 卡片渲染：地铁 schema（无 welfare_text，label 安排线路->line_text）")
    job_subway = dict(JOB)
    job_subway["position_schema"] = [
        {"key": "wage_text", "label": "薪资"},
        {"key": "hours_text", "label": "班次"},
        {"key": "height_text", "label": "身高要求"},
        {"key": "line_text", "label": "安排线路"},
    ]
    for line in engine._job_card_lines(job_subway):
        print("  " + line)
    print("  → line_text 为空，welfare_text 里那句「安排线路：...」在卡上消失，"
          "但客户问「包吃住吗」仍从 welfare_text 回答")


if __name__ == "__main__":
    main()

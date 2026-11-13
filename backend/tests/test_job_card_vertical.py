"""岗位卡片的标签与字段顺序必须跟品类走。

背景（2026-11-13 真实测试截图）：
客户投深圳，系统推了「深圳地铁安检」，卡片第一行却写「厂名：」——
地铁不是工厂，应该写「线路：」。而且地铁有「安排线路/身高/月休」这些字段，
写死的工厂五段（厂名/工价/班次/年龄/吃住）没地方放，最后全挤进「吃住」那一行。
"""

from __future__ import annotations

from app.services import flow_engine as fe

SUBWAY_JOB = {
    "factory_name": "深圳地铁安检",
    "job_title": "安检员",
    "wage_text": "1号线 150/班，连班 300/天",
    "hours_text": "早班 6:00-15:00，晚班 15:00-23:30",
    "age_text": "18-35岁",
    "welfare_text": "包吃三餐包住",
    "rest_text": "月休 4-6 天",
    "height_text": "男 165 以上，女 155 以上",
    "line_text": "1-6 号线",
    "tattoo_policy": "不能有纹身、案底、色弱、大面积伤疤",
    "employer_label": "线路",
    "position_schema": [
        {"key": "wage_text", "label": "薪资"},
        {"key": "hours_text", "label": "班次"},
        {"key": "rest_text", "label": "月休"},
        {"key": "age_text", "label": "年龄"},
        {"key": "height_text", "label": "身高要求"},
        {"key": "tattoo_policy", "label": "纹身要求"},
        {"key": "line_text", "label": "安排线路"},
        {"key": "welfare_text", "label": "吃住"},
    ],
}

FACTORY_JOB = {
    "factory_name": "广州华荻科技有限公司",
    "job_title": "焊工",
    "wage_text": "35-40 元/小时",
    "hours_text": "两班倒，月休 4 天",
    "age_text": "18-40岁",
    "welfare_text": "包吃工作餐，住宿补贴 200 元/月",
}


def test_subway_card_uses_line_label_not_factory() -> None:
    lines = fe._job_card_lines(SUBWAY_JOB)
    assert lines[0].startswith("线路：深圳地铁安检"), lines[0]
    assert not any(line.startswith("厂名") for line in lines)


def test_subway_card_has_its_own_fields() -> None:
    body = "\n".join(fe._job_card_lines(SUBWAY_JOB))
    # 这些字段工厂卡片里没有，必须单独成行，不能被塞进「吃住」
    assert "安排线路：1-6 号线" in body
    assert "身高要求：男 165 以上，女 155 以上" in body
    assert "月休：月休 4-6 天" in body
    assert "吃住：包吃三餐包住" in body
    # 关键回归：「吃住」那一行不能再混进线路
    for line in body.split("\n"):
        if line.startswith("吃住："):
            assert "线路" not in line


def test_subway_card_skips_empty_fields() -> None:
    job = dict(SUBWAY_JOB)
    job["line_text"] = ""
    body = "\n".join(fe._job_card_lines(job))
    # 空值不出行，否则会出现「安排线路：」这种半截话
    assert "安排线路" not in body


def test_factory_card_keeps_old_five_lines() -> None:
    """没有 schema 的老数据必须保持原样，不能因为这次改动变形。"""
    lines = fe._job_card_lines(FACTORY_JOB)
    assert lines[0] == "厂名：广州华荻科技有限公司（焊工）"
    assert "工价：35-40 元/小时" in lines
    assert "吃住：包吃工作餐，住宿补贴 200 元/月" in lines


def test_legacy_subway_without_schema_still_says_line() -> None:
    """老数据没有 vertical_id → 没有 schema，但名字里是地铁，标题也不能写「厂名」。"""
    job = {k: v for k, v in SUBWAY_JOB.items() if k not in ("employer_label", "position_schema")}
    lines = fe._job_card_lines(job)
    assert lines[0].startswith("线路：深圳地铁安检"), lines[0]


def test_send_info_parts_uses_schema() -> None:
    fe.set_remote_jobs({"深圳": [SUBWAY_JOB]})
    try:
        parts = fe.send_info_parts({"city": "深圳", "job_index": 0})
        assert len(parts) >= 3
        assert parts[0].startswith("线路：")
        assert "安排线路" in parts[0]
        assert "面试地点" in parts[1]
    finally:
        fe.set_remote_jobs({})

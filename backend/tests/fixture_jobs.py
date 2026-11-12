"""流程测试共用的岗位夹具（4222 岗位数据的测试替身，与生产数据无关）。

岗位字段与 4222 的 GET /api/v1/agent/jobs 契约一致：
factory_name / job_title / wage_text / hours_text / age_text / welfare_text / place
"""

from __future__ import annotations

GUANGZHOU = {
    "factory_name": "利口福食品厂",
    "job_title": "利口福食品厂 普工",
    "wage_text": "16 元/小时",
    "hours_text": "两班倒，月休 2-4 天",
    "age_text": "18-48 岁",
    "welfare_text": "包吃包住",
    "place": "番禺南村员岗地铁站附近",
}

SHENZHEN = {
    "factory_name": "龙华电子厂",
    "job_title": "龙华电子厂 质检",
    "wage_text": "20 元/小时",
    "hours_text": "两班倒，月休 4 天",
    "age_text": "18-45 岁",
    "welfare_text": "包吃包住，满三个月奖励 500",
    "place": "龙华大浪街道",
}

DONGGUAN = {
    "factory_name": "长安五金厂",
    "job_title": "长安五金厂 操作工",
    "wage_text": "19 元/小时",
    "hours_text": "两班倒，月休 2 天",
    "age_text": "18-50 岁",
    "welfare_text": "包住，饭补 300 元/月",
    "place": "长安镇乌沙社区",
}

JOBS_BY_CITY: dict[str, list[dict[str, str]]] = {
    "广州": [GUANGZHOU],
    "深圳": [SHENZHEN],
    "东莞": [DONGGUAN],
}

__all__ = ["GUANGZHOU", "SHENZHEN", "DONGGUAN", "JOBS_BY_CITY"]

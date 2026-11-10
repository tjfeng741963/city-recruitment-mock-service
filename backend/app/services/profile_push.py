"""把对话里抽出的候选人档案推给 4222（前端读它的库，不读 8090）。

约定（见 docs/候选人档案契约.md）：
- 4222 侧 POST /api/v1/agent/profile 是幂等 upsert，缺的键不覆盖
- 定位优先 customer_id，没有就按 external_conversation_id
- 鉴权走服务间头 X-Profile-Token（与 4222 的 REA_PROFILE_TOKEN 同值）
- 推送是**尽力而为**：没配 token 直接不发，任何异常都吞掉，
  绝不影响客户收到回复——档案晚一轮再推不迟，回复晚了客户就跑了
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

import httpx

from .flow_engine import (
    ACTION_BOOK,
    ACTION_GAVE_UP,
    ACTION_HANDOFF,
    INTERVIEW_WINDOW,
    STAGE_ASK_CITY,
    STAGE_ASK_INTERVIEW,
    STAGE_COLLECT,
    STAGE_DONE,
    STAGE_KB,
    STAGE_SEND_INFO,
    jobs_for_city,
)

DEFAULT_URL = "http://127.0.0.1:4222/api/v1/agent/profile"
DEFAULT_DEVICE = "pc-office-01"
TIMEOUT = 3.0

# 8090 的流程阶段 → 4222 的档案例 stage
_STAGE_MAP = {
    STAGE_ASK_CITY: "asking",
    STAGE_KB: "asking",
    # 信息已经发出去，客户在考虑要不要来
    STAGE_SEND_INFO: "offered",
    STAGE_ASK_INTERVIEW: "offered",
    STAGE_COLLECT: "offered",
    STAGE_DONE: "booked",
}


def _job_of(slots: dict[str, Any]) -> dict[str, str]:
    jobs = jobs_for_city(str(slots.get("city") or ""))
    if not jobs:
        return {}
    try:
        index = int(slots.get("job_index") or 0)
    except (TypeError, ValueError):
        index = 0
    return jobs[min(max(index, 0), len(jobs) - 1)]


def _date_time(interview_at: Any) -> tuple[str, str]:
    """ISO → (YYYY-MM-DD, HH:MM)。带时区的按它自己的时区，不转本地。"""
    text = str(interview_at or "").strip()
    if not text:
        return "", ""
    try:
        when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return "", ""
    return when.strftime("%Y-%m-%d"), when.strftime("%H:%M")


def _stage(slots: dict[str, Any], stage: str, action: str | None) -> str:
    if action == ACTION_BOOK:
        return "booked"
    if action in (ACTION_GAVE_UP, ACTION_HANDOFF):
        return "gave_up"
    return _STAGE_MAP.get(str(stage or ""), "asking")


def build_profile(
    slots: dict[str, Any], stage: str = "", action: str | None = None
) -> dict[str, Any]:
    """slots → 4222 的 profile。

    4222 是「出现的键才覆盖」（部分更新），所以空值一律不出现：
    否则一次「只改备注」的推送会把前端手填的姓名电话擦成空。
    """
    slots = slots or {}
    job = _job_of(slots)
    # 岗位字段统一为 4222 jobs 契约名：job_title 岗位（含工种）、factory_name 厂名
    title = str(job.get("job_title") or "")
    factory = str(job.get("factory_name") or "") or (title.split(" ")[0] if title else "")
    interview_date, interview_time = _date_time(slots.get("interview_at"))
    # 默认窗口是「09:00-11:00」，比 interview_at 的整点更准，优先用它
    window = str(slots.get("interview_window") or "").strip() or interview_time

    fields = {
        "name": str(slots.get("name") or ""),
        "phone": str(slots.get("phone") or ""),
        "province": str(slots.get("province") or ""),
        "city": str(slots.get("city") or ""),
        "district": str(slots.get("district") or ""),
        "gender": str(slots.get("gender") or ""),
        "record": str(slots.get("record") or ""),
        "age": slots.get("age") if isinstance(slots.get("age"), int) else None,
        "job_title": title,
        "factory_name": factory,
        "interview_date": interview_date,
        "interview_time": window,
        "notes": str(slots.get("notes") or ""),
    }
    profile: dict[str, Any] = {
        key: value for key, value in fields.items() if value not in ("", None)
    }
    profile["stage"] = _stage(slots, stage, action)
    return profile


def has_content(profile: dict[str, Any]) -> bool:
    """档案确实有东西才值得发一次 HTTP。"""
    return any(
        profile.get(key)
        for key in (
            "city",
            "province",
            "interview_date",
            "name",
            "phone",
            "district",
            "notes",
        )
    )


def _headers(token: str) -> dict[str, str]:
    # 4222 侧 `authorizeProfileRequest` 认的是 X-Profile-Token（服务间通道）
    return {"X-Profile-Token": token, "Content-Type": "application/json"}


async def push(device_code: str, session_key: str, profile: dict[str, Any]) -> bool:
    """推一份档案。成功 True，其余一律 False（不抛异常，不打日志噪音）。"""
    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    if not token:
        return False
    url = os.getenv("FLOW_PROFILE_URL", DEFAULT_URL)
    body = {
        "device_code": device_code or DEFAULT_DEVICE,
        "external_conversation_id": session_key,
        "profile": profile or {},
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(url, json=body, headers=_headers(token))
        return 200 <= resp.status_code < 300
    except Exception:  # noqa: BLE001  4222 挂了也不能连累客户回复
        return False


__all__ = ["build_profile", "has_content", "push"]

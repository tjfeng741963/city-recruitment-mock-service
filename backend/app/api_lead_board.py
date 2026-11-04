"""今日待办看板：页面 + 数据。

- `GET /leads/board`      返回 HTML 空壳，**公开**。浏览器从地址栏直接打开要能拿到，
  否则页面还没渲染就先被 401 挡住，没法让人贴 token。
- `GET /leads/board/data` 名单数据，`AdminUser` 鉴权。页面里的 token 从 localStorage 读，
  所以"页面公开、数据要登录"是成立的。

分组只做三件事，全部按东八区判定（库里是 naive UTC）：

- today    已约面且约的时间落在本地今天，按时间升序；`day` 精度天然排在最前
- pending  到点了还没确认来没来（`pending_confirm=1`），按该核实的时刻升序
- followup 已约面/有意向但 24 小时没动静，按最后更新时间倒序

另按 `docs/_contract/设备心跳与看板契约.md` 第四、五节追加两块：

- `device` 第一条设备的心跳快照（没有设备时整块为 null）
- `alerts` 采集端离线告警，页面顶部红条直接用它的 `text`
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from .deps import AdminUser, SessionDep
from .models import Conversation, Customer, Device
from .models_lead import (
    PRECISION_DAY,
    STAGE_BOOKED,
    STAGE_INTENT,
    STAGE_LABEL,
    Lead,
)

router = APIRouter(prefix="/api/v1/leads", tags=["leads-board"])

LOCAL_TZ = timezone(timedelta(hours=8))

# 页面路径锚定 __file__：进程 cwd 可能是仓库根，也可能是 backend，
# 相对路径在另一种 cwd 下会 404。
PAGE_PATH = Path(__file__).parent / "static" / "leads.html"

# 超过这个时长没有状态更新就算"该催一下"
FOLLOWUP_AFTER = timedelta(hours=24)

# 心跳超过这个秒数就当采集端失联（与 workers/device_watch.py 的判定保持一致）
OFFLINE_AFTER_SECONDS = 90

# 企微探测结果 → 给人看的原因。设备没报（unknown）就不瞎猜，只报离线。
WECOM_REASON = {
    "login_required": "企业微信已退出登录，需扫码",
    "hidden": "窗口被隐藏，可能已被风控",
    "not_running": "企业微信未运行",
}


# ─────────────────────────── 工具 ───────────────────────────
def _now_naive() -> datetime:
    """当前时刻的 naive UTC —— 与库里的存法保持一致。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _local_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    """本地（东八区）今天的 [起, 止)，都换成 naive UTC。"""
    local = now.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ)
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    to_utc = lambda d: d.astimezone(timezone.utc).replace(tzinfo=None)  # noqa: E731
    return to_utc(start_local), to_utc(end_local)


def _iso_local(dt: datetime | None) -> str | None:
    """统一带 +08:00 给前端，省得浏览器按自己时区猜。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ).isoformat(timespec="seconds")


def _base_stmt():
    """线索 + 客户昵称。昵称在 customers 上，得跨会话表 join 两跳。"""
    return (
        select(Lead, Customer.nickname)
        .join(Conversation, Conversation.id == Lead.conversation_id)
        .join(Customer, Customer.id == Conversation.customer_id)
    )


def _row(lead: Lead, nickname: str | None) -> dict:
    return {
        "conversation_id": lead.conversation_id,
        "nickname": nickname,
        "stage": lead.stage,
        "stage_label": STAGE_LABEL.get(lead.stage, lead.stage),
        "interview_at": _iso_local(lead.interview_at),
        # 精度缺失的历史数据按最保守的 day 解释
        "interview_precision": lead.interview_precision or PRECISION_DAY,
        "interview_place": lead.interview_place,
        "job_title": lead.job_title,
        "pending_confirm": bool(lead.pending_confirm),
        "age": lead.age,
        "city": lead.city,
        "updated_at": _iso_local(lead.updated_at),
    }


# ─────────────────────────── 设备 / 告警 ───────────────────────────
def _age_seconds(heartbeat_at: datetime | None, now: datetime) -> int | None:
    """距上次心跳多少秒（整数）。库里是 naive UTC，读出来可能带 tz，统一归一到 UTC。"""
    if heartbeat_at is None:
        return None
    hb = heartbeat_at
    if hb.tzinfo is not None:
        hb = hb.astimezone(timezone.utc).replace(tzinfo=None)
    return max(0, int((now - hb).total_seconds()))


def _device_payload(device: Device | None, now: datetime) -> dict | None:
    """契约第四节的 device 块：字段名固定这五个，别自作主张加东西。"""
    if device is None:
        return None
    return {
        "device_code": device.device_code,
        "status": device.status,
        "wecom_state": device.wecom_state,
        "last_heartbeat_at": _iso_local(device.last_heartbeat_at),
        "age_seconds": _age_seconds(device.last_heartbeat_at, now),
    }


def _alerts(device: dict | None) -> list[dict]:
    """生成看板顶部红条。都在线就是空数组，页面据此把整条隐藏掉。"""
    if device is None:
        # 一台设备都没注册过：消息肯定收不到，按最严重处理
        return [
            {
                "level": "danger",
                "code": "agent_offline",
                "text": "采集端从未上报心跳，期间消息收不到",
            }
        ]

    age = device["age_seconds"]
    online = device["status"] == "online" and age is not None and age <= OFFLINE_AFTER_SECONDS

    if online:
        # 心跳正常不代表能用：窗口隐藏/退出登录时 agent 会主动停手，
        # 一条消息都发不出去。这种情况必须报出来，否则看板一片绿、实际全停。
        blocked = WECOM_REASON.get(device["wecom_state"])
        if not blocked:
            return []
        return [
            {
                "level": "danger",
                "code": "agent_blocked",
                "text": f"采集端在线，但发不出消息（{blocked}），自动回复已暂停",
            }
        ]

    if age is None:
        text = "采集端从未上报心跳，期间消息收不到"
    else:
        text = f"采集端离线 {age // 60} 分钟，期间消息收不到"

    reason = WECOM_REASON.get(device["wecom_state"])
    if reason:
        text = f"{text}（{reason}）"

    return [{"level": "danger", "code": "agent_offline", "text": text}]


# ─────────────────────────── 页面 ───────────────────────────
@router.get("/board", response_class=FileResponse)
async def board_page() -> FileResponse:
    """看板页面本体（空壳，不含任何名单）。"""
    if not PAGE_PATH.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "看板页面文件缺失")
    return FileResponse(PAGE_PATH, media_type="text/html")


# ─────────────────────────── 数据 ───────────────────────────
@router.get("/board/data")
async def board_data(admin: AdminUser, session: SessionDep) -> dict:
    now = _now_naive()
    day_start, day_end = _local_day_bounds(now)

    today_rows = (
        await session.execute(
            _base_stmt()
            .where(
                Lead.stage == STAGE_BOOKED,
                Lead.interview_at.is_not(None),
                Lead.interview_at >= day_start,
                Lead.interview_at < day_end,
            )
            .order_by(Lead.interview_at.asc())
        )
    ).all()

    # check_at 可能是 NULL（存量数据故意不回填），SQLite 里 NULL 排最前，
    # 正好让"从没扫过的"排在前面等人处理。
    pending_rows = (
        await session.execute(
            _base_stmt().where(Lead.pending_confirm.is_(True)).order_by(Lead.check_at.asc())
        )
    ).all()

    stale_before = now - FOLLOWUP_AFTER
    followup_rows = (
        await session.execute(
            _base_stmt()
            .where(
                Lead.stage.in_((STAGE_BOOKED, STAGE_INTENT)),
                Lead.updated_at.is_not(None),
                Lead.updated_at < stale_before,
            )
            .order_by(Lead.updated_at.desc())
        )
    ).all()

    today = [_row(lead, nick) for lead, nick in today_rows]
    pending = [_row(lead, nick) for lead, nick in pending_rows]
    followup = [_row(lead, nick) for lead, nick in followup_rows]

    # 单机阶段只认第一条设备；多台以后再看要不要按通道归属
    device_row = (
        await session.execute(select(Device).order_by(Device.id.asc()).limit(1))
    ).scalar_one_or_none()
    device = _device_payload(device_row, now)

    return {
        "counts": {
            "today": len(today),
            "pending": len(pending),
            "followup": len(followup),
        },
        "today": today,
        "pending": pending,
        "followup": followup,
        "device": device,
        "alerts": _alerts(device),
    }

"""数据巡检：把"库里的脏数据"变成能一眼看懂的清单。

跑法（在 ``backend/`` 下）::

    uv run python -m scripts.inspect              # 全部检查
    uv run python -m scripts.inspect --fix-safe   # 只自动修「安全」的问题

设计上的两条约束：

1. **只读，不改业务数据**。除 ``--fix-safe`` 显式声明为安全的修复外，不写库。
   巡检工具写坏数据，比不巡检更糟——没人会怀疑一个"检查工具"。
2. **退出码能进 cron/CI**：有 ``FAIL`` 返回 1，否则 0。``WARN`` 只提示，
   不阻断，因为大部分项（缺城市、置信度低）是常态噪音，阻断会让人干脆关掉巡检。

每一项都挂了 ``fixer=None`` + ``manual_reason``：``--fix-safe`` 的框架已经留好
（加一个 ``fixer`` 就能自动修），但**当前没有任何一项被判为安全**，原因见
``docs/日报与巡检.md``——简单说，这 8 项的修法要么依赖业务判断（城市、置信度），
要么是删数据（孤岛、重复），误修的代价远大于人工看一眼。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import unicodedata
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import Conversation, Device, Message
from app.models_kb import KbEntry
from app.models_lead import Lead
from app.settings import settings

OK = "OK"
WARN = "WARN"
FAIL = "FAIL"

# 展示用东八区；巡检结果给人看，时间不该跟着机器时区跑
LOCAL_TZ = timezone(timedelta(hours=8))

# 与 lead_extract.MIN_CONFIDENCE 同源：低于它的抽取结果不入库，能留在库里的
# 只能是历史数据或人工改过的，需要复核。
LOW_CONFIDENCE = 0.65

# 待核实挂多久算"没人管"。48 小时是两整天，跨越一个完整的工作周期。
PENDING_HOURS = 48

# 岗位缺城市占比超过这个值才算系统性问题，个别漏抽不值得报警。
MISSING_CITY_RATIO = 0.5

# 库体积提醒阈值。SQLite 单文件超 500MB 后备份和复制都开始变慢。
DB_SIZE_LIMIT_MB = 500


@dataclass
class CheckResult:
    key: str
    title: str
    level: str
    detail: str
    count: int = 0


# 修复函数签名：(session, result) -> 修掉的行数
Fixer = Callable[[AsyncSession, CheckResult], Awaitable[int]]


@dataclass(frozen=True)
class Check:
    key: str
    title: str
    runner: Callable[[AsyncSession], Awaitable[CheckResult]]
    # 为空表示"这一项有安全修法"；当前所有项都填了原因
    manual_reason: str = ""
    fixer: Fixer | None = field(default=None)


# ─────────────────────────── 工具 ───────────────────────────
async def _scalar(session: AsyncSession, stmt) -> int:  # noqa: ANN001
    return int((await session.execute(stmt)).scalar_one() or 0)


def _now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _db_path() -> Path | None:
    """SQLite 库文件路径；非 SQLite（Postgres）返回 None。"""
    url = settings.database_url
    if not url.startswith("sqlite"):
        return None
    if "///" not in url:
        return None
    return Path(url.split("///", 1)[1])


# ─────────────────────────── 检查项 ───────────────────────────
async def check_job_city(session: AsyncSession) -> CheckResult:
    total = await _scalar(
        session, select(func.count()).select_from(KbEntry).where(KbEntry.kind == "job")
    )
    if total == 0:
        return CheckResult("job_city", "岗位缺城市", OK, "库里还没有岗位条目", 0)

    missing = await _scalar(
        session,
        select(func.count())
        .select_from(KbEntry)
        .where(KbEntry.kind == "job", KbEntry.city.is_(None)),
    )
    ratio = missing / total
    level = WARN if ratio > MISSING_CITY_RATIO else OK
    return CheckResult(
        "job_city",
        "岗位缺城市",
        level,
        f"{missing}/{total} 个岗位没有 city（{ratio * 100:.1f}%，阈值 50%）",
        missing,
    )


async def check_low_confidence(session: AsyncSession) -> CheckResult:
    count = await _scalar(
        session,
        select(func.count()).select_from(Lead).where(Lead.confidence < LOW_CONFIDENCE),
    )
    level = WARN if count else OK
    return CheckResult(
        "low_confidence",
        "线索置信度低",
        level,
        f"{count} 条线索 confidence < {LOW_CONFIDENCE}",
        count,
    )


async def check_pending_confirm(session: AsyncSession) -> CheckResult:
    """待核实 = 到点了还没人确认来没来。这里只挑挂太久的。

    "挂了多久"优先看 ``check_at``（该核实的时刻），存量数据没有这个值，
    退回 ``updated_at``（最后一次有人碰过它）。
    """
    cutoff = _now_naive() - timedelta(hours=PENDING_HOURS)
    count = await _scalar(
        session,
        select(func.count())
        .select_from(Lead)
        .where(
            Lead.pending_confirm.is_(True),
            func.coalesce(Lead.check_at, Lead.updated_at) < cutoff,
        ),
    )
    level = WARN if count else OK
    return CheckResult(
        "pending_confirm",
        "长期待核实",
        level,
        f"{count} 条待核实超过 {PENDING_HOURS} 小时",
        count,
    )


async def check_orphan_messages(session: AsyncSession) -> CheckResult:
    """消息找不到会话 = 这些消息在界面上永远看不到。

    这是数据完整性问题，不是噪音，所以判 FAIL：只可能是删除会话时没清消息，
    或者写消息时拿错了 conversation_id。
    """
    count = await _scalar(
        session,
        select(func.count())
        .select_from(Message)
        .where(~Message.conversation_id.in_(select(Conversation.id))),
    )
    level = FAIL if count else OK
    return CheckResult(
        "orphan_messages",
        "会话孤岛",
        level,
        f"{count} 条消息的 conversation_id 找不到所属会话",
        count,
    )


async def check_duplicate_leads(session: AsyncSession) -> CheckResult:
    dup = (
        select(Lead.conversation_id)
        .group_by(Lead.conversation_id)
        .having(func.count() > 1)
        .subquery()
    )
    count = await _scalar(session, select(func.count()).select_from(dup))
    level = WARN if count else OK
    return CheckResult(
        "duplicate_leads",
        "重复线索",
        level,
        f"{count} 个会话有多条线索记录（同一会话只应有一条）",
        count,
    )


async def check_device_heartbeat(session: AsyncSession) -> CheckResult:
    total = await _scalar(session, select(func.count()).select_from(Device))
    count = await _scalar(
        session,
        select(func.count()).select_from(Device).where(Device.last_heartbeat_at.is_(None)),
    )
    level = WARN if count else OK
    detail = (
        f"{count}/{total} 台设备从未上报心跳"
        if total
        else "没有注册设备（采集端未接入）"
    )
    return CheckResult("device_heartbeat", "设备从未心跳", level, detail, count)


async def check_conversation_external_id(session: AsyncSession) -> CheckResult:
    count = await _scalar(
        session,
        select(func.count())
        .select_from(Conversation)
        .where((Conversation.external_id.is_(None)) | (Conversation.external_id == "")),
    )
    level = WARN if count else OK
    return CheckResult(
        "conversation_external_id",
        "卡片错误",
        level,
        f"{count} 个会话 external_id 为空（回执对不上，卡片发不出去）",
        count,
    )


async def check_db_size(session: AsyncSession) -> CheckResult:  # noqa: ARG001
    path = _db_path()
    if path is None:
        return CheckResult("db_size", "库体积", OK, "非 SQLite 库，跳过体积检查", 0)
    if not path.exists():
        return CheckResult("db_size", "库体积", OK, f"{path} 不存在（新库）", 0)

    size_mb = path.stat().st_size / (1024 * 1024)
    level = WARN if size_mb > DB_SIZE_LIMIT_MB else OK
    return CheckResult(
        "db_size",
        "库体积",
        level,
        f"{size_mb:.1f} MB（{path}，阈值 {DB_SIZE_LIMIT_MB} MB）",
        int(size_mb),
    )


CHECKS: tuple[Check, ...] = (
    Check(
        "job_city",
        "岗位缺城市",
        check_job_city,
        "城市要从岗位原文里抽，误判会改坏知识库原文，只能人工核对",
    ),
    Check(
        "low_confidence",
        "线索置信度低",
        check_low_confidence,
        "置信度低说明模型判不准，改状态要靠人看对话，自动修等于乱猜",
    ),
    Check(
        "pending_confirm",
        "长期待核实",
        check_pending_confirm,
        "到面/爽约只能由人确认，工具无权替客户下结论",
    ),
    Check(
        "orphan_messages",
        "会话孤岛",
        check_orphan_messages,
        "补会话还是删消息会影响历史，必须人工判断哪边是对的",
    ),
    Check(
        "duplicate_leads",
        "重复线索",
        check_duplicate_leads,
        "合并两条线索要决定保留哪个 stage，自动合并会丢进度",
    ),
    Check(
        "device_heartbeat",
        "设备从未心跳",
        check_device_heartbeat,
        "心跳为空说明采集端还没跑起来，删设备记录解决不了问题",
    ),
    Check(
        "conversation_external_id",
        "卡片错误",
        check_conversation_external_id,
        "external_id 缺失通常是采集端上报丢了，需要重新同步而不是清空",
    ),
    Check(
        "db_size",
        "库体积",
        check_db_size,
        "压缩/归档库需要停机窗口和备份，脚本里做这个太危险",
    ),
)


# ─────────────────────────── 执行 ───────────────────────────
async def run_all(fix_safe: bool = False) -> tuple[list[CheckResult], int]:
    """跑完全部检查，返回 ``(结果列表, 退出码)``。"""
    results: list[CheckResult] = []
    async with SessionLocal() as session:
        for check in CHECKS:
            try:
                result = await check.runner(session)
            except Exception as exc:  # noqa: BLE001
                # 单项炸掉不该拖垮整轮巡检（可能只是某张表还没建）。
                # 记 WARN 而不是 FAIL：这是工具/环境问题，不是数据问题。
                await session.rollback()
                result = CheckResult(check.key, check.title, WARN, f"检查执行失败：{exc}", 0)
            results.append(result)

        if fix_safe:
            await _fix_safe(session, results)

    code = 1 if any(r.level == FAIL for r in results) else 0
    return results, code


def _pending_fixes(results: list[CheckResult]) -> list[tuple[Check, CheckResult]]:
    """当前有问题的项里，哪些挂了固定修法。"""
    return [
        (check, result)
        for check, result in zip(CHECKS, results)
        if result.level != OK and check.fixer is not None
    ]


async def _fix_safe(session: AsyncSession, results: list[CheckResult]) -> None:
    """只跑显式声明为安全的修复；``fixer`` 为空的项一律跳过。

    框架在这里：新增检查时给它一个 ``fixer`` 就能被 ``--fix-safe`` 处理。
    当前 8 项全部 ``fixer=None``，所以这个方法实际不写库。
    """
    for check, result in _pending_fixes(results):
        assert check.fixer is not None
        try:
            fixed = await check.fixer(session, result)
            await session.commit()
            result.detail = f"{result.detail}｜已自动修复 {fixed} 条"
        except Exception as exc:  # noqa: BLE001
            await session.rollback()
            result.detail = f"{result.detail}｜自动修复失败：{exc}"


def _skipped(results: list[CheckResult]) -> list[tuple[str, str]]:
    """需要修但不敢修的项（含原因），供 ``--fix-safe`` 打印。"""
    out = []
    for check, result in zip(CHECKS, results):
        if result.level == OK:
            continue
        if check.fixer is None:
            out.append((result.title, check.manual_reason))
    return out


def render(results: list[CheckResult], fix_safe: bool = False) -> str:
    stamp = datetime.now(timezone.utc).astimezone(LOCAL_TZ).strftime("%Y-%m-%d %H:%M")
    lines = [f"===== 数据巡检 {stamp} ====="]
    for result in results:
        # 标题列宽固定 14 个显示宽度，后面的说明从同一列开始，扫读时不用左右跳
        lines.append(f"[{result.level}] {_pad(result.title, 14)}{result.detail}")

    counts = {level: sum(1 for r in results if r.level == level) for level in (OK, WARN, FAIL)}
    lines.append("-" * 60)
    lines.append(
        f"共 {len(results)} 项：OK {counts[OK]} / WARN {counts[WARN]} / FAIL {counts[FAIL]}"
    )

    if fix_safe:
        fixed = len(_pending_fixes(results))
        skipped = _skipped(results)
        lines.append(f"--fix-safe：可自动修复 {fixed} 项，跳过 {len(skipped)} 项（均需人工）")
        for title, reason in skipped:
            lines.append(f"  - {title}：{reason}")
    return "\n".join(lines)


def _pad(text: str, width: int) -> str:
    """按显示宽度补空格（中文算 2 列），否则表格会歪。"""
    used = sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)
    return text + " " * max(0, width - used)


# ─────────────────────────── 入口 ───────────────────────────
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="inspect", description="数据巡检（只读）")
    parser.add_argument(
        "--fix-safe",
        action="store_true",
        help="只自动修被显式判定为安全的问题（当前没有这样的项）",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    results, code = asyncio.run(run_all(fix_safe=args.fix_safe))
    print(render(results, fix_safe=args.fix_safe))
    return code


if __name__ == "__main__":
    sys.exit(main())

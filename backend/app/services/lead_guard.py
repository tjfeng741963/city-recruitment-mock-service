"""线索链路的急停开关：开关文件存在即关闭，每次调用实时 stat。

为什么用「文件」而不是环境变量：

- 环境变量改完要重启后端才生效。抽取出错（模型乱判/成本飙升/客户投诉）时，
  重启意味着几十秒的不可用，还可能把正在处理的会话打断；
- 而运维在服务器/本机上 `touch` 一个文件是秒级的，下一轮抽取立刻看到，
  不用碰进程、不用等发布。急停的价值全在「当天就能生效」。

两个开关互相独立：

- ``LEAD_EXTRACT_OFF``：关掉谈单状态抽取（判 stage、判到面）。**不影响自动回复**，
  回复链路完全不读这个文件。
- ``LEAD_SWEEP_OFF``：关掉待核实扫描（把到点的约面标成 pending_confirm）。

实现上的两条硬约束：

1. 每次调用都重新 stat，**任何一层都不许缓存**——缓存一次就等于要重启才能生效。
2. 目录锚定 ``__file__``，不用相对路径 ``data/``：后端被从别的 cwd 启动时
   相对路径会指到别处，开关看起来关上了其实没关，这是最危险的一种「假安全」。
"""

from __future__ import annotations

import os
from pathlib import Path

# backend/data —— 锚定本文件位置（backend/app/services/lead_guard.py → backend）
DATA_DIR = Path(__file__).resolve().parents[2] / "data"

# 开关文件名。存在 = 关闭，不存在 = 开启（宁可漏判也不要错判的默认值）
EXTRACT_SWITCH = "LEAD_EXTRACT_OFF"
SWEEP_SWITCH = "LEAD_SWEEP_OFF"

# 允许覆盖目录，仅测试与特殊部署使用（生产请走默认路径）
DIR_ENV = "LEAD_GUARD_DIR"


def _dir() -> Path:
    """当前生效的开关目录：环境变量优先，否则用锚定 __file__ 的默认值。"""
    override = os.environ.get(DIR_ENV)
    return Path(override) if override else DATA_DIR


def _check(filename: str, off_reason: str) -> tuple[bool, str]:
    """文件存在即为关闭。每次调用都重新 stat，不缓存。

    目录不存在时 ``Path.exists()`` 返回 False，即视为开启，不抛异常——
    开关文件都还没建，说明没人关过，此时不该让主流程起不来。
    """
    if (_dir() / filename).exists():
        return False, off_reason
    return True, ""


def extract_enabled() -> tuple[bool, str]:
    """是否允许做谈单状态抽取。返回 ``(是否开启, 关闭原因)``。

    关闭原因只在关闭时非空，方便调用方直接塞进日志或 API 返回。
    """
    return _check(EXTRACT_SWITCH, f"抽取已关闭（存在 {EXTRACT_SWITCH}）")


def sweep_enabled() -> tuple[bool, str]:
    """是否允许扫描到点的约面并标待核实。返回 ``(是否开启, 关闭原因)``。"""
    return _check(SWEEP_SWITCH, f"扫描已关闭（存在 {SWEEP_SWITCH}）")


def status() -> dict:
    """两个开关的当前状态，供脚本/接口原样输出。"""
    extract_ok, extract_reason = extract_enabled()
    sweep_ok, sweep_reason = sweep_enabled()
    return {
        "extract": {"enabled": extract_ok, "reason": extract_reason},
        "sweep": {"enabled": sweep_ok, "reason": sweep_reason},
        "data_dir": str(_dir()),
    }

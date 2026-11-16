"""客户端单实例锁（agent/autopilot.py）。

三条断言：
1. 命名互斥体在 Windows 上确实互斥（开两个进程，第二个必须拿不到）
2. 守卫条件不再只挂在 --watch 上——默认模式也会发消息，必须同样加锁
3. 拿不到句柄时失败关闭（拒绝启动），而不是放行

第 2、3 条用源码静态检查：autopilot.py 依赖 win32api，不能在测试进程里直接
import（见 conftest.py 的说明），但「守卫覆盖哪些模式」「句柄为空时返回什么」
是纯粹的代码结构问题，读源码断言比跑起来更可靠。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
AUTOPILOT = AGENT_DIR / "autopilot.py"
MUTEX_NAME = "Global\\CityRecruitAutopilot"

# 子进程：拿锁 → 汇报 → 睡住不放（由父进程 kill）
HOLD_SCRIPT = """
import ctypes, sys, time
ERROR_ALREADY_EXISTS = 183
kernel32 = ctypes.windll.kernel32
h = kernel32.CreateMutexW(None, True, sys.argv[1])
if not h:
    print("FAIL_CREATE"); sys.exit(3)
if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
    print("ALREADY"); sys.exit(0)
print("ACQUIRED", flush=True)
time.sleep(30)
"""


@pytest.mark.skipif(sys.platform != "win32", reason="命名互斥体是 Windows 特性")
def test_named_mutex_is_exclusive_across_processes() -> None:
    holder = subprocess.Popen(
        [sys.executable, "-c", HOLD_SCRIPT, MUTEX_NAME],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        line = holder.stdout.readline().strip()
        assert line == "ACQUIRED", f"第一个进程没能拿到锁：{line!r}"

        second = subprocess.run(
            [sys.executable, "-c", HOLD_SCRIPT, MUTEX_NAME],
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert second.stdout.strip() == "ALREADY", (
            f"第二个进程不该拿到锁，实际输出：{second.stdout.strip()!r}"
        )
    finally:
        holder.kill()
        holder.wait(timeout=10)


def test_guard_covers_every_sending_mode_not_only_watch() -> None:
    """守卫条件不能再写成 `if args.watch and not acquire_single_instance()`。

    2026-11-14 实机：开着一个常驻实例，又误点一次快捷方式（不带 --watch 的
    默认模式），两个进程都在调 drain() 真发消息，客户收到重复回复。
    """
    src = AUTOPILOT.read_text(encoding="utf-8")
    assert "if args.watch and not acquire_single_instance()" not in src, (
        "守卫仍然只覆盖 --watch；默认模式会绕过锁，导致双开"
    )
    assert "local_only" in src, "应改为按「本次是否会碰企微」决定是否加锁"
    # 纯本地命令（不发送、不按键鼠）才允许并行
    for flag in ("args.list", "args.reset", "args.retry_held", "args.flush_receipts"):
        assert flag in src, f"纯本地命令 {flag} 应计入放行名单"


def test_mutex_fails_closed() -> None:
    """拿不到锁句柄时返回 False（拒绝启动），不能放行。"""
    src = AUTOPILOT.read_text(encoding="utf-8")
    start = src.index("def acquire_single_instance")
    body = src[start : start + 1400]
    assert "if not handle:\n            return False" in body, "句柄为空时必须拒绝启动"
    assert "return True  # 拿不到锁就别拦住用户" not in body

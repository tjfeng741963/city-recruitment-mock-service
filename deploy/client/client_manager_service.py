"""Local management operations. Reading/updating never starts the sender."""

from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import io
from contextlib import contextmanager
import json
import ntpath
from pathlib import Path
import re
import subprocess
import time
from typing import Callable
import zipfile

import client_updater as updater


STARTUP_STATUSES = {
    "starting",
    "waiting_wecom",
    "waiting_login",
    "initializing",
    "ready",
    "failed",
    "stopped",
}


def read_client_state(root: Path) -> dict:
    """Read the autopilot business state written during startup.

    A PID only proves that Python existed at one instant.  This file is the
    small local protocol between autopilot and the management window.  Invalid
    or missing state is treated as ``starting`` while a matching process is
    alive, so an old package cannot claim that it is ready by accident.
    """
    path = Path(root) / "logs" / "client-state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return {}
    if not isinstance(value, dict):
        return {}
    status = value.get("status")
    return value if status in STARTUP_STATUSES else {}


def clear_client_state(root: Path) -> None:
    """Discard a previous run's state before launching or after stopping."""
    try:
        (Path(root) / "logs" / "client-state.json").unlink(missing_ok=True)
    except OSError:
        pass


def run_powershell(script: str) -> dict:
    preamble = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "
    encoded = base64.b64encode((preamble + script).encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True, timeout=25, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        # PowerShell errors may contain command lines or local configuration.
        raise updater.UpdateError("无法读取或控制客户端进程，请检查当前 Windows 用户权限。")
    try:
        value = json.loads(result.stdout.decode("utf-8-sig")) if result.stdout.strip() else {}
    except (ValueError, UnicodeError) as exc:
        raise updater.UpdateError("Windows 状态返回格式异常，操作已停止。") from exc
    if not isinstance(value, dict):
        raise updater.UpdateError("Windows 状态返回格式异常，操作已停止。")
    return value


def system_snapshot() -> dict:
    return run_powershell(r"""$processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'python.exe','pythonw.exe' -and $_.CommandLine -like '*autopilot.py*'
} | ForEach-Object {
    [pscustomobject]@{Name=$_.Name; CommandLine=$_.CommandLine; ProcessId=$_.ProcessId;
      CreationDate=$_.CreationDate.ToUniversalTime().ToString('o')}
})
$task = Get-ScheduledTask -TaskName CloudPilot -TaskPath '\' -ErrorAction SilentlyContinue
$enabled = $null
if ($task) { $enabled = [bool]$task.Settings.Enabled }
[pscustomobject]@{processes=$processes; task_enabled=$enabled} | ConvertTo-Json -Depth 4 -Compress
""")


def is_client_process(row: dict, root: Path) -> bool:
    if str(row.get("Name", "")).lower() not in {"python.exe", "pythonw.exe"}:
        return False
    tokens = [quoted or plain for quoted, plain in re.findall(r'"([^"]*)"|([^\s"]+)', str(row.get("CommandLine", "")))]
    if len(tokens) < 2:
        return False
    index = 1
    while index < len(tokens) and tokens[index] in {"-u", "-B", "-E", "-s", "-S", "-I"}:
        index += 1
    if index == len(tokens):
        return False
    expected = ntpath.normcase(ntpath.normpath(str(root / "autopilot.py")))
    actual = ntpath.normcase(ntpath.normpath(tokens[index]))
    return actual == expected


def terminate_verified_process(row: dict, root: Path) -> None:
    if not is_client_process(row, root):
        raise updater.UpdateError("拒绝停止非本客户端进程。")
    process_id = int(row["ProcessId"])
    if process_id <= 0 or not row.get("CreationDate"):
        raise updater.UpdateError("进程标识不完整，未执行停止。")
    def literal(value):
        return "'" + str(value).replace("'", "''") + "'"
    run_powershell(f"""
$p = Get-CimInstance Win32_Process -Filter 'ProcessId={process_id}'
if ($p) {{
    if ($p.CreationDate.ToUniversalTime().ToString('o') -cne {literal(row['CreationDate'])} -or
        $p.CommandLine -cne {literal(row['CommandLine'])} -or $p.Name -cne {literal(row['Name'])}) {{
        throw 'Client process identity changed; refusing stop'
    }}
    $handle = Get-Process -Id {process_id} -ErrorAction Stop
    # Keep the process handle open and check its start time before termination.
    $null = $handle.Handle
    $verified = Get-CimInstance Win32_Process -Filter 'ProcessId={process_id}'
    if (-not $verified -or $verified.CreationDate.ToUniversalTime().ToString('o') -cne {literal(row['CreationDate'])}) {{
        throw 'Client PID changed; refusing stop'
    }}
    Stop-Process -Id $handle.Id -ErrorAction Stop
    if (-not $handle.WaitForExit(5000)) {{ throw 'Client process did not exit' }}
}}
""")


def is_process_alive(pid: int, created_at: str) -> bool:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.OpenProcess(0x100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if not handle:
        if ctypes.get_last_error() == 87:  # PID no longer exists
            return False
        raise OSError(ctypes.get_last_error(), "无法核验自动回复进程")
    try:
        if kernel.WaitForSingleObject(handle, 0) != 258:  # WAIT_TIMEOUT means still running
            return False
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise OSError(ctypes.get_last_error(), "无法核验进程启动时间")
        ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        observed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        elapsed = observed - datetime(1601, 1, 1, tzinfo=timezone.utc)
        micros = (elapsed.days * 86400 + elapsed.seconds) * 1000000 + elapsed.microseconds
        return ticks // 10 == micros
    finally:
        kernel.CloseHandle(handle)


def require_interactive_session() -> None:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.ProcessIdToSessionId.argtypes = (wintypes.DWORD, ctypes.POINTER(wintypes.DWORD))
    session = wintypes.DWORD()
    if not kernel.ProcessIdToSessionId(kernel.GetCurrentProcessId(), ctypes.byref(session)) or session.value == 0:
        raise updater.UpdateError("请在已连接的 Windows 桌面打开客户端管理器。")
    wts = ctypes.WinDLL("wtsapi32", use_last_error=True)
    wts.WTSQuerySessionInformationW.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.c_int,
                                               ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD))
    wts.WTSFreeMemory.argtypes = (ctypes.c_void_p,)
    buffer = ctypes.c_void_p()
    size = wintypes.DWORD()
    if not wts.WTSQuerySessionInformationW(None, session.value, 8, ctypes.byref(buffer), ctypes.byref(size)):
        raise updater.UpdateError("无法确认 Windows 桌面已连接。")
    try:
        if size.value < ctypes.sizeof(ctypes.c_int) or ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int))[0] != 0:
            raise updater.UpdateError("Windows 桌面已断开，请重新连接后启动回复。")
    finally:
        wts.WTSFreeMemory(buffer)


@contextmanager
def management_lock():
    handle = updater._acquire_mutex()
    try:
        yield
    finally:
        updater._release_mutex(handle)


class ManagerService:
    def __init__(self, root: Path):
        self.root = Path(root)

    def status(self) -> dict:
        snapshot = system_snapshot()
        processes = snapshot.get("processes", [])
        owned = [(int(row["ProcessId"]), str(row["CreationDate"])) for row in processes
                 if is_client_process(row, self.root)]
        return self._status(owned, len(processes) - len(owned), snapshot.get("task_enabled"))

    def _status(self, owned: list[tuple[int, str]], other_running: int, task_enabled: bool | None) -> dict:
        try:
            version = json.loads((self.root / ".client-version.json").read_text(encoding="utf-8"))
            commit = version.get("commit") if isinstance(version, dict) else None
        except (OSError, ValueError):
            commit = None
        if not isinstance(commit, str) or not re.fullmatch("[0-9a-f]{40}", commit):
            commit = None
        runtime = read_client_state(self.root)
        startup_status = str(runtime.get("status") or ("starting" if owned else "stopped"))
        detail = str(runtime.get("detail") or "")
        runtime_pid = runtime.get("pid")
        try:
            runtime_pid = int(runtime_pid)
        except (TypeError, ValueError):
            runtime_pid = None
        owned_pids = {pid for pid, _ in owned}
        if owned and runtime_pid not in owned_pids:
            # The state file may belong to the previous short-lived process.
            # Wait for this process to publish its own state before calling it
            # ready, even if the old file said ``ready``.
            startup_status = "starting"
            detail = "正在等待客户端上报本次启动状态。"
        # A previous process may have left ``ready`` behind.  Once its PID is
        # gone, surface a failed launch instead of a green stale snapshot.
        if not owned and startup_status not in {"stopped", "failed"}:
            startup_status = "failed"
            detail = f"{detail}；客户端进程已退出，未保持运行。" if detail else "客户端进程已退出，未保持运行。"
        result = {
            "commit": commit,
            "running": len(owned),
            "task_enabled": task_enabled,
            "other_running": other_running,
            "startup_status": startup_status,
            "startup_detail": detail,
            "wecom_state": runtime.get("wecom_state"),
            "updated_at": runtime.get("updated_at"),
        }

        if owned:
            result["process_identities"] = owned
        return result

    def watch_status(self, previous: dict) -> dict:
        identities = previous.get("process_identities", [])
        if not identities:
            return self.status()
        surviving = [(pid, created) for pid, created in identities if is_process_alive(pid, created)]
        if not surviving:
            runtime = read_client_state(self.root)
            detail = runtime.get("detail") if runtime.get("status") == "failed" else None
            return {**previous, "running": 0, "startup_status": "failed", "wecom_state": None,
                    "startup_detail": detail or "自动回复进程已退出，请查看日志。",
                    "process_identities": []}
        return self._status(surviving, previous.get("other_running", 0), previous.get("task_enabled"))

    def check(self) -> dict[str, str]:
        return updater.check_release()

    def update(self, expected_commit: str, progress: Callable[[str], None] | None = None) -> dict:
        report = progress or (lambda stage: None)
        with management_lock():
            self._require_stopped()
            report("核对已发布版本…")
            release = updater.check_release()
            if release["commit"] != expected_commit:
                raise updater.UpdateError("发布版本已变化，请重新检查更新后再安装。")
            report("正在下载更新包及校验文件…")
            commit, package, checksum = updater.fetch_release_package(release)
            self._require_stopped()
            report("校验文件、备份并安装…")
            result = updater.apply_package(package, expected_commit=commit, expected_sha256=checksum, root=self.root, require_manager=True)
            updater._log_event(self.root, f"manual update applied: commit={commit} changed={len(result['changed'])}; client not launched")
            return result

    def _require_stopped(self) -> None:
        if updater._running_autopilot():
            raise updater.UpdateError("自动回复进程正在运行，请先停止客户端。")

    def import_package(self, archive: Path) -> dict:
        archive = Path(archive)
        checksum_path = archive.with_name("windows-client.sha256")
        with archive.open("rb") as stream:
            package = stream.read(updater.MAX_ARCHIVE_BYTES + 1)
        if len(package) > updater.MAX_ARCHIVE_BYTES:
            raise updater.UpdateError("更新包超过允许大小。")
        with checksum_path.open("rb") as stream:
            checksum = updater.parse_checksum(stream.read(1025))
        if hashlib.sha256(package).hexdigest() != checksum:
            raise updater.UpdateError("Windows client release checksum mismatch")
        try:
            with zipfile.ZipFile(io.BytesIO(package)) as bundle:
                if bundle.getinfo("manifest.json").file_size > 65536:
                    raise ValueError("manifest too large")
                manifest = json.loads(bundle.read("manifest.json"))
            commit = manifest["commit"]
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
            raise updater.UpdateError("更新包版本清单无效。") from exc
        with management_lock():
            self._require_stopped()
            return updater.apply_package(package, expected_commit=commit, expected_sha256=checksum,
                                         root=self.root, require_manager=True)

    def start(self) -> int:
        with management_lock():
            return self._start_locked()

    def stop(self) -> int:
        with management_lock():
            return self._stop_locked()

    def restart(self) -> int:
        with management_lock():
            require_interactive_session()
            self._stop_locked()
            return self._start_locked()

    def _start_locked(self) -> int:
        self._require_stopped()
        require_interactive_session()
        for name in ("autopilot.py", "login_code.py", "pilot-hidden.vbs", "start-pilot.cmd", "config.json"):
            if not (self.root / name).is_file():
                raise updater.UpdateError(f"启动所需文件缺失：{name}。")
        try:
            pins = json.loads((self.root / "frozen-core-sha256.json").read_text(encoding="utf-8"))
            if not isinstance(pins, dict):
                raise ValueError("invalid core manifest")
            updater._verify_installed_core(self.root, pins)
            compile((self.root / "autopilot.py").read_bytes(), "autopilot.py", "exec")
            compile((self.root / "login_code.py").read_bytes(), "login_code.py", "exec")
        except (OSError, ValueError, SyntaxError) as exc:
            raise updater.UpdateError("本地启动文件校验失败，请先检查安装和日志。") from exc
        clear_client_state(self.root)
        updater._start_existing_client(self.root)
        for _ in range(12):
            time.sleep(1)
            state = self.status()
            startup_status = state.get("startup_status")
            if startup_status in {"waiting_wecom", "waiting_login", "initializing", "ready"} and state["running"] == 1:
                updater._log_event(self.root, f"manual client start state={startup_status}")
                return state["running"]
            if state["running"] > 1:
                raise updater.UpdateError("发现多个回复进程，请先核对并停止重复实例。")
            if startup_status == "failed":
                detail = state.get("startup_detail") or "启动后客户端未能进入可用状态。"
                raise updater.UpdateError(detail)
        raise updater.UpdateError("启动后未发现客户端进程，请查看 logs/pilot.log；不会自动重复启动。")

    def _stop_locked(self) -> int:
        rows = [row for row in system_snapshot().get("processes", []) if is_client_process(row, self.root)]
        for row in rows:
            terminate_verified_process(row, self.root)
        remaining = [row for row in system_snapshot().get("processes", []) if is_client_process(row, self.root)]
        if remaining:
            raise updater.UpdateError("仍有客户端进程运行，未确认停止，请刷新状态。")
        clear_client_state(self.root)
        updater._log_event(self.root, f"manual client stop confirmed: count={len(rows)}")
        return len(rows)

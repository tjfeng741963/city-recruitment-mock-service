"""Discover and install immutable Windows client release packages."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


REPOSITORY = "tjfeng741963/city-recruitment-mock-service"
API_BASE = f"https://api.github.com/repos/{REPOSITORY}"
ROOT = Path(__file__).resolve().parent
TAG_PREFIX = "win-client-"
LOCK_NAME = "Global\\CityRecruitClientUpdater"
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 24 * 1024 * 1024
MAX_FILES = 96
CLOUD_AGENT_MARKER = "cloud-agent-pool.json"
CLOUD_AGENT_BACKUP = "config.before-cloud-assignment.json"
DEPENDENCY_BASELINE = {
    "agent/pyproject.toml": "a41401ea6a1ad247d13b089ed60251f43baa78a7cec654ac4d7b8cd96a879268",
    "agent/uv.lock": "8e97344942c62084d9f64f39b5a4c96d2ee2cb18be58f7bcc54a104a3b32eeef",
}
CLIENT_PATHS = frozenset({
    "_verify_clipboard.py", "autopilot.py", "brain.py", "client.py", "collector.py",
    "compat.py", "echo_guard.py", "favorite_sync.py", "flow_state.py", "location_card.py", "login_qr.py", "login_refresh.py", "login_watch.py",
    "main.py", "media_fetch.py", "register.py", "remark.py", "remote_config.py", "reply_store.py",
    "screenshot.py", "sender.py", "wecomcracker.py", "client_updater.py", "client-startup.cmd",
    "client_manager.py", "client_manager_service.py", "client-manager.vbs",
})
MANAGER_FILES = frozenset({"client_manager.py", "client_manager_service.py", "client-manager.vbs"})


class UpdateError(RuntimeError):
    pass


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalized_sha256(data: bytes) -> str:
    return _sha256(data.replace(b"\r\n", b"\n").replace(b"\r", b"\n"))


def _log_event(root: Path, message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    try:
        log_dir = root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "update.log").open("a", encoding="utf-8") as stream:
            stream.write(line)
    except OSError:
        pass


def _allowed_path(name: str) -> bool:
    if not name or "\\" in name:
        return False
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        return False
    if len(path.parts) != 1:
        return False
    return name in CLIENT_PATHS


def _verify_installed_core(root: Path, protected: dict[str, str]) -> None:
    expected_names = {"win.py", "send.py", "store.py", "crypto.py"}
    if set(protected) != expected_names:
        raise UpdateError("release frozen-core manifest is invalid")
    for name, digest in protected.items():
        path = root / "wecom_io_core" / name
        if not path.is_file() or _normalized_sha256(path.read_bytes()) != str(digest).lower():
            raise UpdateError(f"installed frozen core differs from approved hash: {name}")


def _verify_zip(
    package: bytes,
    *,
    expected_commit: str,
    expected_sha256: str,
    root: Path,
    require_manager: bool = False,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    if len(package) > MAX_ARCHIVE_BYTES:
        raise UpdateError("client archive exceeds size limit")
    if _sha256(package) != expected_sha256.lower():
        raise UpdateError("client archive checksum mismatch")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit):
        raise UpdateError("expected commit SHA is invalid")
    if not (root / "login_code.py").is_file():
        raise UpdateError("required machine-local login_code.py is missing")
    try:
        compile((root / "login_code.py").read_bytes(), "login_code.py", "exec")
    except (SyntaxError, ValueError) as exc:
        raise UpdateError("machine-local login_code.py cannot compile") from exc

    try:
        from io import BytesIO

        archive = zipfile.ZipFile(BytesIO(package))
    except (OSError, zipfile.BadZipFile) as exc:
        raise UpdateError("client archive is not a valid ZIP") from exc

    with archive:
        infos = archive.infolist()
        if (
            len(infos) > MAX_FILES
            or sum(item.file_size for item in infos) > MAX_TOTAL_UNCOMPRESSED_BYTES
            or len({item.filename for item in infos}) != len(infos)
        ):
            raise UpdateError("client archive has too many or duplicate files")
        if any(item.file_size > MAX_FILE_BYTES for item in infos):
            raise UpdateError("client package file exceeds size limit")
        if "manifest.json" not in {item.filename for item in infos}:
            raise UpdateError("client archive has no manifest")
        try:
            manifest = json.loads(archive.read("manifest.json"))
        except (ValueError, KeyError, zipfile.BadZipFile) as exc:
            raise UpdateError("client manifest is invalid") from exc
        if not isinstance(manifest, dict) or manifest.get("schema") != 1 or manifest.get("commit") != expected_commit:
            raise UpdateError("client manifest commit mismatch")
        if manifest.get("dependencies") != DEPENDENCY_BASELINE:
            raise UpdateError("release client dependencies require a separately reviewed bootstrap")
        protected = manifest.get("protected_core")
        if not isinstance(protected, dict):
            raise UpdateError("client frozen-core manifest is missing")
        pin_file = root / "frozen-core-sha256.json"
        try:
            installed_pins = json.loads(pin_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise UpdateError("local approved frozen-core manifest is missing or invalid") from exc
        if not isinstance(installed_pins, dict):
            raise UpdateError("local approved frozen-core manifest is not an object")
        approved = {str(name): str(value).lower() for name, value in installed_pins.items()}
        package_pins = {str(name): str(value).lower() for name, value in protected.items()}
        if approved != package_pins:
            raise UpdateError("release frozen core manifest differs from local approved pins")
        _verify_installed_core(root, approved)

        declared = manifest.get("files")
        if not isinstance(declared, list):
            raise UpdateError("client manifest file list is invalid")
        declared_names: set[str] = set()
        payload: dict[str, bytes] = {}
        archive_names = {item.filename for item in infos} - {"manifest.json"}
        for item in declared:
            if not isinstance(item, dict):
                raise UpdateError("client manifest entry is invalid")
            name = item.get("path")
            if not isinstance(name, str) or not _allowed_path(name):
                raise UpdateError("unsafe package path")
            if name in declared_names or name not in archive_names:
                raise UpdateError("client manifest contains duplicate or missing package files")
            if name.startswith("wecom_io_core/"):
                raise UpdateError("frozen core must not be packaged")
            try:
                data = archive.read(name)
            except (KeyError, zipfile.BadZipFile, OSError) as exc:
                raise UpdateError(f"client archive member could not be read: {name}") from exc
            if len(data) != item.get("size") or _sha256(data) != str(item.get("sha256", "")).lower():
                raise UpdateError(f"client file hash mismatch: {name}")
            if name.endswith(".py"):
                try:
                    compile(data, name, "exec")
                except (SyntaxError, ValueError) as exc:
                    raise UpdateError(f"client source cannot compile: {name}") from exc
            dest = root / name
            if dest.is_symlink() or dest.resolve().parent != root.resolve():
                raise UpdateError(f"unsafe installed client path: {name}")
            declared_names.add(name)
            payload[name] = data
        if declared_names != archive_names or not payload:
            raise UpdateError("archive and manifest file lists differ")
        if "client_updater.py" not in payload or "client-startup.cmd" not in payload:
            raise UpdateError("client bootstrap files are missing from the package")
        has_manager = bool(MANAGER_FILES & payload.keys())
        if require_manager or (root / "client_manager.py").is_file() or has_manager:
            if manifest.get("manager_protocol") != 1 or not MANAGER_FILES.issubset(payload):
                raise UpdateError("client manager protocol is missing or incompatible; refusing downgrade")
        return manifest, payload


def apply_package(
    package: bytes,
    *,
    expected_commit: str,
    expected_sha256: str,
    root: Path,
    fail_after: int | None = None,
    require_manager: bool = False,
) -> dict[str, Any]:
    root = Path(root)
    manifest, payload = _verify_zip(
        package,
        expected_commit=expected_commit,
        expected_sha256=expected_sha256,
        root=root,
        require_manager=require_manager,
    )
    version_file = root / ".client-version.json"
    try:
        installed = json.loads(version_file.read_text(encoding="utf-8")) if version_file.is_file() else {}
    except (OSError, ValueError):
        installed = {}
    if not isinstance(installed, dict):
        installed = {}
    changed = sorted(name for name, data in payload.items() if not (root / name).is_file() or (root / name).read_bytes() != data)
    if installed.get("commit") == expected_commit and not changed:
        return {"commit": expected_commit, "changed": []}

    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    backup_root = root / "release-backups"
    try:
        backup_root.mkdir(parents=True, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix=f"{expected_commit}-{stamp}-", dir=backup_root))
        if version_file.is_file():
            shutil.copy2(version_file, backup / ".client-version.json")
        for name in changed:
            dest = root / name
            if dest.is_file():
                preserve = backup / name
                preserve.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dest, preserve)

        with tempfile.TemporaryDirectory(prefix=".client-update-", dir=root) as stage_name:
            stage = Path(stage_name)
            for name in changed:
                staged = stage / name
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_bytes(payload[name])
            replaced: list[str] = []
            try:
                for index, name in enumerate(changed, start=1):
                    dest = root / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(stage / name, dest)
                    replaced.append(name)
                    if fail_after == index:
                        raise OSError("simulated package replacement failure")
                version_stage = stage / ".client-version.json"
                version_stage.write_text(
                    json.dumps({"commit": expected_commit}, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                os.replace(version_stage, version_file)
            except Exception as exc:
                rollback_errors = []
                for name in reversed(replaced):
                    dest = root / name
                    preserved = backup / name
                    try:
                        if preserved.is_file():
                            restore_stage = stage / (name + ".rollback")
                            shutil.copy2(preserved, restore_stage)
                            os.replace(restore_stage, dest)
                        elif dest.exists():
                            dest.unlink()
                    except OSError:
                        rollback_errors.append(name)
                if rollback_errors:
                    raise UpdateError(f"client update failed; rollback incomplete for {rollback_errors}; restore backup {backup}") from exc
                raise UpdateError(f"client update failed; replaced files rolled back: {exc}") from exc
    except UpdateError:
        raise
    except OSError as exc:
        raise UpdateError(f"could not stage client update: {exc}") from exc
    return {"commit": expected_commit, "changed": changed, "backup": str(backup)}


def _request_json(url: str, container: type = dict) -> Any:
    try:
        result = json.loads(_download(url, 2 * 1024 * 1024, 20))
        if not isinstance(result, container):
            raise ValueError("unexpected GitHub API response type")
        return result
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise UpdateError(f"GitHub API request failed: {exc}") from exc


def release_asset_urls(commit: str, release: dict[str, Any]) -> tuple[str, str]:
    if release.get("tag_name") != f"{TAG_PREFIX}{commit}":
        raise UpdateError("GitHub release tag does not match current main commit")
    assets: dict[str, dict[str, Any]] = {}
    for asset in release.get("assets", []):
        name = str(asset.get("name", ""))
        if name in assets:
            raise UpdateError("GitHub release contains duplicate asset names")
        assets[name] = asset
    package = assets.get("windows-client.zip")
    checksum = assets.get("windows-client.sha256")
    if not package or not checksum:
        raise UpdateError("matching Windows client release is not published yet")
    if release.get("draft") or release.get("prerelease"):
        raise UpdateError("Windows client release must be published and stable")
    urls = []
    for asset in (package, checksum):
        url = str(asset.get("browser_download_url", ""))
        parsed = urlsplit(url)
        prefix = f"/{REPOSITORY}/releases/download/{TAG_PREFIX}{commit}/"
        if parsed.scheme != "https" or parsed.netloc != "github.com" or not parsed.path.startswith(prefix):
            raise UpdateError("release asset URL is outside the approved repository")
        urls.append(url)
    return urls[0], urls[1]


def _download(url: str, limit: int, timeout: int) -> bytes:
    # Windows Python deployments may lack a CA bundle. System curl uses the
    # Windows certificate store; never bypass certificate verification.
    curl = shutil.which("curl.exe") if os.name == "nt" else None
    if curl:
        with tempfile.TemporaryDirectory(prefix="client-download-") as directory:
            target = Path(directory) / "response"
            try:
                subprocess.run(
                    [curl, "--fail", "--silent", "--show-error", "--location",
                     "--proto", "=https", "--proto-redir", "=https", "--max-time", str(timeout),
                     "--max-filesize", str(limit), "--user-agent", "city-recruitment-client-updater",
                     "--output", str(target), url], check=True, capture_output=True, timeout=timeout + 5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except (OSError, subprocess.SubprocessError) as exc:
                stderr = getattr(exc, "stderr", None) or b""
                http = re.search(rb"returned error: (\d{3})", stderr)
                if http:
                    detail = f"HTTP {http[1].decode('ascii')}"
                elif isinstance(exc, subprocess.TimeoutExpired):
                    detail = "timeout"
                else:
                    detail = f"curl exit {getattr(exc, 'returncode', 'unavailable')}"
                raise UpdateError(f"HTTPS download failed ({detail})") from exc
            data = target.read_bytes()
    else:
        request = urllib.request.Request(url, headers={"User-Agent": "city-recruitment-client-updater"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = response.read(limit + 1)
        except OSError as exc:
            raise UpdateError("HTTPS download failed") from exc
    if len(data) > limit:
        raise UpdateError("download exceeds size limit")
    return data


def _http_status(exc: BaseException) -> int | None:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, urllib.error.HTTPError):
            return current.code
        stderr = getattr(current, "stderr", None)
        if isinstance(stderr, bytes):
            match = re.search(rb"returned error: (\d{3})", stderr)
            if match:
                return int(match.group(1))
        current = current.__cause__
    return None


def _release_info(commit: str, release: dict[str, Any]) -> dict[str, str]:
    package_url, checksum_url = release_asset_urls(commit, release)
    return {"commit": commit, "package_url": package_url, "checksum_url": checksum_url}


def check_release() -> dict[str, str]:
    main = _request_json(f"{API_BASE}/commits/main")
    commit = str(main.get("sha", ""))
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise UpdateError("GitHub main returned an invalid commit SHA")
    try:
        release = _request_json(f"{API_BASE}/releases/tags/{TAG_PREFIX}{commit}")
    except UpdateError as exc:
        if _http_status(exc) != 404:
            raise
    else:
        assets = {asset.get("name") for asset in release.get("assets", []) if isinstance(asset, dict)}
        if not release.get("draft") and not release.get("prerelease"):
            if {"windows-client.zip", "windows-client.sha256"} <= assets:
                return _release_info(commit, release)
    releases = _request_json(f"{API_BASE}/releases?per_page=30", list)
    for candidate in sorted((item for item in releases if isinstance(item, dict)),
                            key=lambda item: str(item.get("published_at") or ""), reverse=True):
        tag = re.fullmatch(rf"{TAG_PREFIX}([0-9a-f]{{40}})", str(candidate.get("tag_name", "")))
        if tag is None or not candidate.get("published_at") or candidate.get("draft") or candidate.get("prerelease"):
            continue
        try:
            info = _release_info(tag[1], candidate)
            return {**info, "pending_main": commit}
        except UpdateError:
            continue
    raise UpdateError("没有已发布且含完整安装包的 Windows 客户端版本。")


def parse_checksum(data: bytes) -> str:
    try:
        parts = data.decode("ascii").split()
    except UnicodeError as exc:
        raise UpdateError("Windows client release checksum file is invalid") from exc
    if len(data) > 1024 or not parts or not re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
        raise UpdateError("Windows client release checksum file is invalid")
    return parts[0].lower()


def fetch_release_package(release: dict[str, str] | None = None) -> tuple[str, bytes, str]:
    if release is None:
        release = check_release()
        if "pending_main" in release:
            raise UpdateError("最新主分支的安装包尚未发布，请在管理器中检查可用版本。")
    try:
        package = _download(release["package_url"], MAX_ARCHIVE_BYTES, 60)
        checksum_data = _download(release["checksum_url"], 1024, 15)
    except (OSError, UpdateError) as exc:
        raise UpdateError(f"Windows client release download failed: {exc}") from exc
    return release["commit"], package, parse_checksum(checksum_data)


def _running_autopilot() -> bool:
    if os.name != "nt":
        return False
    script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'python.exe','pythonw.exe' -and $_.CommandLine -like '*autopilot.py*' } | Select-Object -ExpandProperty ProcessId"
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise UpdateError("could not verify whether autopilot is running")
    return bool(result.stdout.strip())


def _acquire_mutex() -> Any:
    if os.name != "nt":
        return None
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.GetLastError.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.CreateMutexW(None, True, LOCK_NAME)
    kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
    if not handle:
        raise UpdateError("could not acquire client updater mutex")
    if kernel32.GetLastError() == 183:
        kernel32.CloseHandle(handle)
        raise UpdateError("another client updater is already running")
    return handle


def _start_existing_client(root: Path) -> None:
    launcher = root / "pilot-hidden.vbs"
    if not launcher.is_file():
        raise UpdateError("existing pilot-hidden.vbs is missing")
    subprocess.Popen(
        ["wscript.exe", str(launcher)],
        cwd=root,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )


def _release_mutex(handle: Any) -> None:
    if handle:
        ctypes.windll.kernel32.ReleaseMutex(handle)
        ctypes.windll.kernel32.CloseHandle(handle)


def cloud_agent_config(root: Path) -> tuple[str, str] | None:
    marker = root / CLOUD_AGENT_MARKER
    if not marker.is_file():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8-sig"))
        code = data["machine_code"]
        origin = data["origin"]
        parsed = urlsplit(origin)
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", code) or parsed.scheme != "https"
                or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment or origin != origin.strip()):
            raise ValueError("invalid pool configuration")
        return code, origin.rstrip("/")
    except (KeyError, OSError, TypeError, ValueError) as exc:
        raise UpdateError("云电脑待分配配置无效，需要有效的 HTTPS 地址和机器编号。") from exc


def _read_cloud_client_config(root: Path) -> dict:
    try:
        data = json.loads((root / "config.json").read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            raise ValueError("expected an object")
        return data
    except (OSError, ValueError) as exc:
        raise UpdateError("云电脑客户端配置无法读取。") from exc


def _valid_cloud_assignment_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f-]{36}", value) is not None


def _require_fresh_cloud_machine(root: Path, manager) -> None:
    status = manager.status()
    if status["running"] or status["other_running"]:
        raise UpdateError("这台云电脑有正在运行的客户端，请先核对。")
    profile = os.environ.get("USERPROFILE")
    if ((root / "reply_log.db").exists() or (root / "_decrypted" / "message.db").exists()
            or profile and next((Path(profile) / "Documents" / "WXWork").glob("*/Data/message.db"), None)):
        raise UpdateError("这台云电脑已有企微或回复数据，请核对后再登记为空闲机器。")


def apply_cloud_agent_assignment(root: Path, manager, pool: tuple[str, str], assignment: object) -> bool:
    machine, origin = pool
    if not isinstance(assignment, dict):
        raise UpdateError("云电脑分配响应格式无效。")
    code, token, assignment_id = (assignment.get(key) for key in ("device_code", "bridge_token", "id"))
    if (not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", code)
            or code == machine or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token)
            or not _valid_cloud_assignment_id(assignment_id)):
        raise UpdateError("云电脑分配响应格式无效。")
    mutex = _acquire_mutex()
    try:
        if (root / "logs" / "manual-stop").exists():
            return False
        current = _read_cloud_client_config(root)
        if current.get("device_code") == machine:
            _require_fresh_cloud_machine(root, manager)
            backup = root / CLOUD_AGENT_BACKUP
            payload = {"device_code": code, "bridge_server": origin, "bridge_token": token, "dry_run": True,
                       "brain": {"mode": "agent"}, "cloud_assignment_id": assignment_id}
            with tempfile.TemporaryDirectory(prefix=".cloud-assignment-", dir=root) as stage:
                if not backup.exists():
                    staged_backup = Path(stage) / backup.name
                    shutil.copy2(root / "config.json", staged_backup)
                    os.replace(staged_backup, backup)
                file = Path(stage) / "config.json"
                file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
                os.replace(file, root / "config.json")
        elif current.get("device_code") != code or current.get("cloud_assignment_id") != assignment_id:
            raise UpdateError("这台云电脑已经有接待账号。")
    finally:
        _release_mutex(mutex)
    return _start_assigned_cloud_client(manager)


def _start_assigned_cloud_client(manager) -> bool:
    status = manager.status()
    if status["other_running"] or status["running"] > 1:
        raise UpdateError("这台云电脑有其他正在运行的客户端。")
    return bool(status["running"]) or manager.start_on_logon()


class _NoCloudRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def wait_for_cloud_agent(root: Path, manager) -> bool:
    from client_manager_service import require_interactive_session

    pool = cloud_agent_config(root)
    if pool is None:
        raise UpdateError("缺少云电脑待分配配置。")
    machine, origin = pool
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoCloudRedirect())
    last_error = ""
    while not (root / "logs" / "manual-stop").exists():
        try:
            require_interactive_session()
            current = _read_cloud_client_config(root)
            if current.get("device_code") != machine:
                if not _valid_cloud_assignment_id(current.get("cloud_assignment_id")):
                    raise UpdateError("这台云电脑已经有接待账号。")
                return _start_assigned_cloud_client(manager)
            _require_fresh_cloud_machine(root, manager)
            token = current.get("bridge_token")
            if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token):
                raise UpdateError("云电脑凭据无效。")
            url = f"{origin}/api/v1/bridge/devices/{machine}/cloud-assignment"
            request = urllib.request.Request(url, method="POST", headers={"Authorization": f"Bearer {token}"})
            with opener.open(request, timeout=8) as response:
                result = json.loads(response.read(16384))
            if isinstance(result, dict) and result.get("assignment") is not None:
                return apply_cloud_agent_assignment(root, manager, pool, result["assignment"])
            last_error = ""
        except urllib.error.HTTPError as exc:
            error = f"cloud agent pairing HTTP {exc.code}"
            if error != last_error:
                _log_event(root, error)
                last_error = error
        except (UpdateError, ValueError, OSError, subprocess.SubprocessError) as exc:
            error = f"cloud agent pairing waiting: {type(exc).__name__}"
            if error != last_error:
                _log_event(root, error)
                last_error = error
        time.sleep(15)
    return False


def main() -> int:
    from client_manager_service import ManagerService

    try:
        _log_event(ROOT, "starting the installed client")
        manager = ManagerService(ROOT)
        supervise = "--supervise" in sys.argv[1:]
        if "--cloud-agent" in sys.argv[1:] or (supervise and (ROOT / CLOUD_AGENT_MARKER).is_file()):
            if wait_for_cloud_agent(ROOT, manager) and supervise:
                manager.supervise()
        elif supervise:
            if manager.start_on_logon():
                manager.supervise()
        else:
            manager.start()
        return 0
    except (UpdateError, OSError, subprocess.SubprocessError) as exc:
        _log_event(ROOT, f"installed client start failed: {exc}")
        print(f"installed client start failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # The manager imports this module for its local startup checks.
    sys.modules["client_updater"] = sys.modules[__name__]
    raise SystemExit(main())

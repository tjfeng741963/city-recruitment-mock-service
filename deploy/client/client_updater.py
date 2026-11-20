"""Install the immutable Windows client package matching the current main SHA."""

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
DEPENDENCY_BASELINE = {
    "agent/pyproject.toml": "a41401ea6a1ad247d13b089ed60251f43baa78a7cec654ac4d7b8cd96a879268",
    "agent/uv.lock": "8e97344942c62084d9f64f39b5a4c96d2ee2cb18be58f7bcc54a104a3b32eeef",
}
CLIENT_PATHS = frozenset({
    "_verify_clipboard.py", "autopilot.py", "brain.py", "client.py", "collector.py",
    "compat.py", "echo_guard.py", "flow_state.py", "login_qr.py", "login_refresh.py", "login_watch.py",
    "main.py", "media_fetch.py", "register.py", "remote_config.py", "reply_store.py",
    "screenshot.py", "sender.py", "wecomcracker.py", "client_updater.py", "client-startup.cmd",
})


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
        return manifest, payload


def apply_package(
    package: bytes,
    *,
    expected_commit: str,
    expected_sha256: str,
    root: Path,
    fail_after: int | None = None,
) -> dict[str, Any]:
    root = Path(root)
    manifest, payload = _verify_zip(
        package,
        expected_commit=expected_commit,
        expected_sha256=expected_sha256,
        root=root,
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


def _request_json(url: str) -> dict[str, Any]:
    try:
        result = json.loads(_download(url, 2 * 1024 * 1024, 20))
        if not isinstance(result, dict):
            raise ValueError("API response is not an object")
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
                )
            except (OSError, subprocess.SubprocessError) as exc:
                raise UpdateError("HTTPS download failed") from exc
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


def fetch_release_package() -> tuple[str, bytes, str]:
    main = _request_json(f"{API_BASE}/commits/main")
    commit = str(main.get("sha", ""))
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise UpdateError("GitHub main returned an invalid commit SHA")
    release = _request_json(f"{API_BASE}/releases/tags/{TAG_PREFIX}{commit}")
    package_url, checksum_url = release_asset_urls(commit, release)
    try:
        package = _download(package_url, MAX_ARCHIVE_BYTES, 60)
        checksum_text = _download(checksum_url, 1024, 15).decode("ascii").strip()
    except (OSError, UnicodeError, urllib.error.URLError) as exc:
        raise UpdateError(f"Windows client release download failed: {exc}") from exc
    checksum = checksum_text.split()[0] if checksum_text else ""
    if not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
        raise UpdateError("Windows client release checksum file is invalid")
    return commit, package, checksum.lower()


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


def main() -> int:
    handle = None
    commit = "unknown"
    try:
        _log_event(ROOT, "startup update check")
        handle = _acquire_mutex()
        if _running_autopilot():
            raise UpdateError("autopilot is already running; refusing to update live client files")
        commit, package, checksum = fetch_release_package()
        if _running_autopilot():
            raise UpdateError("autopilot started while downloading; refusing file replacement")
        result = apply_package(package, expected_commit=commit, expected_sha256=checksum, root=ROOT)
        summary = f"commit={commit} changed={len(result['changed'])}"
        _log_event(ROOT, f"update applied: {summary}")
        print(f"client update: {summary}")
        if _running_autopilot():
            raise UpdateError("autopilot started while downloading; refusing duplicate launch")
        _start_existing_client(ROOT)
        _log_event(ROOT, f"client launcher started: commit={commit}")
        return 0
    except (UpdateError, OSError, subprocess.SubprocessError) as exc:
        _log_event(ROOT, f"update stopped: commit={commit} reason={exc}")
        print(f"client update stopped: {exc}", file=sys.stderr)
        return 1
    finally:
        if handle:
            ctypes.windll.kernel32.ReleaseMutex(handle)
            ctypes.windll.kernel32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())

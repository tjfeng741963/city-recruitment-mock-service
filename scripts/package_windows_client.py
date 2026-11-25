"""Build a reproducible Windows client ZIP from an exact Git commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PIN_PATH = "deploy/client/frozen-core-sha256.json"
FROZEN_CORE = (
    "agent/wecom_io_core/win.py",
    "agent/wecom_io_core/send.py",
    "agent/wecom_io_core/store.py",
    "agent/wecom_io_core/crypto.py",
)
APPROVED_CORE_HASHES = {
    "win.py": "d80bcd8fd59ec9803173828bf119e302beb8b2af15a9689011b5c09f4ffd0127",
    "send.py": "03c2f2cc63bd4005e1f78a35e580cd6da95d3c06637cdeb497ec675ea8935fff",
    "store.py": "4c5ae0a2cfce0214289aa7ef18a30e961c3f47af81a50af62de2bc5e92476e62",
    "crypto.py": "0622c4452812711dc59b36fefa6a5beaaba512591e047f88d8b87b5dbb5db8e3",
}
DEPENDENCY_FILES = ("agent/pyproject.toml", "agent/uv.lock")
APPROVED_DEPENDENCIES = {
    "agent/pyproject.toml": "a41401ea6a1ad247d13b089ed60251f43baa78a7cec654ac4d7b8cd96a879268",
    "agent/uv.lock": "8e97344942c62084d9f64f39b5a4c96d2ee2cb18be58f7bcc54a104a3b32eeef",
}
CLIENT_FILES = frozenset({
    "_verify_clipboard.py", "autopilot.py", "brain.py", "client.py", "collector.py",
    "compat.py", "echo_guard.py", "favorite_sync.py", "flow_state.py", "location_card.py", "login_qr.py", "login_refresh.py", "login_watch.py",
    "main.py", "media_fetch.py", "register.py", "remark.py", "remote_config.py", "reply_store.py",
    "screenshot.py", "sender.py", "wecomcracker.py",
})
BOOTSTRAP_FILES = {
    "deploy/client/client_updater.py": "client_updater.py",
    "deploy/client/client-startup.cmd": "client-startup.cmd",
    "deploy/client/client_manager.py": "client_manager.py",
    "deploy/client/client_manager_service.py": "client_manager_service.py",
    "deploy/client/client-manager.vbs": "client-manager.vbs",
}


class PackageError(RuntimeError):
    pass


def _git(repo: Path, *args: str) -> bytes:
    try:
        return subprocess.check_output(["git", *args], cwd=repo, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        raise PackageError(f"git {' '.join(args)} failed: {detail}") from exc


def _blob(repo: Path, commit: str, path: str) -> bytes | None:
    result = subprocess.run(
        ["git", "show", f"{commit}:{path}"],
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout if result.returncode == 0 else None


def _normalized_hash(content: bytes) -> str:
    return hashlib.sha256(content.replace(b"\r\n", b"\n").replace(b"\r", b"\n")).hexdigest()


def _tracked_client_files(repo: Path, commit: str) -> list[str]:
    tree = _git(repo, "ls-tree", "-r", "--name-only", "-z", commit)
    names = [name.decode("utf-8") for name in tree.split(b"\0") if name]
    top_level = {name.removeprefix("agent/") for name in names if name.startswith("agent/") and name.count("/") == 1 and name.endswith(".py")}
    unclassified = top_level - CLIENT_FILES - {"login_code.py"}
    if unclassified:
        raise PackageError(f"client modules missing from explicit package allowlist: {sorted(unclassified)}")
    return sorted(
        name
        for name in names
        if name.startswith("agent/")
        and name.endswith(".py")
        and "/wecom_io_core/" not in name
        and name.removeprefix("agent/") in CLIENT_FILES
    )


def _assert_dependency_unchanged(repo: Path, commit: str, base: str) -> None:
    for path in DEPENDENCY_FILES:
        if _blob(repo, commit, path) != _blob(repo, base, path):
            raise PackageError(f"client dependencies changed: {path}")
        content = _blob(repo, commit, path)
        if content is None or _normalized_hash(content) != APPROVED_DEPENDENCIES[path]:
            raise PackageError(f"client dependencies changed from supported baseline: {path}")


def _assert_frozen_core(repo: Path, commit: str, pinned: dict[str, str]) -> None:
    for path in FROZEN_CORE:
        content = _blob(repo, commit, path)
        expected = pinned[Path(path).name].lower()
        if content is None or _normalized_hash(content) != expected:
            raise PackageError(f"frozen core hash mismatch: {path}")


def _zip_info(path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, date_time=(2020, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    return info


def build_package(repo: Path, *, commit: str, base: str, output: Path) -> dict:
    commit = _git(repo, "rev-parse", f"{commit}^{{commit}}").decode().strip()
    base = _git(repo, "rev-parse", f"{base}^{{commit}}").decode().strip()
    pin_bytes = _blob(repo, commit, PIN_PATH)
    if pin_bytes is None:
        raise PackageError(f"frozen core manifest is missing: {PIN_PATH}")
    pinned = json.loads(pin_bytes.decode("utf-8"))
    if {name: str(value).lower() for name, value in pinned.items()} != APPROVED_CORE_HASHES:
        raise PackageError("frozen core baseline differs from the reviewed hashes")
    _assert_dependency_unchanged(repo, commit, base)
    _assert_frozen_core(repo, commit, pinned)

    files = []
    package_files = [(source, source.removeprefix("agent/")) for source in _tracked_client_files(repo, commit)]
    package_files.extend(BOOTSTRAP_FILES.items())
    for source, target in sorted(package_files):
        content = _blob(repo, commit, source)
        if content is None:
            raise PackageError(f"tracked client file is missing at commit: {source}")
        if target.endswith(".py"):
            try:
                compile(content, target, "exec")
            except (SyntaxError, ValueError) as exc:
                raise PackageError(f"client source cannot compile: {source}") from exc
        files.append(
            {
                "source": source,
                "path": target,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "content": content,
            }
        )

    protected_core = {
        Path(path).name: _normalized_hash(_blob(repo, commit, path))
        for path in FROZEN_CORE
    }
    manifest = {
        "schema": 1,
        "manager_protocol": 1,
        "commit": commit,
        "protected_core": protected_core,
        "dependencies": APPROVED_DEPENDENCIES,
        "files": [
            {key: item[key] for key in ("path", "size", "sha256")}
            for item in files
        ],
    }
    manifest_bytes = json.dumps(
        manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8") + b"\n"

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w") as archive:
        for item in files:
            archive.writestr(_zip_info(item["path"]), item["content"])
        archive.writestr(_zip_info("manifest.json"), manifest_bytes)

    return {
        "commit": commit,
        "base": base,
        "archive": str(output),
        "archive_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "manifest": manifest,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = build_package(args.repo, commit=args.commit, base=args.base, output=args.output)
    print(json.dumps({key: value for key, value in result.items() if key != "manifest"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

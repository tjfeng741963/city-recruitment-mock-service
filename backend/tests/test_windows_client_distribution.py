from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_SCRIPT = REPO_ROOT / "scripts" / "package_windows_client.py"
PACKAGE_SPEC = importlib.util.spec_from_file_location("package_windows_client", PACKAGE_SCRIPT)
PACKAGE_MODULE = importlib.util.module_from_spec(PACKAGE_SPEC)
sys.modules[PACKAGE_SPEC.name] = PACKAGE_MODULE
PACKAGE_SPEC.loader.exec_module(PACKAGE_MODULE)
PackageError = PACKAGE_MODULE.PackageError
build_package = PACKAGE_MODULE.build_package

CORE_FILES = (
    "agent/wecom_io_core/win.py",
    "agent/wecom_io_core/send.py",
    "agent/wecom_io_core/store.py",
    "agent/wecom_io_core/crypto.py",
)


def run_git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def write_file(repo: Path, name: str, data: bytes) -> None:
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def make_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    run_git(repo, "init", "-q")
    run_git(repo, "config", "core.autocrlf", "false")
    run_git(repo, "config", "user.email", "test@example.invalid")
    run_git(repo, "config", "user.name", "Package Test")
    for name in CORE_FILES:
        write_file(repo, name, (REPO_ROOT / name).read_bytes())
    write_file(
        repo,
        "deploy/client/frozen-core-sha256.json",
        (REPO_ROOT / "deploy/client/frozen-core-sha256.json").read_bytes(),
    )
    write_file(repo, "agent/autopilot.py", b"BASE_AUTOPILOT = True\n")
    write_file(repo, "agent/brain.py", b"BASE_BRAIN = True\n")
    write_file(repo, "agent/wecom_io_core/identity.py", b"IDENTITY = 'base'\n")
    write_file(repo, "agent/wecom_io_core/vendor/key_extract.py", b"SECRET_HELPER = True\n")
    write_file(repo, "agent/pyproject.toml", subprocess.check_output(['git', 'show', 'HEAD:agent/pyproject.toml'], cwd=REPO_ROOT))
    write_file(repo, "agent/uv.lock", subprocess.check_output(['git', 'show', 'HEAD:agent/uv.lock'], cwd=REPO_ROOT))
    write_file(repo, "deploy/client/client_updater.py", b"UPDATER = 1\n")
    write_file(repo, "deploy/client/client-startup.cmd", b"@echo off\r\n")
    write_file(repo, "deploy/client/client_manager.py", b"MANAGER = 1\n")
    write_file(repo, "deploy/client/client_manager_service.py", b"SERVICE = 1\n")
    write_file(repo, "deploy/client/client-manager.vbs", b"Option Explicit\n")
    write_file(repo, "agent/config.json", b"{\"token\":\"never-package\"}\n")
    run_git(repo, "add", "agent", "deploy/client")
    run_git(repo, "commit", "-qm", "base")
    base = run_git(repo, "rev-parse", "HEAD")
    return repo, base


def commit_change(repo: Path, name: str, content: bytes) -> str:
    write_file(repo, name, content)
    run_git(repo, "add", name)
    run_git(repo, "commit", "-qm", "change")
    return run_git(repo, "rev-parse", "HEAD")


def test_package_uses_exact_commit_allowlist_and_pins_frozen_core(tmp_path):
    repo, base = make_repo(tmp_path)
    target = commit_change(repo, "agent/autopilot.py", b"TARGET_AUTOPILOT = True\n")
    output = tmp_path / "client.zip"

    result = build_package(repo, commit=target, base=base, output=output)

    assert result["commit"] == target
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        assert archive.read("autopilot.py") == b"TARGET_AUTOPILOT = True\n"
        assert "brain.py" in names
        assert "client_updater.py" in names
        assert "client-startup.cmd" in names
        assert "client_manager.py" in names
        assert "client_manager_service.py" in names
        assert "client-manager.vbs" in names
        assert "identity.py" not in names
        assert "vendor/key_extract.py" not in names
        assert "config.json" not in names
        assert "login_code.py" not in names
        assert "wecom_io_core/send.py" not in names
        assert manifest["commit"] == target
        assert manifest["manager_protocol"] == 1
        assert manifest["protected_core"] == {
            Path(name).name: hashlib.sha256(
                (repo / name).read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            ).hexdigest()
            for name in CORE_FILES
        }


def test_package_rejects_modified_frozen_core(tmp_path):
    repo, base = make_repo(tmp_path)
    target = commit_change(repo, "agent/wecom_io_core/send.py", b"changed sender\n")

    with pytest.raises(PackageError, match="frozen core"):
        build_package(repo, commit=target, base=base, output=tmp_path / "client.zip")


def test_package_rejects_a_changed_frozen_core_pin_file(tmp_path):
    repo, base = make_repo(tmp_path)
    write_file(
        repo,
        "deploy/client/frozen-core-sha256.json",
        b'{"win.py":"0000000000000000000000000000000000000000000000000000000000000000"}\n',
    )
    run_git(repo, "add", "deploy/client/frozen-core-sha256.json")
    run_git(repo, "commit", "-qm", "change pin")
    target = run_git(repo, "rev-parse", "HEAD")

    with pytest.raises(PackageError, match="baseline differs"):
        build_package(repo, commit=target, base=base, output=tmp_path / "client.zip")


def test_package_pin_file_must_match_approved_baseline(tmp_path):
    repo, base = make_repo(tmp_path)
    pins = json.loads((repo / "deploy/client/frozen-core-sha256.json").read_text())
    pins["send.py"] = "0" * 64
    write_file(repo, "deploy/client/frozen-core-sha256.json", json.dumps(pins).encode() + b"\n")
    run_git(repo, "add", "deploy/client/frozen-core-sha256.json")
    run_git(repo, "commit", "-qm", "tamper approved pin")
    target = run_git(repo, "rev-parse", "HEAD")

    with pytest.raises(PackageError, match="baseline differs"):
        build_package(repo, commit=target, base=base, output=tmp_path / "client.zip")


@pytest.mark.parametrize("dependency", ["agent/pyproject.toml", "agent/uv.lock"])
def test_package_rejects_client_dependency_changes_before_deploy(tmp_path, dependency):
    repo, base = make_repo(tmp_path)
    target = commit_change(repo, dependency, b"changed dependency manifest\n")

    with pytest.raises(PackageError, match="dependencies changed"):
        build_package(repo, commit=target, base=base, output=tmp_path / "client.zip")


def test_package_is_deterministic_for_a_commit(tmp_path):
    repo, base = make_repo(tmp_path)
    target = commit_change(repo, "agent/brain.py", b"TARGET_BRAIN = True\n")
    first, second = tmp_path / "first.zip", tmp_path / "second.zip"

    build_package(repo, commit=target, base=base, output=first)
    build_package(repo, commit=target, base=base, output=second)

    assert first.read_bytes() == second.read_bytes()


def test_package_bytes_do_not_depend_on_comparison_base(tmp_path):
    repo, original = make_repo(tmp_path)
    previous = commit_change(repo, "agent/collector.py", b"INTERMEDIATE = True\n")
    target = commit_change(repo, "agent/brain.py", b"TARGET_BRAIN = True\n")
    first, second = tmp_path / "base-original.zip", tmp_path / "base-previous.zip"

    build_package(repo, commit=target, base=original, output=first)
    build_package(repo, commit=target, base=previous, output=second)

    assert first.read_bytes() == second.read_bytes()


def test_package_includes_flow_state_required_by_autopilot(tmp_path):
    repo, base = make_repo(tmp_path)
    target = commit_change(repo, "agent/flow_state.py", b"FLOW_STATE = True\n")
    output = tmp_path / "client.zip"
    build_package(repo, commit=target, base=base, output=output)
    with zipfile.ZipFile(output) as archive:
        assert archive.read("flow_state.py") == b"FLOW_STATE = True\n"


def test_package_rejects_unclassified_new_client_modules(tmp_path):
    repo, base = make_repo(tmp_path)
    target = commit_change(repo, "agent/new_required_module.py", b"REQUIRED = True\n")
    with pytest.raises(PackageError, match="missing from explicit package allowlist"):
        build_package(repo, commit=target, base=base, output=tmp_path / "client.zip")

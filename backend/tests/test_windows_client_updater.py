from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
UPDATER_PATH = REPO_ROOT / "deploy" / "client" / "client_updater.py"
SPEC = importlib.util.spec_from_file_location("client_updater", UPDATER_PATH)
UPDATER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = UPDATER
SPEC.loader.exec_module(UPDATER)

CORE_FILES = (
    "win.py",
    "send.py",
    "store.py",
    "crypto.py",
)
COMMIT = "a" * 40


def core_hashes() -> dict[str, str]:
    raw = json.loads((REPO_ROOT / "deploy/client/frozen-core-sha256.json").read_text())
    return {name: value.lower() for name, value in raw.items()}


def archive_bytes(files: dict[str, bytes], *, commit: str = COMMIT, manager_protocol=None) -> bytes:
    files = {
        "client_updater.py": b"# verified updater\n",
        "client-startup.cmd": b"@echo off\r\n",
        **files,
    }
    manifest = {
        "schema": 1,
        "dependencies": UPDATER.DEPENDENCY_BASELINE,
        "commit": commit,
        "protected_core": core_hashes(),
        "files": [
            {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(files.items())
        ],
    }
    if manager_protocol is not None:
        manifest["manager_protocol"] = manager_protocol
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("manifest.json", json.dumps(manifest, sort_keys=True))
    return output.getvalue()


def installed_root(tmp_path: Path) -> Path:
    root = tmp_path / "client"
    root.mkdir()
    for name in CORE_FILES:
        source = REPO_ROOT / "agent" / "wecom_io_core" / name
        target = root / "wecom_io_core" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    pins = {
        name: hashlib.sha256(
            (REPO_ROOT / "agent/wecom_io_core" / name)
            .read_bytes()
            .replace(b"\r\n", b"\n")
            .replace(b"\r", b"\n")
        ).hexdigest()
        for name in CORE_FILES
    }
    (root / "frozen-core-sha256.json").write_text(json.dumps(pins), encoding="utf-8")
    (root / "login_code.py").write_bytes(b"# machine-local module\n")
    (root / "config.json").write_bytes(b'{"local":"config"}')
    (root / "reply_log.db").write_bytes(b"local reply ledger")
    (root / "extra_local.py").write_bytes(b"local diagnostic helper")
    (root / "logs").mkdir()
    (root / "logs/run.log").write_bytes(b"local log")
    (root / "media").mkdir()
    (root / "media/asset.jpg").write_bytes(b"local media")
    return root


def test_release_assets_must_match_exact_main_commit():
    release = {
        "tag_name": f"{UPDATER.TAG_PREFIX}{COMMIT}",
        "assets": [
            {"name": "windows-client.zip", "browser_download_url": "https://github.com/tjfeng741963/city-recruitment-mock-service/releases/download/win-client-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/package"},
            {"name": "windows-client.sha256", "browser_download_url": "https://github.com/tjfeng741963/city-recruitment-mock-service/releases/download/win-client-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/checksum"},
        ],
    }

    assert UPDATER.release_asset_urls(COMMIT, release) == (
        "https://github.com/tjfeng741963/city-recruitment-mock-service/releases/download/win-client-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/package",
        "https://github.com/tjfeng741963/city-recruitment-mock-service/releases/download/win-client-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/checksum",
    )
    with pytest.raises(UPDATER.UpdateError, match="tag does not match"):
        UPDATER.release_asset_urls("b" * 40, release)


def test_release_assets_reject_duplicate_asset_names():
    release = {
        "tag_name": f"{UPDATER.TAG_PREFIX}{COMMIT}",
        "assets": [
            {"name": "windows-client.zip", "browser_download_url": "https://github.com/tjfeng741963/city-recruitment-mock-service/releases/download/win-client-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/package"},
            {"name": "windows-client.zip", "browser_download_url": "https://example.invalid/other"},
        ],
    }

    with pytest.raises(UPDATER.UpdateError, match="duplicate asset"):
        UPDATER.release_asset_urls(COMMIT, release)


def test_main_starts_existing_client_only_after_successful_update(monkeypatch):
    events = []
    monkeypatch.setattr(UPDATER, "ROOT", Path("/tmp/client"))
    monkeypatch.setattr(UPDATER, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(UPDATER, "_log_event", lambda *a: None)
    monkeypatch.setattr(UPDATER, "_running_autopilot", lambda: False)
    monkeypatch.setattr(UPDATER, "fetch_release_package", lambda: (COMMIT, b"package", "a" * 64))
    monkeypatch.setattr(
        UPDATER,
        "apply_package",
        lambda *args, **kwargs: events.append("apply") or {"commit": COMMIT, "changed": ["autopilot.py"]},
    )
    monkeypatch.setattr(UPDATER, "_start_existing_client", lambda root: events.append(("start", root)))
    monkeypatch.setattr(UPDATER.sys, "stdout", None)

    assert UPDATER.main() == 0
    assert events == ["apply", ("start", Path("/tmp/client"))]


def test_main_fails_closed_without_starting_client_when_update_fails(monkeypatch):
    events = []
    monkeypatch.setattr(UPDATER, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(UPDATER, "_log_event", lambda *a: None)
    monkeypatch.setattr(UPDATER, "_running_autopilot", lambda: False)
    monkeypatch.setattr(
        UPDATER,
        "fetch_release_package",
        lambda: (_ for _ in ()).throw(UPDATER.UpdateError("release unavailable")),
    )
    monkeypatch.setattr(UPDATER, "_start_existing_client", lambda root: events.append("start"))
    monkeypatch.setattr(UPDATER.sys, "stderr", None)

    assert UPDATER.main() == 1
    assert events == []


def test_main_refuses_update_when_autopilot_is_running(monkeypatch):
    events = []
    monkeypatch.setattr(UPDATER, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(UPDATER, "_log_event", lambda *a: None)
    monkeypatch.setattr(UPDATER, "_running_autopilot", lambda: True)
    monkeypatch.setattr(UPDATER, "fetch_release_package", lambda: events.append("network"))
    monkeypatch.setattr(UPDATER, "_start_existing_client", lambda root: events.append("start"))
    monkeypatch.setattr(UPDATER.sys, "stderr", None)

    assert UPDATER.main() == 1
    assert events == []


def test_main_rechecks_live_sender_after_download(monkeypatch):
    states = iter([False, True])
    events = []
    monkeypatch.setattr(UPDATER, "_acquire_mutex", lambda: None)
    monkeypatch.setattr(UPDATER, "_log_event", lambda *a: None)
    monkeypatch.setattr(UPDATER, "_running_autopilot", lambda: next(states))
    monkeypatch.setattr(UPDATER, "fetch_release_package", lambda: (COMMIT, b"package", "a" * 64))
    monkeypatch.setattr(UPDATER, "apply_package", lambda *a, **kw: events.append("apply"))
    monkeypatch.setattr(UPDATER, "_start_existing_client", lambda root: events.append("start"))
    assert UPDATER.main() == 1
    assert events == []


def test_applies_verified_package_and_preserves_all_local_runtime_data(tmp_path):
    root = installed_root(tmp_path)
    runtime = {
        name: (root / name).read_bytes()
        for name in (
            "login_code.py", "config.json", "reply_log.db", "extra_local.py",
            "logs/run.log", "media/asset.jpg",
        )
    }
    package = archive_bytes({"autopilot.py": b"# new autopilot\n", "client_updater.py": b"# new updater\n"})
    checksum = hashlib.sha256(package).hexdigest()

    result = UPDATER.apply_package(package, expected_commit=COMMIT, expected_sha256=checksum, root=root)

    assert result["commit"] == COMMIT
    assert result["changed"] == ["autopilot.py", "client-startup.cmd", "client_updater.py"]
    assert Path(result["backup"]).is_dir()
    assert (root / "autopilot.py").read_bytes() == b"# new autopilot\n"
    assert (root / "client_updater.py").read_bytes() == b"# new updater\n"
    assert {name: (root / name).read_bytes() for name in runtime} == runtime
    assert json.loads((root / ".client-version.json").read_text()) == {"commit": COMMIT}


def test_rejects_installed_frozen_core_drift(tmp_path):
    root = installed_root(tmp_path)
    (root / "wecom_io_core/send.py").write_bytes(b"modified sender")
    package = archive_bytes({"autopilot.py": b"# new autopilot\n"})

    with pytest.raises(UPDATER.UpdateError, match="installed frozen core differs"):
        UPDATER.apply_package(
            package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root
        )

    assert not (root / "autopilot.py").exists()


def test_same_commit_is_noop(tmp_path):
    root = installed_root(tmp_path)
    (root / ".client-version.json").write_text(json.dumps({"commit": COMMIT}))
    package = archive_bytes({"autopilot.py": b"# new autopilot\n"})
    with zipfile.ZipFile(BytesIO(package)) as archive:
        for name in archive.namelist():
            if name != "manifest.json":
                (root / name).write_bytes(archive.read(name))

    result = UPDATER.apply_package(
        package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root
    )

    assert result == {"commit": COMMIT, "changed": []}
    assert (root / "autopilot.py").read_bytes() == b"# new autopilot\n"


def test_same_commit_repairs_manually_changed_sources(tmp_path):
    root = installed_root(tmp_path)
    (root / ".client-version.json").write_text(json.dumps({"commit": COMMIT}))
    (root / "autopilot.py").write_bytes(b"# manual drift\n")
    package = archive_bytes({"autopilot.py": b"# verified source\n"})

    result = UPDATER.apply_package(
        package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root
    )

    assert "autopilot.py" in result["changed"]
    assert (root / "autopilot.py").read_bytes() == b"# verified source\n"


@pytest.mark.parametrize(
    ("files", "expected_error"),
    [
        ({"../config.json": b"overwrite"}, "unsafe package path"),
        ({"wecom_io_core/send.py": b"changed"}, "unsafe package path"),
        ({"config.json": b"overwrite"}, "unsafe package path"),
    ],
)
def test_rejects_unsafe_package_paths(tmp_path, files, expected_error):
    root = installed_root(tmp_path)
    package = archive_bytes(files)

    with pytest.raises(UPDATER.UpdateError, match=expected_error):
        UPDATER.apply_package(
            package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root
        )


def test_rejects_missing_machine_local_login_code_before_writing(tmp_path):
    root = installed_root(tmp_path)
    (root / "login_code.py").unlink()
    package = archive_bytes({"autopilot.py": b"# new autopilot\n"})

    with pytest.raises(UPDATER.UpdateError, match="login_code.py is missing"):
        UPDATER.apply_package(
            package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root
        )

    assert not (root / "autopilot.py").exists()


@pytest.mark.parametrize(
    ("expected_commit", "expected_sha256", "mutate"),
    [
        ("b" * 40, None, False),
        (COMMIT, "0" * 64, False),
        (COMMIT, None, True),
    ],
)
def test_rejects_commit_checksum_or_manifest_mismatch(tmp_path, expected_commit, expected_sha256, mutate):
    root = installed_root(tmp_path)
    package = archive_bytes({"autopilot.py": b"# new autopilot\n"})
    if mutate:
        changed = bytearray(package)
        changed[-8] ^= 1
        package = bytes(changed)
    checksum = expected_sha256 or hashlib.sha256(package).hexdigest()

    with pytest.raises(UPDATER.UpdateError):
        UPDATER.apply_package(package, expected_commit=expected_commit, expected_sha256=checksum, root=root)

    assert not (root / "autopilot.py").exists()


def test_rejects_manifest_frozen_pin_change_even_when_archive_hash_is_valid(tmp_path):
    root = installed_root(tmp_path)
    package = archive_bytes({"autopilot.py": b"# new autopilot\n"})
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(package)) as source, zipfile.ZipFile(output, "w") as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "manifest.json":
                manifest = json.loads(data)
                manifest["protected_core"]["send.py"] = "0" * 64
                data = json.dumps(manifest, sort_keys=True).encode()
            target.writestr(item.filename, data)
    tampered = output.getvalue()

    with pytest.raises(UPDATER.UpdateError, match="frozen core manifest differs"):
        UPDATER.apply_package(
            tampered,
            expected_commit=COMMIT,
            expected_sha256=hashlib.sha256(tampered).hexdigest(),
            root=root,
        )


def test_rolls_back_replaced_files_if_later_replace_fails(tmp_path, monkeypatch):
    root = installed_root(tmp_path)
    (root / "autopilot.py").write_bytes(b"# old autopilot\n")
    (root / "brain.py").write_bytes(b"# old brain\n")
    before = {name: (root / name).read_bytes() for name in ("autopilot.py", "brain.py")}
    package = archive_bytes({"autopilot.py": b"# new autopilot\n", "brain.py": b"# new brain\n"})
    replace = UPDATER.os.replace
    calls = 0

    def fail_on_second_replace(source, destination):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated replace failure")
        return replace(source, destination)

    monkeypatch.setattr(UPDATER.os, "replace", fail_on_second_replace)
    with pytest.raises(UPDATER.UpdateError, match="rolled back"):
        UPDATER.apply_package(
            package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root
        )

    assert {name: (root / name).read_bytes() for name in before} == before
    assert not (root / ".client-version.json").exists()


def test_gui_client_rejects_legacy_package_before_overwriting_updater(tmp_path):
    root = installed_root(tmp_path)
    (root / "client_manager.py").write_bytes(b"# installed GUI\n")
    (root / "client_updater.py").write_bytes(b"# new compatible updater\n")
    package = archive_bytes({"autopilot.py": b"# legacy package\n"})
    with pytest.raises(UPDATER.UpdateError, match="manager protocol"):
        UPDATER.apply_package(package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root)
    assert (root / "client_updater.py").read_bytes() == b"# new compatible updater\n"


def test_compatible_manager_package_applies_and_can_be_reapplied(tmp_path):
    root = installed_root(tmp_path)
    package = archive_bytes({"client_manager.py": b"# manager\n", "client_manager_service.py": b"# manager service\n", "client-manager.vbs": b"Option Explicit\n"}, manager_protocol=1)
    digest = hashlib.sha256(package).hexdigest()
    first = UPDATER.apply_package(package, expected_commit=COMMIT, expected_sha256=digest, root=root, require_manager=True)
    assert "client_manager.py" in first["changed"]
    second = UPDATER.apply_package(package, expected_commit=COMMIT, expected_sha256=digest, root=root, require_manager=True)
    assert second["changed"] == []


def test_manager_protocol_requires_all_components_before_writing(tmp_path):
    root = installed_root(tmp_path)
    package = archive_bytes({"client_manager.py": b"# manager\n"}, manager_protocol=1)
    with pytest.raises(UPDATER.UpdateError, match="manager protocol"):
        UPDATER.apply_package(package, expected_commit=COMMIT, expected_sha256=hashlib.sha256(package).hexdigest(), root=root, require_manager=True)
    assert not (root / "client_manager.py").exists()

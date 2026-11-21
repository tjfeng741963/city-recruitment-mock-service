"""Create and verify independent runtime backups without restoring over live files."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import ntpath
from pathlib import Path, PureWindowsPath
import re
import shutil
import sqlite3
import stat
import tempfile


WINDOWS_FILES = ("reply_log.db", "state/flow_state.db", "state/flow.remote.json",
                 ".report_state.json", ".greeted.json")


WINDOWS_REQUIRED = {"reply_log.db", "state/flow_state.db", ".report_state.json"}
DATABASE_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
IS_RESERVED_PATH = getattr(ntpath, "isreserved", lambda name: PureWindowsPath(name).is_reserved())


def checked_parts(name: str) -> tuple[str, ...]:
    parts = tuple(name.split("/"))
    if any(
        not part or part in (".", "..") or part.endswith((" ", "."))
        or re.search(r'[<>:"\\|?*\x00-\x1f]', part) or IS_RESERVED_PATH(part)
        for part in parts
    ) or name.casefold() == "manifest.json":
        raise ValueError(f"unsafe backup path: {name!r}")
    return parts


def reject_links(path: Path) -> None:
    for component in (*reversed(path.parents), path):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or (
            getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            raise ValueError(f"linked backup path is not allowed: {component}")


def restore_manifest(backup: Path) -> dict[str, str]:
    manifest = backup / "manifest.json"
    reject_links(manifest)
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not raw:
        raise ValueError("empty backup manifest")
    kind = raw.get("kind")
    checksums = raw.get("checksums") if raw.get("version") == 2 else raw
    if not isinstance(checksums, dict) or not checksums:
        raise ValueError("empty backup manifest")
    for name, checksum in checksums.items():
        checked_parts(name)
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("invalid backup checksum")
    if kind is None:
        # Version 1 stored just the checksums. It is still useful for restoration.
        kind = "windows" if WINDOWS_REQUIRED <= checksums.keys() else "server"
    if kind == "windows":
        if not WINDOWS_REQUIRED <= checksums.keys() or not checksums.keys() <= set(WINDOWS_FILES):
            raise ValueError("Windows backup manifest is missing required files or has extra files")
    elif kind == "server":
        if len(checksums) != 1 or any(
            "/" in name or Path(name).suffix.lower() not in DATABASE_SUFFIXES for name in checksums
        ):
            raise ValueError("server backup must contain a single SQLite database")
    else:
        raise ValueError("invalid backup kind")
    return checksums


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def database_copy(source: Path, destination: Path) -> None:
    with (closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as original,
          closing(sqlite3.connect(destination)) as copy):
        original.backup(copy)
        if copy.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise RuntimeError("SQLite backup integrity check failed")


def create_backup(source: Path, destination: Path, *, windows: bool) -> Path:
    reject_links(source.absolute())
    reject_links(destination.absolute())
    required = WINDOWS_REQUIRED if windows else {source.name}
    if not windows and source.suffix.lower() not in DATABASE_SUFFIXES:
        raise ValueError("server backup source must be a SQLite database")
    if windows and destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("backup destination must be outside the live client directory")
    files = WINDOWS_FILES if windows else (source.name,)
    root = source if windows else source.parent
    destination.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    with tempfile.TemporaryDirectory(prefix=".backup-", dir=destination) as temporary:
        stage = Path(temporary) / stamp
        stage.mkdir()
        checksums = {}
        for name in files:
            active = root.joinpath(*checked_parts(name))
            reject_links(active.absolute())
            if not active.is_file():
                if name in required:
                    raise FileNotFoundError(name)
                continue
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if active.suffix.lower() in DATABASE_SUFFIXES:
                database_copy(active, target)
            else:
                data = active.read_bytes()
                value = json.loads(data)
                if name == ".report_state.json" and not isinstance(value, dict):
                    raise ValueError("reporter checkpoint is not a JSON object")
                target.write_bytes(data)
            checksums[name] = digest(target)
        manifest = {"version": 2, "kind": "windows" if windows else "server", "checksums": checksums}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return stage.rename(destination / stamp)


def verify_restore(backup: Path, destination: Path | None = None) -> dict[str, int]:
    backup = backup.absolute()
    if destination is not None:
        destination = destination.absolute()
        reject_links(destination)
        if destination.exists():
            raise FileExistsError(destination)
        if destination.resolve().is_relative_to(backup.resolve()):
            raise ValueError("restore destination must be outside the backup")
        destination.parent.mkdir(parents=True, exist_ok=True)

    source_manifest = backup / "manifest.json"
    reject_links(source_manifest)
    databases = 0
    with tempfile.TemporaryDirectory(
        prefix=".isolated-restore-", dir=destination.parent if destination else None
    ) as temporary:
        root = Path(temporary)
        shutil.copyfile(source_manifest, root / "manifest.json")
        checksums = restore_manifest(root)
        for name, checksum in checksums.items():
            parts = checked_parts(name)
            stored = backup.joinpath(*parts)
            reject_links(stored)
            restored = root.joinpath(*parts)
            restored.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(stored, restored)
            if digest(restored) != checksum:
                raise ValueError(f"backup checksum mismatch: {name}")
            if restored.suffix.lower() in DATABASE_SUFFIXES:
                # The backup is standalone. Immutable read-only access avoids generating sidecars.
                uri = restored.as_uri() + "?mode=ro&immutable=1"
                with closing(sqlite3.connect(uri, uri=True)) as db:
                    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                        raise ValueError(f"isolated SQLite restore failed: {name}")
                databases += 1
            else:
                value = json.loads(restored.read_bytes())
                if name == ".report_state.json" and not isinstance(value, dict):
                    raise ValueError("reporter checkpoint is not a JSON object")
        if destination is not None:
            # Claim the destination exclusively so a concurrent retry cannot overwrite it.
            destination.mkdir()
            for item in root.iterdir():
                if item.name != "manifest.json":
                    item.rename(destination / item.name)
            (root / "manifest.json").rename(destination / "manifest.json")
    return {"verified_files": len(checksums), "verified_databases": databases}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("windows", "server", "verify", "restore"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    args = parser.parse_args()
    backup = args.source
    if args.kind == "restore":
        if args.destination is None:
            parser.error("a new isolated restore directory is required")
        print(json.dumps({"backup": str(backup), "restored": str(args.destination),
                          **verify_restore(backup, args.destination)}))
        return
    if args.kind in ("windows", "server"):
        if args.destination is None:
            parser.error("backup destination is required")
        backup = create_backup(args.source, args.destination, windows=args.kind == "windows")
    elif args.destination is not None:
        parser.error("verify accepts one backup directory")
    print(json.dumps({"backup": str(backup), **verify_restore(backup)}))


if __name__ == "__main__":
    main()

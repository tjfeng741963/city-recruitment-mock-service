"""Run backup and restore against local synthetic recovery data."""

from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest


spec = importlib.util.spec_from_file_location(
    "backup_client_recovery", Path(__file__).resolve().parents[2] / "scripts/backup-client-recovery.py"
)
backup_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup_tool)


def test_isolated_restore_captures_active_wal_ack_and_cursor(tmp_path):
    live = tmp_path / "client"
    (live / "state").mkdir(parents=True)
    cursor = {
        "device_code": "fixture",
        "cursor": {"conversation": 57},
        "bridge_pages": {"scope": [57, 99]},
        "bridge_pending": {"event": {"message_id": 58}},
    }
    (live / ".report_state.json").write_text(json.dumps(cursor), encoding="utf-8")
    with (
        closing(sqlite3.connect(live / "reply_log.db")) as replies,
        closing(sqlite3.connect(live / "state/flow_state.db")) as flow,
    ):
        for db in (replies, flow):
            assert db.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
            db.execute("PRAGMA wal_autocheckpoint=0")
        replies.execute("CREATE TABLE receipts (id INT, receipt_state TEXT)")
        replies.executemany("INSERT INTO receipts VALUES (?, ?)", [(57, "acked"), (58, "pending")])
        replies.commit()
        flow.execute("CREATE TABLE session_state (next_step INT)")
        flow.execute("INSERT INTO session_state VALUES (3)")
        flow.commit()
        assert (live / "reply_log.db-wal").stat().st_size > 0

        saved = backup_tool.create_backup(live, tmp_path / "backups", windows=True)
        restored = tmp_path / "mirror"
        assert backup_tool.verify_restore(saved, restored) == {"verified_files": 3, "verified_databases": 2}
        assert backup_tool.verify_restore(saved) == {"verified_files": 3, "verified_databases": 2}
        assert json.loads((restored / ".report_state.json").read_text(encoding="utf-8")) == cursor
        with closing(sqlite3.connect(restored / "reply_log.db")) as result:
            assert result.execute("SELECT * FROM receipts ORDER BY id").fetchall() == [(57, "acked"), (58, "pending")]
        with closing(sqlite3.connect(restored / "state/flow_state.db")) as result:
            assert result.execute("SELECT next_step FROM session_state").fetchone() == (3,)
        with pytest.raises(FileExistsError):
            backup_tool.verify_restore(saved, live)


@pytest.mark.parametrize("filename", ["../escape.db", "state/../escape.db", "C:escape.db", "state\\escape.db"])
def test_restore_rejects_unsafe_manifest_paths(tmp_path, filename):
    saved = tmp_path / "backup"
    saved.mkdir()
    (saved / "manifest.json").write_text(json.dumps({filename: "a" * 64}), encoding="utf-8")
    with pytest.raises(ValueError, match="unsafe backup path"):
        backup_tool.verify_restore(saved, tmp_path / "mirror")
    assert not (tmp_path / "mirror").exists()


def test_checksum_failure_leaves_no_mirror(tmp_path):
    source = tmp_path / "app.sqlite"
    with closing(sqlite3.connect(source)) as connection:
        connection.execute("CREATE TABLE application_data (id INT)")
    saved = backup_tool.create_backup(source, tmp_path / "backups", windows=False)
    with (saved / source.name).open("ab") as invalid:
        invalid.write(b"altered")
    with pytest.raises(ValueError, match="checksum mismatch"):
        backup_tool.verify_restore(saved, tmp_path / "mirror")
    assert not (tmp_path / "mirror").exists()

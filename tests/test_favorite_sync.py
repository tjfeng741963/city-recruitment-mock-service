import importlib.util
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("favorite_sync", ROOT / "agent" / "favorite_sync.py")
favorite_sync = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(favorite_sync)


def test_parse_database_extracts_location_records(tmp_path):
    path = tmp_path / "kv.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE values_store (key TEXT, value TEXT)")
        db.execute(
            "INSERT INTO values_store VALUES (?, ?)",
            ("fav-1", "冠宇商务中心 广东省广州市天河区车陂路48号3栋2楼201号"),
        )
        db.commit()
    items, complete = favorite_sync.parse_database(path)
    assert complete is True
    assert items == [{
        "favorite_id": items[0]["favorite_id"],
        "kind": "location",
        "title": "冠宇商务中心",
        "address": "广东省广州市天河区车陂路48号3栋2楼201号",
    }]


def test_parse_database_marks_unreadable_file_incomplete(tmp_path):
    items, complete = favorite_sync.parse_database(tmp_path / "missing.db")
    assert items == []
    assert complete is False

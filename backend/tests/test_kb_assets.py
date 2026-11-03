"""图片素材抽取：base64 解出来落盘，库里只留 storage_key。"""

from __future__ import annotations

import base64
import sqlite3
from pathlib import Path

import pytest

from app.services.kb_assets import (
    ExtractedImage,
    LocalAssetStore,
    build_filename_index,
    extract_images,
)

# 1x1 PNG
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


def _make_ebf(path: Path, images: list[tuple[int, str, bytes]]) -> Path:
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE word_image (id INTEGER PRIMARY KEY, filename TEXT, base64 TEXT)")
    con.executemany(
        "INSERT INTO word_image VALUES (?,?,?)",
        [(i, name, base64.b64encode(data).decode()) for i, name, data in images],
    )
    con.commit()
    con.close()
    return path


class TestExtractImages:
    def test_writes_to_store(self, tmp_path: Path) -> None:
        ebf = _make_ebf(tmp_path / "a.ebf", [(1, "poster.png", PNG_BYTES)])
        store = LocalAssetStore(tmp_path / "assets")
        images, errors = extract_images(ebf, store, tenant_id=1)

        assert errors == []
        assert len(images) == 1
        img = images[0]
        assert img.filename == "poster.png"
        assert img.mime == "image/png"
        assert img.bytes == len(PNG_BYTES)
        assert (tmp_path / "assets" / img.storage_key).exists()

    def test_key_is_content_addressed(self, tmp_path: Path) -> None:
        """同样的内容即使文件名不同，也只落一份——按 sha1 去重。"""
        ebf = _make_ebf(
            tmp_path / "a.ebf",
            [(1, "a.png", PNG_BYTES), (2, "b.png", PNG_BYTES)],
        )
        store = LocalAssetStore(tmp_path / "assets")
        images, _ = extract_images(ebf, store)
        keys = {i.storage_key for i in images}
        assert len(keys) == 1
        assert len(list((tmp_path / "assets").rglob("*.png"))) == 1

    def test_dry_run_writes_nothing(self, tmp_path: Path) -> None:
        ebf = _make_ebf(tmp_path / "a.ebf", [(1, "poster.png", PNG_BYTES)])
        store = LocalAssetStore(tmp_path / "assets")
        images, _ = extract_images(ebf, store, dry_run=True)
        assert len(images) == 1
        assert not (tmp_path / "assets").exists()

    def test_data_uri_prefix_stripped(self, tmp_path: Path) -> None:
        prefix = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode()
        con = sqlite3.connect(tmp_path / "b.ebf")
        con.execute("CREATE TABLE word_image (id INTEGER PRIMARY KEY, filename TEXT, base64 TEXT)")
        con.execute("INSERT INTO word_image VALUES (1,'x.png',?)", (prefix,))
        con.commit()
        con.close()

        images, errors = extract_images(tmp_path / "b.ebf", LocalAssetStore(tmp_path / "assets"))
        assert errors == []
        assert images[0].mime == "image/png"

    def test_empty_data_recorded_as_error(self, tmp_path: Path) -> None:
        ebf = _make_ebf(tmp_path / "a.ebf", [(1, "empty.png", b"")])
        images, errors = extract_images(ebf, LocalAssetStore(tmp_path / "assets"))
        assert images == []
        assert len(errors) == 1

    def test_source_file_untouched(self, tmp_path: Path) -> None:
        ebf = _make_ebf(tmp_path / "a.ebf", [(1, "poster.png", PNG_BYTES)])
        before = (ebf.stat().st_size, ebf.stat().st_mtime_ns)
        extract_images(ebf, LocalAssetStore(tmp_path / "assets"))
        assert (ebf.stat().st_size, ebf.stat().st_mtime_ns) == before


class TestFilenameIndex:
    def test_maps_filename_to_image(self) -> None:
        img = ExtractedImage(
            filename="poster.png", storage_key="kb/1/ab/abc.png", bytes=10, mime="image/png"
        )
        index = build_filename_index([img])
        assert index["poster.png"].storage_key == "kb/1/ab/abc.png"


class TestLocalAssetStore:
    def test_exists_false_before_put(self, tmp_path: Path) -> None:
        store = LocalAssetStore(tmp_path)
        assert store.exists("kb/1/ab/x.png") is False

    def test_put_then_exists(self, tmp_path: Path) -> None:
        store = LocalAssetStore(tmp_path)
        store.put("kb/1/ab/x.png", b"data")
        assert store.exists("kb/1/ab/x.png") is True
        assert (tmp_path / "kb/1/ab/x.png").read_bytes() == b"data"

    def test_no_partial_file_left_behind(self, tmp_path: Path) -> None:
        store = LocalAssetStore(tmp_path)
        store.put("kb/1/ab/x.png", b"data")
        assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("a.JPG", "image/jpeg"),
        ("a.jpeg", "image/jpeg"),
        ("a.webp", "image/webp"),
        ("a.gif", "image/gif"),
    ],
)
def test_mime_by_extension(tmp_path: Path, filename: str, expected: str) -> None:
    ebf = _make_ebf(tmp_path / "a.ebf", [(1, filename, PNG_BYTES)])
    images, _ = extract_images(ebf, LocalAssetStore(tmp_path / "assets"))
    assert images[0].mime == expected

"""图片素材抽取：把 base64 从 .ebf 里解出来，落到存储层。

为什么必须抽出来（决策文档 5.2 第 ③ 点）：
78 张图共 157 MB 现在全在 SQLite 的 base64 字段里，每次查询都在拖慢整个库，
备份文件也变成一百多 MB。数据库只该存 `storage_key`。

存储后端用协议隔离：现在落本地目录，接腾讯云 COS 时只换一个实现，
导入脚本和数据库一行不用改。COS 的密钥还没到位，所以先不做。

路径规则：kb/{tenant_id}/{sha1[:2]}/{sha1}.{ext}
——按哈希前缀分目录，避免单目录几万个文件。
"""

from __future__ import annotations

import base64
import hashlib
import sqlite3
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 单图上限，防止异常数据打爆磁盘


class AssetStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def exists(self, key: str) -> bool: ...


@dataclass(frozen=True)
class LocalAssetStore:
    """本地目录实现。生产接 COS 时用同样的 put/exists 签名换掉即可。"""

    root: Path

    def put(self, key: str, data: bytes) -> None:
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        # 先写临时文件再改名，避免中断留下半截图片
        tmp = target.with_suffix(target.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(target)

    def exists(self, key: str) -> bool:
        return (self.root / key).exists()


@dataclass(frozen=True)
class ExtractedImage:
    filename: str
    storage_key: str
    bytes: int
    mime: str


def _guess_mime(filename: str, data: bytes) -> str:
    lower = filename.lower()
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".webp"):
        return "image/webp"
    # 兜底按魔数判断
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"


def extract_images(
    source: str | Path,
    store: AssetStore,
    *,
    tenant_id: int = 1,
    dry_run: bool = False,
) -> tuple[list[ExtractedImage], list[str]]:
    """把 word_image 里的 base64 全部解码落盘。

    返回 (成功的图片列表, 错误列表)。源文件只读打开。
    """
    uri = "file:" + urllib.parse.quote(str(source)) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row

    extracted: list[ExtractedImage] = []
    errors: list[str] = []

    try:
        rows = con.execute("SELECT id, filename, base64 FROM word_image ORDER BY id").fetchall()
        for row in rows:
            filename = (row["filename"] or f"image-{row['id']}.bin").strip()
            raw = row["base64"]
            if not raw:
                errors.append(f"图片 {row['id']} ({filename}) 无数据")
                continue
            # 有些导出会把 data URI 前缀一起存进去
            if isinstance(raw, str) and raw.startswith("data:"):
                raw = raw.split(",", 1)[-1]
            try:
                data = base64.b64decode(raw, validate=False)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"图片 {row['id']} ({filename}) 解码失败：{exc}")
                continue
            if not data:
                errors.append(f"图片 {row['id']} ({filename}) 解码为空")
                continue
            if len(data) > MAX_IMAGE_BYTES:
                errors.append(f"图片 {row['id']} ({filename}) 超过 {MAX_IMAGE_BYTES} 字节上限")
                continue

            digest = hashlib.sha1(data).hexdigest()  # noqa: S324  仅用于去重命名，非安全用途
            ext = Path(filename).suffix.lower() or ".bin"
            key = f"kb/{tenant_id}/{digest[:2]}/{digest}{ext}"

            if not dry_run and not store.exists(key):
                store.put(key, data)

            extracted.append(
                ExtractedImage(
                    filename=filename,
                    storage_key=key,
                    bytes=len(data),
                    mime=_guess_mime(filename, data),
                )
            )
    finally:
        con.close()

    return extracted, errors


def build_filename_index(images: list[ExtractedImage]) -> dict[str, ExtractedImage]:
    """源数据里 word_list 的图片片段只存文件名，靠这个索引回填 asset_id。"""
    return {img.filename: img for img in images}

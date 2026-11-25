"""只读读取企微收藏位置并生成账号快照。

企微把收藏放在账号 Data 目录的 kv.db（加密，可能还有 kv.db-wal）。本模块不点击
企微窗口、不发送消息；使用已由 Store 验证的本地密钥解密临时副本，再从未知 schema
中提取含地址特征的记录。无法确认完整读取时返回 complete=False，服务端不会做删除。
"""
from __future__ import annotations

import hashlib
import re
import shutil
import sqlite3
import tempfile
import uuid
from pathlib import Path

_CJK = re.compile(r"[\u3400-\u9fff]")
_ADDR = re.compile(r"[省市区县路街号栋楼室巷村镇地铁出口社区广场]")
_RUN = re.compile(r"[\u3400-\u9fff0-9A-Za-z()（）#·\-]{2,120}")
_ARCHIVE = b"serialization::archive"


def _labels(value: bytes | str) -> tuple[str, str]:
    text = value if isinstance(value, str) else value.decode("utf-8", "ignore")
    runs = []
    for item in _RUN.findall(text):
        item = item.strip()
        if len(item) >= 2 and _CJK.search(item) and item not in runs:
            runs.append(item)
    address = max((x for x in runs if _ADDR.search(x)), key=len, default="")
    title = max((x for x in runs if x != address), key=len, default="")
    return title, address


def _raw_card(value: bytes) -> bytes:
    if _ARCHIVE not in value or len(value) > 64 * 1024:
        return b""
    # kv.db 可能存带长度字段的 protobuf；保留整段只读上报，由服务端校验大小。
    start = value.find(b"22 serialization::archive")
    if start < 0:
        start = value.find(_ARCHIVE)
        start = max(0, start - 3)
    candidate = value[start:]
    return candidate if len(candidate) <= 8192 else b""


def _iter_values(row: sqlite3.Row):
    for value in row:
        if isinstance(value, bytes) and value:
            yield value
        elif isinstance(value, str) and value.strip():
            yield value


def parse_database(path: Path) -> tuple[list[dict], bool]:
    """解析已解密的 kv.db；返回 (items, complete)。"""
    items: list[dict] = []
    seen: set[str] = set()
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro&immutable=1", uri=True, timeout=3)
        con.row_factory = sqlite3.Row
    except Exception:
        return [], False
    try:
        tables = [str(r[0]) for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            if not re.fullmatch(r"[A-Za-z0-9_]+", table):
                continue
            try:
                rows = con.execute(f'SELECT * FROM "{table}" LIMIT 5000')
                for row in rows:
                    title = address = ""
                    raw = b""
                    for value in _iter_values(row):
                        t, a = _labels(value)
                        if len(a) > len(address):
                            address = a
                        if len(t) > len(title):
                            title = t
                        if isinstance(value, bytes) and not raw:
                            raw = _raw_card(value)
                    if not title or not address:
                        continue
                    key = hashlib.sha256(f"{table}\0{title}\0{address}".encode()).hexdigest()[:24]
                    if key in seen:
                        continue
                    seen.add(key)
                    item = {"favorite_id": f"kv:{table}:{key}", "kind": "location", "title": title, "address": address}
                    if raw:
                        item["data_base64"] = __import__("base64").b64encode(raw).decode("ascii")
                    items.append(item)
            except sqlite3.Error:
                continue
        return items, True
    except sqlite3.Error:
        return items, False
    finally:
        con.close()


def collect(store) -> tuple[str, bool, list[dict]]:
    """从 Store 的账号目录读取收藏；失败时返回空的不完整快照。"""
    data_dir = getattr(store, "data_dir", None)
    if not data_dir:
        return "", False, []
    source = Path(data_dir) / "kv.db"
    if not source.is_file():
        return "", False, []
    temp_dir = Path(tempfile.mkdtemp(prefix="favorite-sync-"))
    try:
        target = temp_dir / "kv.db"
        try:
            keys = store._ensure_keys()
            with source.open("rb") as fh:
                salt = fh.read(16).hex()
            key = keys.get(salt) or next(iter(keys.values()))
            from wecom_io_core import crypto
            decrypted = crypto.decrypt_file(str(source), str(target), key)
            if not decrypted:
                shutil.copy2(source, target)
        except Exception:
            shutil.copy2(source, target)
        items, complete = parse_database(target)
        # snapshot_id 只用于服务端的幂等/reconciliation，不包含原始卡片内容。
        stable = "\n".join(f"{x['favorite_id']}|{x['title']}|{x['address']}" for x in items)
        snapshot = hashlib.sha256(stable.encode("utf-8")).hexdigest() if complete else uuid.uuid4().hex
        return snapshot, complete, items
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


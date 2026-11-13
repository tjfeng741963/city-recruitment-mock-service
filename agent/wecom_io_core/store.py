"""会话与消息读取：把加密库解密成只读副本，再查询。

设计要点：
  - 每次刷新都会重新解密（原库在被客户端写），副本放 _decrypted/ 目录
  - 所有连接强制 mode=ro，绝不写原库、也不写副本
  - 消息正文是 protobuf，这里只取第一个 string 字段（文本消息）
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import time
from pathlib import Path

from . import crypto
from .identity import direction_of, resolve_self_id
from .vendor.key_extract import extract_key as ref_extract_key

BASE = Path(__file__).resolve().parent.parent
CACHE = BASE / "_decrypted"
NEEDED = ("session.db", "message.db", "user.db", "message_lookup.db")

PREFIX_TYPE = {
    "S:": "单聊",
    "R:": "群聊",
    "M:": "微信联系人",
    "Y:": "系统",
    "O:": "应用",
    "MAIL": "邮件",
}


def find_data_dir() -> Path | None:
    """找当前正在使用的账号目录（message.db 最新修改的那个）。"""
    root = Path(os.environ["USERPROFILE"]) / "Documents" / "WXWork"
    if not root.is_dir():
        return None
    best, best_mtime = None, 0.0
    for d in root.iterdir():
        msg = d / "Data" / "message.db"
        if msg.is_file():
            mt = msg.stat().st_mtime
            if mt > best_mtime:
                best, best_mtime = d / "Data", mt
    return best


def conv_type(cid: str) -> str:
    for p, name in PREFIX_TYPE.items():
        if cid.startswith(p):
            return name
    return "其他"


def _pb_text(data) -> str:
    """从 protobuf 里取最长的字符串字段当正文。

    消息体是多字段 protobuf（含类型、引用、正文等），直接取第一个字段会把
    长度前缀和控制字符带出来，所以这里按字段完整解析，取最长的可读串。
    """
    if isinstance(data, str):
        return data
    if not isinstance(data, (bytes, bytearray)) or not data:
        return ""
    buf = bytes(data)
    i, n = 0, len(buf)
    best, best_score = "", 0

    def _varint(pos: int):
        val, shift = 0, 0
        while pos < n:
            b = buf[pos]
            pos += 1
            val |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        return val, pos

    while i < n:
        key, i = _varint(i)
        if key == 0 or i >= n:
            break
        wire = key & 7
        if wire == 0:
            _, i = _varint(i)
        elif wire == 1:
            i += 8
        elif wire == 2:
            ln, i = _varint(i)
            chunk = buf[i:i + ln]
            i += ln
            try:
                text = chunk.decode("utf-8")
            except UnicodeDecodeError:
                continue
            # 去掉控制字符后再评分：取「可读字符最多」的那一段
            clean = "".join(c for c in text if ord(c) >= 32 or c in "\n\t")
            score = sum(1 for c in clean if c.isalnum() or "\u4e00" <= c <= "\u9fff")
            has_cjk = any("\u4e00" <= c <= "\u9fff" for c in clean)
            # 开头是英文、后面才出现中文，通常是把长度前缀一起解出来了，扣分
            if has_cjk and clean[0].isascii() and clean[0].isalnum():
                score -= 10
            if score > best_score and clean.strip():
                best, best_score = clean, score
        elif wire == 5:
            i += 4
        else:
            break
    best = best.replace("\x00", "").strip()
    # 去掉「英文前缀 + 中文正文」里被误解出的长度前缀
    m = re.match(r"^[\x20-\x7e\n]{1,5}(?=[\u4e00-\u9fff])", best)
    if m:
        best = best[m.end():]
    return best.strip()


def _read_wal_frames(wal: Path) -> tuple[int, list[tuple[int, int, bytes]]]:
    """解析 WAL：返回 (页大小, [(页号, 提交后页数, 页数据)])。

    帧头 24 字节 = 页号(4) dbsize(4) salt1(4) salt2(4) 校验1(4) 校验2(4)。
    只收 salt 与 WAL 头部一致的帧——不一致的是上一代 WAL 的残留。
    """
    raw = wal.read_bytes()
    if len(raw) < 32:
        return 0, []
    page_sz = int.from_bytes(raw[8:12], "big") or crypto.PAGE_SZ
    salt1 = int.from_bytes(raw[16:20], "big")
    salt2 = int.from_bytes(raw[20:24], "big")
    frames: list[tuple[int, int, bytes]] = []
    off, frame_sz = 32, 24 + page_sz
    while off + frame_sz <= len(raw):
        page_no = int.from_bytes(raw[off : off + 4], "big")
        dbsize = int.from_bytes(raw[off + 4 : off + 8], "big")
        fs1 = int.from_bytes(raw[off + 8 : off + 12], "big")
        fs2 = int.from_bytes(raw[off + 12 : off + 16], "big")
        if page_no and fs1 == salt1 and fs2 == salt2:
            frames.append((page_no, dbsize, raw[off + 24 : off + frame_sz]))
        off += frame_sz
    return page_sz, frames


def _overlay_wal(wal: Path, dst: Path, key: bytes) -> int:
    """把 WAL 里已提交的页盖到已解密的主库上，返回覆盖的页数。

    企微开着的时候，新消息先写进 -wal，主库要等 checkpoint 才更新。
    只解密主库会「永远慢一拍」——这是发完消息读不到的根本原因。
    """
    page_sz, frames = _read_wal_frames(wal)
    if not frames:
        return 0
    cur = dst.read_bytes()
    total = len(cur) // page_sz
    pages: dict[int, bytes] = {}
    dbsize = 0
    for page_no, ds, data in frames:
        if ds:
            dbsize = ds
        try:
            pages[page_no] = crypto.decrypt_page(key, data[:page_sz].ljust(page_sz, b"\x00"), page_no)
        except Exception:
            continue
    if not pages:
        return 0
    final = max(dbsize or total, max(pages))
    out = bytearray()
    for pno in range(1, final + 1):
        if pno in pages:
            out += pages[pno]
        else:
            off = (pno - 1) * page_sz
            chunk = cur[off : off + page_sz]
            out += chunk.ljust(page_sz, b"\x00")
    dst.write_bytes(bytes(out))
    return len(pages)


class Store:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = data_dir or find_data_dir()
        self._keys: dict[str, bytes] | None = None
        self.last_refresh = 0.0
        # (self_id, 来源)；refresh() 后失效，因为会话表可能变了
        self._self_id: tuple[str, str] | None = None

    # ---------- 解密 ----------
    def _key_cache_path(self):
        return CACHE / ".key"

    def _try_cached_key(self, sample: Path) -> bytes | None:
        """先试本地缓存的密钥，验证不过再回退到扫描内存。"""
        p = self._key_cache_path()
        if not p.is_file():
            return None
        try:
            key = bytes.fromhex(p.read_text(encoding="ascii").strip())
        except Exception:
            return None
        if len(key) != 16 or not sample.is_file():
            return None
        try:
            with open(sample, "rb") as fh:
                page1 = fh.read(crypto.PAGE_SZ)
            return key if crypto.verify_key(key, page1) else None
        except Exception:
            return None

    def _ensure_keys(self) -> dict[str, bytes]:
        """salt -> 16 字节密钥。不同库可能用不同盐，按盐分别取。"""
        if self._keys is None:
            if not self.data_dir:
                raise RuntimeError("没找到企业微信数据目录")
            sample = self.data_dir / "message.db"
            cached = self._try_cached_key(sample)
            if cached is not None:
                with open(sample, "rb") as fh:
                    salt = fh.read(16).hex()
                self._keys = {salt: cached}
                return self._keys

            raw = ref_extract_key(db_dir=str(self.data_dir), timeout=120)
            self._keys = {
                salt: bytes.fromhex(h)
                for salt, h in raw.items()
                if salt != "_db_dir" and isinstance(h, str) and len(h) == 32
            }
            if not self._keys:
                raise RuntimeError("没取到任何密钥")
            try:
                CACHE.mkdir(parents=True, exist_ok=True)
                self._key_cache_path().write_text(
                    next(iter(self._keys.values())).hex(), encoding="ascii")
            except Exception:
                pass
        return self._keys

    def refresh(self) -> dict:
        """重新解密需要的库，返回统计。"""
        if not self.data_dir:
            raise RuntimeError("没找到企业微信数据目录")
        CACHE.mkdir(parents=True, exist_ok=True)
        keys = self._ensure_keys()
        stats = {"decrypted": 0, "copied": 0, "failed": 0}
        for name in NEEDED:
            src = self.data_dir / name
            if not src.is_file():
                continue
            dst = CACHE / name
            try:
                with open(src, "rb") as fh:
                    salt = fh.read(16).hex()
                key = keys.get(salt)
                if key is None:  # 该库盐没有对应密钥，挑一把能验证的
                    with open(src, "rb") as fh:
                        page1 = fh.read(crypto.PAGE_SZ)
                    for k in keys.values():
                        if crypto.verify_key(k, page1):
                            key = k
                            break
                if key is None:
                    stats["failed"] += 1
                    continue
                if crypto.decrypt_file(str(src), str(dst), key):
                    stats["decrypted"] += 1
                else:
                    shutil.copy2(src, dst)
                    stats["copied"] += 1
                # 关键：新消息先落在 -wal 里，主库要等 checkpoint 才合并。
                # 不叠加 WAL，就会「刚发的消息读不到」。
                wal = self.data_dir / f"{name}-wal"
                if wal.is_file():
                    stats["wal_pages"] = stats.get("wal_pages", 0) + _overlay_wal(wal, dst, key)
            except Exception:
                stats["failed"] += 1
        self.last_refresh = time.time()
        self._self_id = None   # 会话表可能新增单聊，下次 self_id() 重新投票
        return stats

    def _conn(self, name: str) -> sqlite3.Connection | None:
        p = CACHE / name
        if not p.is_file():
            return None
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=3)
        con.row_factory = sqlite3.Row
        return con

    # ---------- 查询 ----------
    def self_id(self) -> str:
        """自己的会话成员 id。

        过去只取数据目录名（`Documents/WXWork/<vid>/Data` 的 `<vid>`），
        目录名一变（data_dir 显式配置成副本目录、多账号切换）整批方向就翻。
        现在再用会话表交叉校验：单聊 `S:<A>_<B>` 里自己必然出现，且在每个单聊里
        都出现一次，对方只出现一次 → 用出现次数最多者纠正目录名。
        """
        return self.self_id_detail()[0]

    def self_id_detail(self) -> tuple[str, str]:
        """(自己的 id, 判定来源)：data-dir / data-dir+session / session-majority。"""
        if self._self_id is None:
            try:
                dir_id = self.data_dir.parent.name if self.data_dir else ""
            except Exception:  # noqa: BLE001
                dir_id = ""
            self._self_id = resolve_self_id(self._single_chat_ids(), dir_id)
        return self._self_id

    def _single_chat_ids(self) -> list[str]:
        con = self._conn("session.db")
        if not con:
            return []
        try:
            return [r["id"] or "" for r in con.execute(
                "select id from conversation_table where id like 'S:%'")]
        except sqlite3.Error:
            return []
        finally:
            con.close()

    def sessions(self, limit: int = 200, with_names: bool = True) -> list[dict]:
        con = self._conn("session.db")
        if not con:
            return []
        try:
            rows = con.execute(
                "select id, name, last_message_time, last_message_id, is_sticked "
                "from conversation_table order by last_message_time desc limit ?", (limit,)
            ).fetchall()
            out = []
            for r in rows:
                cid = r["id"] or ""
                out.append({
                    "id": cid,
                    "name": r["name"] or "",
                    "type": conv_type(cid),
                    "last_time": r["last_message_time"] or 0,
                    "sticked": bool(r["is_sticked"]),
                })
            if with_names:
                contacts = self.contacts()
                me = self.self_id()
                for item in out:
                    if item["name"]:
                        continue
                    cid = item["id"]
                    if cid.startswith("S:"):
                        parts = cid[2:].split("_")
                        other = next((x for x in parts if x != me), parts[0] if parts else "")
                        item["name"] = contacts.get(other, "")
            return out
        except sqlite3.Error:
            return []
        finally:
            con.close()

    def contacts(self) -> dict[str, str]:
        """id(数字) -> 昵称，用于给单聊补名字。"""
        con = self._conn("user.db")
        if not con:
            return {}
        mapping: dict[str, str] = {}
        for table, id_col, name_col in (
            ("user_table", "id", "name"),
            ("wechat_contactV1", "wxid", "name"),
        ):
            try:
                for r in con.execute(f"select {id_col}, {name_col} from {table}"):
                    if r[0] is not None and r[1]:
                        mapping[str(r[0])] = r[1]
            except sqlite3.Error:
                continue
        con.close()
        return mapping

    def messages(self, conv_id: str, limit: int = 50) -> list[dict]:
        con = self._conn("message.db")
        if not con:
            return []
        try:
            rows = con.execute(
                "select message_id, sender_id, send_time, content_type, content "
                "from message_table where conversation_id=? order by send_time desc limit ?",
                (conv_id, limit),
            ).fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            con.close()
        out = []
        for r in rows:
            ctype = r["content_type"]
            text = _pb_text(r["content"]) if ctype in (2, 573) else ""
            out.append({
                "id": r["message_id"],
                "sender_id": r["sender_id"],
                "time": r["send_time"] or 0,
                "type": ctype,
                "text": text,
                "is_text": bool(text),
            })
        out.reverse()
        return out

    def recent(self, limit: int = 40) -> list[dict]:
        """最近消息（跨会话，按时间正序），带会话名，用于实时接收。"""
        con = self._conn("message.db")
        if not con:
            return []
        try:
            rows = con.execute(
                "select message_id, conversation_id, sender_id, send_time, "
                "content_type, content from message_table "
                "order by send_time desc limit ?", (limit,)
            ).fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            con.close()

        name_map = {s["id"]: s["name"] for s in self.sessions()}
        contacts = self.contacts()
        me = self.self_id()
        out = []
        for r in rows:
            ctype = r["content_type"]
            text = _pb_text(r["content"]) if ctype in (2, 573) else ""
            sid = str(r["sender_id"])
            direction = direction_of(sid, me, r["conversation_id"])
            out.append({
                "id": r["message_id"],
                "conv_id": r["conversation_id"],
                "conv_name": name_map.get(r["conversation_id"], "") or r["conversation_id"],
                "sender_id": sid,
                "sender": "我" if direction == "outbound" else (contacts.get(sid) or "对方"),
                "is_self": direction == "outbound",
                "direction": direction,
                "time": r["send_time"] or 0,
                "type": ctype,
                "text": text,
                "is_text": bool(text),
            })
        out.reverse()
        return out

    def unread(self) -> dict[str, int]:
        """未读数（尽力而为：不同版本表名不同，失败就返回空）。"""
        con = self._conn("session.db")
        if not con:
            return {}
        result: dict[str, int] = {}
        for table, id_col, cnt_col in (
            ("need_report_unread_count_conversation_table", "conversation_id", "unread_count"),
            ("conversation_unread_table", "conversation_id", "count"),
        ):
            try:
                for r in con.execute(f"select {id_col}, {cnt_col} from {table}"):
                    if r[0] and r[1]:
                        result[r[0]] = int(r[1])
                if result:
                    break
            except sqlite3.Error:
                continue
        con.close()
        return result

"""wxSQLite3 AES-128 解密 + 从 WXWork.exe 进程内存取密钥。

算法来自开源项目 99Gaoxiaoqi/wecom-alert-suite（MIT）与 wechat-decrypt，
此处为精简移植，仅保留本工具需要的部分：

    每页密钥 = MD5(raw_key + LE32(页号) + "sAlT")
    每页 IV   = 由页号经 sqlite3mc 伪随机算法生成
    第 1 页   = 特殊处理（前 16 字节为明文盐，16..24 保留头片段）
"""
from __future__ import annotations

import bisect
import ctypes
import ctypes.wintypes as wt
import hashlib
import os
import re
import struct
import subprocess
import time
from typing import Optional

from Cryptodome.Cipher import AES

PAGE_SZ = 4096
SQLITE_HDR = b"SQLite format 3\x00"
SALT = b"sAlT"

kernel32 = ctypes.windll.kernel32
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400


# --------------------------------------------------------------------------
# 解密
# --------------------------------------------------------------------------
def _modmult(a: int, b: int, c: int, m: int, s: int) -> int:
    q = s // a
    s = b * (s - a * q) - c * q
    if s < 0:
        s += m
    return s


def _iv(page_no: int) -> bytes:
    z = page_no + 1
    initkey = bytearray(16)
    for idx in range(4):
        z = _modmult(52774, 40692, 3791, 2147483399, z)
        initkey[idx * 4: idx * 4 + 4] = struct.pack("<I", z & 0xFFFFFFFF)
    return hashlib.md5(initkey).digest()


def _page_key(raw_key: bytes, page_no: int) -> bytes:
    return hashlib.md5(raw_key + struct.pack("<I", page_no) + SALT).digest()


def is_plain(page: bytes) -> bool:
    return page[:16] == SQLITE_HDR


def _has_plain_header_fragment(page: bytes) -> bool:
    if len(page) < 24:
        return False
    h = page[16:24]
    ps = (h[0] << 8) | h[1]
    if ps == 1:
        ps = 65536
    return 512 <= ps <= 65536 and (ps & (ps - 1)) == 0 and h[5] == 0x40 and h[6] == 0x20 and h[7] == 0x20


def decrypt_page(raw_key: bytes, page: bytes, page_no: int) -> bytes:
    if len(page) != PAGE_SZ:
        raise ValueError("page 必须 4096 字节")
    data = bytearray(page)
    if page_no == 1 and _has_plain_header_fragment(data):
        frag = bytes(data[16:24])
        data[16:24] = data[8:16]
        tail = AES.new(_page_key(raw_key, 1), AES.MODE_CBC, _iv(1)).decrypt(bytes(data[16:]))
        data[16:] = tail
        if bytes(data[16:24]) != frag:
            raise ValueError("密钥校验失败")
        data[:16] = SQLITE_HDR
        return bytes(data)
    return AES.new(_page_key(raw_key, page_no), AES.MODE_CBC, _iv(page_no)).decrypt(bytes(data))


def verify_key(raw_key: bytes, page1: bytes) -> bool:
    if len(raw_key) != 16 or len(page1) < PAGE_SZ:
        return False
    try:
        dec = decrypt_page(raw_key, page1[:PAGE_SZ], 1)
    except Exception:
        return False
    return dec[:16] == SQLITE_HDR and dec[100] in (0x02, 0x05, 0x0A, 0x0D)


def decrypt_file(src: str, dst: str, raw_key: bytes) -> bool:
    """解密单个库；返回 False 表示它本来就是明文。"""
    size = os.path.getsize(src)
    with open(src, "rb") as fin:
        page1 = fin.read(PAGE_SZ)
    if is_plain(page1):
        return False
    total = (size + PAGE_SZ - 1) // PAGE_SZ
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        for no in range(1, total + 1):
            page = fin.read(PAGE_SZ)
            if not page:
                break
            if len(page) < PAGE_SZ:
                page += b"\x00" * (PAGE_SZ - len(page))
            fout.write(decrypt_page(raw_key, page, no))
    return True


# --------------------------------------------------------------------------
# 取密钥（只读进程内存）
# --------------------------------------------------------------------------
class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_uint64),
        ("AllocationBase", ctypes.c_uint64),
        ("AllocationProtect", wt.DWORD),
        ("_pad1", wt.DWORD),
        ("RegionSize", ctypes.c_uint64),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
        ("_pad2", wt.DWORD),
    ]


def _read_mem(handle, addr: int, size: int) -> Optional[bytes]:
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(0)
    if kernel32.ReadProcessMemory(handle, ctypes.c_uint64(addr), buf, size, ctypes.byref(n)):
        return buf.raw[: n.value]
    return None


def _regions(handle) -> list[tuple[int, int]]:
    out, addr, mbi = [], 0, MBI()
    while addr < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(handle, ctypes.c_uint64(addr), ctypes.byref(mbi),
                                   ctypes.sizeof(mbi)) == 0:
            break
        if mbi.State == MEM_COMMIT and mbi.Protect in READABLE and 0 < mbi.RegionSize < 500 * 1024 * 1024:
            out.append((mbi.BaseAddress, mbi.RegionSize))
        nxt = mbi.BaseAddress + mbi.RegionSize
        if nxt <= addr:
            break
        addr = nxt
    return out


def _wxwork_pids() -> list[tuple[int, int]]:
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WXWork.exe", "/FO", "CSV", "/NH"],
                       capture_output=True, text=True, encoding="gbk", errors="replace")
    pids = []
    for line in r.stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = line.strip('"').split('","')
        if len(parts) >= 5:
            try:
                pid = int(parts[1])
                mem = int(parts[4].replace(",", "").replace(" K", "").strip() or 0)
                pids.append((pid, mem))
            except ValueError:
                continue
    pids.sort(key=lambda x: x[1], reverse=True)
    return pids


def extract_key(sample_db: str, timeout: int = 90) -> bytes:
    """扫描 WXWork.exe 内存，返回能解开 sample_db 第 1 页的 16 字节密钥。"""
    with open(sample_db, "rb") as f:
        page1 = f.read(PAGE_SZ)
    if is_plain(page1):
        raise RuntimeError("这个库没有加密，不需要密钥")

    pids = _wxwork_pids()
    if not pids:
        raise RuntimeError("WXWork.exe 没在运行，无法取密钥")

    pat = re.compile(b"x'([0-9a-fA-F]{32,192})'")
    t0 = time.time()
    for pid, _mem in pids:
        handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not handle:
            continue
        try:
            for base, size in _regions(handle):
                if time.time() - t0 > timeout:
                    raise RuntimeError("扫描超时，可能是进程保护拦住了")
                data = _read_mem(handle, base, size)
                if not data:
                    continue
                for m in pat.finditer(data):
                    h = m.group(1).decode()
                    cands = [h[:32]] if len(h) == 32 else [h[:32], h[:64]]
                    for c in cands:
                        try:
                            key = bytes.fromhex(c)
                        except ValueError:
                            continue
                        if len(key) == 16 and verify_key(key, page1):
                            return key
        finally:
            kernel32.CloseHandle(handle)
    raise RuntimeError("没找到可用密钥（客户端可能加了内存保护）")

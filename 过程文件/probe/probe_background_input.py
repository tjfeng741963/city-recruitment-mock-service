"""探针：企业微信能不能「不抢前台」直接灌字（决定候选 B 是否成立）。

背景
----
2026-11-13 会议：客户说竞品在同一台电脑上网页端 + 企微端同时开着、同时可操作、
AI 自动回、且不抢前台。技术方案文档（docs/技术方案-不抢前台与双端联动-20261113.md）
第 4 节的探针 3 就是这个脚本。

它干什么
--------
1. 找到 WeWorkWindow 的句柄（不激活、不置顶、不抢焦点）
2. 用 PostMessage 在输入框区域打一次 WM_LBUTTONDOWN / WM_LBUTTONUP
   （尝试让 Duilib 把「内部焦点」落到输入框）
3. 用 PostMessage 逐字投递 WM_CHAR
4. 用 PrintWindow 截图（不激活窗口也能截），存成 PNG，人工看一眼有没有字

它**不**干什么
--------------
- 不发 Enter（不会真的把消息发给客户）
- 不调用 ensure_foreground / ShowWindow / SetForegroundWindow
- 不碰 wecom_io_core 的任何文件
- 不写数据库、不读数据库

怎么跑
------
    cd C:\\CODE\\城市招聘配置还原\\agent
    python -I ..\\过程文件\\probe\\probe_background_input.py

⚠️ 跑之前：把企微打开到一个**你已经进去的会话**（比如文件传输助手），
   这样万一字进去了也不会误发。跑完看输出的 PNG。

判读
----
- 截图里输入框出现「测试测试」→ 候选 B 成立，可以走不注入的后台发送
- 没有字 → Duilib 不接受消息投递，只剩注入或独立会话两条路
"""
from __future__ import annotations

import ctypes
import struct
import sys
import time
import zlib
from ctypes import wintypes as wt
from pathlib import Path

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

OUT = Path(__file__).resolve().parent
TEST_TEXT = "测试测试"

# 输入框在窗口客户区里的相对位置。这些比例来自 2026-11 实机截图，
# 第一个点命中不了就换下一个。
CANDIDATES = [(0.52, 0.70), (0.52, 0.66), (0.52, 0.74), (0.40, 0.70)]

WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_CHAR = 0x0102
MK_LBUTTON = 0x0001
PW_RENDERFULLCONTENT = 0x00000002


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
        ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def find_wework() -> int:
    """找面积最大的 WeWorkWindow（只查，不激活）。"""
    found: list[tuple[int, int]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def _cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        if buf.value != "WeWorkWindow":
            return True
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if w > 400 and h > 300:
            found.append((w * h, hwnd))
        return True

    user32.EnumWindows(_cb, None)
    return max(found)[1] if found else 0


def client_size(hwnd: int) -> tuple[int, int]:
    r = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    return r.right - r.left, r.bottom - r.top


def post_click(hwnd: int, cx: int, cy: int) -> None:
    """不激活窗口，直接把点击投进去。lParam 打包客户区坐标。"""
    lp = (cy << 16) | (cx & 0xFFFF)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.03)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)


def post_text(hwnd: int, text: str) -> None:
    for ch in text:
        user32.PostMessageW(hwnd, WM_CHAR, ord(ch), 1)
        time.sleep(0.05)


def grab(hwnd: int) -> tuple[int, int, bytes]:
    """PrintWindow 截窗口（不要求窗口在前台）。"""
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    hdc = user32.GetWindowDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)
    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth, bi.biHeight = w, -h
    bi.biPlanes, bi.biBitCount, bi.biCompression = 1, 32, 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(hwnd, hdc)
    return w, h, buf.raw


def write_png(path: Path, w: int, h: int, bgra: bytes) -> None:
    """最小 PNG 编码（BGRA → RGB，zlib 压缩）。避免给探针装 Pillow。"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        row = bgra[y * w * 4:(y + 1) * w * 4]
        rgb = bytearray(w * 3)
        rgb[0::3] = row[2::4]
        rgb[1::3] = row[1::4]
        rgb[2::3] = row[0::4]
        raw += rgb

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> int:
    hwnd = find_wework()
    if not hwnd:
        print("没找到企业微信窗口（WeWorkWindow）。先把企微打开再跑。")
        return 1

    cw, ch = client_size(hwnd)
    print(f"找到窗口 hwnd=0x{hwnd:X}，客户区 {cw}x{ch}")
    print("接下来不会激活窗口、不会发 Enter。")

    for idx, (rx, ry) in enumerate(CANDIDATES, start=1):
        cx, cy = int(cw * rx), int(ch * ry)
        print(f"\n[候选点 {idx}/{len(CANDIDATES)}] ({rx}, {ry}) → 客户区 ({cx}, {cy})")
        post_click(hwnd, cx, cy)
        time.sleep(0.25)
        post_text(hwnd, TEST_TEXT)
        time.sleep(0.5)

        w, h, bgra = grab(hwnd)
        shot = OUT / f"probe-background-{idx}.png"
        write_png(shot, w, h, bgra)
        print(f"  截图：{shot}")

        answer = input(
            f"  看一眼 {shot.name}：输入框里有「{TEST_TEXT}」吗？"
            f"（直接回车=有；输入 n =没有，继续下一候选点）: "
        ).strip().lower()
        if answer in ("", "y", "yes", "有", "是", "1"):
            print("\n[结论] 候选 B 成立：PostMessage 能灌进输入框，前台没有变化。")
            print(f"       命中比例 ({rx}, {ry})，把它记进 background_send.py 的首选候选点。")
            return 0

    print("\n[结论] 所有候选点都没灌进去。")
    print("       → Duilib 不接受消息投递，只剩「注入」或「独立 Windows 会话」两条路。")
    print("       → 见 docs/技术方案-不抢前台与双端联动-20261113.md 第 6 节第三步。")
    return 2


if __name__ == "__main__":
    sys.exit(main())

"""纯 ctypes 截屏（不依赖 PIL）。

两种输出：
- ``capture()`` 写 BMP，用于排查键鼠自动化是否点对地方（原行为不变）；
- ``png_base64()`` 返回 PNG 的 base64，用于把企微登录二维码传到网页上给用户扫。

为什么要自己写 PNG：客户端依赖只有 httpx / pywin32 / pycryptodomex，没有 Pillow。
PNG 的最小实现（IHDR + IDAT + IEND）只有几十行，比为了截个图引入一个图像库划算；
而且二维码页是纯色块，zlib 压完通常只有几十 KB，BMP 要 1-3 MB。

为什么 win32 句柄改成惰性加载：模块顶层 ``ctypes.WinDLL("user32")`` 在 Linux 上
一导入就抛 OSError，CI 和任何跑在非 Windows 上的检查都读不了这个文件。
现在只有真正调用抓图函数时才加载，``encode_png`` 这类纯函数到处能用。
"""

from __future__ import annotations

import base64
import ctypes
import struct
import sys
import zlib
from ctypes import wintypes as wt

# 惰性加载的句柄（只有 Windows 上调真实抓图函数时才初始化）
_user32 = None
_gdi32 = None


def _libs():
    """返回 (user32, gdi32)；非 Windows 或加载失败抛 OSError。"""
    global _user32, _gdi32
    if sys.platform != "win32":
        raise OSError("截图只支持 Windows")
    if _user32 is None:
        _user32 = ctypes.WinDLL("user32", use_last_error=True)
    if _gdi32 is None:
        _gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    return _user32, _gdi32


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
        ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def grab(hwnd: int | None = None, scale: float = 1.0, method: str = "auto") -> tuple[int, int, bytes]:
    """抓一帧，返回 (宽, 高, BGRA 原始字节)。行序自上而下。

    与 ``capture()`` 用同一套 GDI 调用，只是不落盘——PNG 上传和 BMP 调试
    都从这里取数据，避免两处实现慢慢跑偏。
    """
    user32, gdi32 = _libs()
    if hwnd:
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        x, y = rect.left, rect.top
        w, h = rect.right - rect.left, rect.bottom - rect.top
    else:
        x = user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        y = user32.GetSystemMetrics(77)
        w = user32.GetSystemMetrics(78)
        h = user32.GetSystemMetrics(79)
    if w <= 0 or h <= 0:
        raise ValueError("窗口尺寸无效（可能已关闭）")

    hdc = user32.GetDC(None)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    try:
        # method="screen" 直接 BitBlt 屏幕区域（窗口必须在前台）；"auto" 先试 PrintWindow
        ok = 0
        if hwnd and method != "screen":
            ok = user32.PrintWindow(hwnd, mem, 0x00000002)  # PW_RENDERFULLCONTENT
        if not ok or method == "screen":
            gdi32.BitBlt(mem, 0, 0, w, h, hdc, x, y, 0x00CC0020)  # SRCCOPY

        if scale != 1.0:
            sw, sh = max(1, int(w * scale)), max(1, int(h * scale))
            mem2 = gdi32.CreateCompatibleDC(hdc)
            bmp2 = gdi32.CreateCompatibleBitmap(hdc, sw, sh)
            gdi32.SelectObject(mem2, bmp2)
            gdi32.SetStretchBltMode(mem2, 4)  # HALFTONE
            gdi32.StretchBlt(mem2, 0, 0, sw, sh, mem, 0, 0, w, h, 0x00CC0020)
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(mem)
            mem, bmp, w, h = mem2, bmp2, sw, sh

        hdr = BITMAPINFOHEADER()
        hdr.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        hdr.biWidth = w
        hdr.biHeight = -h  # 负数 = 自上而下
        hdr.biPlanes = 1
        hdr.biBitCount = 32
        hdr.biCompression = 0

        buf = ctypes.create_string_buffer(w * 4 * h)
        gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(hdr), 0)
        return w, h, buf.raw
    finally:
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(None, hdc)


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_png(w: int, h: int, bgra: bytes) -> bytes:
    """BGRA（GDI 的 32 位格式）→ PNG 字节。

    去掉 alpha 通道写 24 位 RGB：二维码/截图不需要透明度，而 24 位能省 1/4 体积。
    GDI 的像素顺序是 B,G,R,A，PNG 要 R,G,B。
    """
    rows = bytearray()
    stride = w * 4
    for y in range(h):
        base = y * stride
        row = bytearray(b"\x00")  # filter type 0 = None
        for x in range(base, base + stride, 4):
            row += bgra[x + 2 : x + 3]  # R
            row += bgra[x + 1 : x + 2]  # G
            row += bgra[x : x + 1]      # B
        rows += row
    header = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8bit / truecolor
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + _chunk(b"IEND", b"")
    )


def png_base64(hwnd: int | None = None, scale: float = 1.0, method: str = "auto") -> tuple[str, int, int]:
    """抓一帧并编码成 PNG 的 base64。返回 (base64, 宽, 高)。

    上传给服务端存的是 base64 而不是原始字节：桥接接口全是 JSON。
    """
    w, h, raw = grab(hwnd, scale=scale, method=method)
    return base64.b64encode(encode_png(w, h, raw)).decode("ascii"), w, h


def capture(path: str, hwnd: int | None = None, scale: float = 1.0, method: str = "auto") -> tuple[int, int]:
    """沿用原行为：把一帧写成 BMP 落盘。"""
    w, h, buf = grab(hwnd, scale=scale, method=method)

    hdr = BITMAPINFOHEADER()
    hdr.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    hdr.biWidth = w
    hdr.biHeight = -h
    hdr.biPlanes = 1
    hdr.biBitCount = 32
    hdr.biCompression = 0

    header_size = 14 + 40
    with open(path, "wb") as f:
        f.write(b"BM")
        f.write((header_size + len(buf)).to_bytes(4, "little"))
        f.write(b"\x00\x00\x00\x00")
        f.write(header_size.to_bytes(4, "little"))
        f.write(bytes(hdr))
        f.write(buf)
    return w, h


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "shot.bmp"
    hwnd = int(sys.argv[2], 16) if len(sys.argv) > 2 else None
    print("saved", out, capture(out, hwnd))

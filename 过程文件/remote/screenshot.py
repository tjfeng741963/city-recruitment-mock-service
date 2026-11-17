"""纯 ctypes 截屏（不依赖 PIL），输出 BMP。用于排查键鼠自动化是否点对地方。"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes as wt

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
        ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def capture(path: str, hwnd: int | None = None, scale: float = 1.0, method: str = "auto") -> tuple[int, int]:
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

    hdc = user32.GetDC(None)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
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

    stride = w * 4
    buf = ctypes.create_string_buffer(stride * h)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(hdr), 0)

    header_size = 14 + 40
    with open(path, "wb") as f:
        f.write(b"BM")
        f.write((header_size + len(buf.raw)).to_bytes(4, "little"))
        f.write(b"\x00\x00\x00\x00")
        f.write(header_size.to_bytes(4, "little"))
        f.write(bytes(hdr))
        f.write(buf.raw)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(None, hdc)
    return w, h


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "shot.bmp"
    hwnd = int(sys.argv[2], 16) if len(sys.argv) > 2 else None
    print("saved", out, capture(out, hwnd))

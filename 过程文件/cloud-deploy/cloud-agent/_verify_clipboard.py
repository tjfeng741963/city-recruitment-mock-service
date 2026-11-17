# -*- coding: utf-8 -*-
"""远端剪贴板验证脚本：标记解析 → 文件查找 → 剪贴板写入/读回校验（不真发）。"""
import struct
import sys

sys.path.insert(0, r"C:\agent")
from wecom_io_core import send  # noqa: E402

text = "宿舍实拍【图片:松下宿舍】工资稳定【视频:焊工工作】"
body, medias = send.split_media_marks(text)
print("解析 body =", repr(body))
print("解析 medias =", medias)

found = {name: send.find_media(name) for _, name in medias}
for name, p in found.items():
    print("查找", name, "->", p)

import win32clipboard  # noqa: E402

fmt_png = send._png_clipboard_format()

# 图片：写 DIB+PNG，读回校验
p = found["松下宿舍"]
fmt_used = send.set_clipboard_image(p)
print("图片写入格式:", fmt_used)
win32clipboard.OpenClipboard()
try:
    dib = (
        win32clipboard.GetClipboardData(win32clipboard.CF_DIB)
        if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_DIB)
        else None
    )
    png = win32clipboard.GetClipboardData(fmt_png)
    if dib:
        bisize = struct.unpack("<I", dib[:4])[0]
        w, h = struct.unpack("<ii", dib[4:12])
        print(f"DIB 读回 OK: biSize={bisize} 宽={w} 高={h} 字节数={len(dib)}")
    else:
        print("DIB 读回: 不存在")
    same = png is not None and bytes(png) == p.read_bytes()
    print("PNG 读回:", "OK（与源文件字节一致）" if same else "FAIL")
finally:
    win32clipboard.CloseClipboard()

# 视频：CF_HDROP 写文件路径列表，读回校验
pv = found["焊工工作"]
send.set_clipboard_files([pv])
win32clipboard.OpenClipboard()
try:
    data = win32clipboard.GetClipboardData(win32clipboard.CF_HDROP)
    paths = [str(x) for x in data]
    print("CF_HDROP 读回:", paths, "匹配:", paths == [str(pv)])
finally:
    win32clipboard.CloseClipboard()

print("VERIFY_DONE")

"""企微原生位置卡：按坐标生成并发送（2026-11-25 实测通过）。

背景
----
企微 PC 端没有「发送位置」入口，也没有公开接口，过去只能回一段文字 + 高德链接。
实测发现位置消息有两层结构：

  剪贴板自定义格式 `WeWork Message`（353 字节）
    = 41 字节 Boost 头（"22 serialization::archive 19 0 0 1 0 <长度> "）
    + 外层 protobuf
        field1..7   消息元数据（内容类型 0x38 06 = 6 位置）
        field8      0x42 <len> <位置消息 protobuf>   ← 与 message_table.content 完全一致
        field9..   签名等外壳字段

而位置消息 protobuf 本身极简单（从库里 content_type=6 的原始字节反推）：

  09 <lng: float64 LE> 11 <lat: float64 LE>
  1a <len> <地址 UTF-8> 22 <len> <名称 UTF-8>
  29 <8 字节 0> 32 00

所以只要保留一份真实卡片的外壳（PREFIX/SUFFIX），替换 field8 的内容，
就能为任意坐标生成一张**能正常发送的原生卡**——不需要收藏、不需要转发、
不需要人工复制，也不用改企微任何配置。

2026-11-25 在 134 上实测：合成「冠宇商务中心」(113.39114, 23.117692) 的卡
发给青冥，客户收到的是可点开导航的原生地图卡。

风险与约束
----------
- 外壳里的签名来自一条真实消息，重复使用是否会被风控尚未长期验证，
  因此发送频率沿用现有回复节奏（一次回复最多一张卡），不做批量群发。
- 粘贴动作序列与 paste_media 完全一致（抢前台 → 等可见 → 点输入框 →
  写剪贴板 → Ctrl+V → 等可见 → 回车），不新增任何点击/键盘类别。
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
import struct
import time
from typing import Callable

from wecom_io_core import send as core_send
from wecom_io_core import win

# 外壳常量：取自一条真实位置消息复制出来的剪贴板字节（去掉 field8 后的前后两段）。
# 单独存成常量，客户端不需要任何外部文件。
_PREFIX = base64.b64decode("CJSYPRCwu5oDGAAgsO7DvZaAgAMooITO25iAgAMwADgG")
_SUFFIX = base64.b64decode(
    "SgBQoITO25iAgANYAWCa45XYBmiCgAhwgYAEehxDQUVRbXVPVjJBWVlzTzdEdlphQWdBTWdCdz09"
    "ggEAogFqoj8IuAH8hY/qoDSqvgFbCiCp/x0aSSWbE8tFnjdYnA6jjxFh+q5eIlxt0IOqwSihQhAG"
    "GjUI9fSY2AYQBBocQ0FFUW11T1YyQVlZc083RHZaYUFnQU1nQnc9PSICEAAwsO7DvZaAgAM4AagB"
    "ALABAAo="
)
_HEADER_PREFIX = "22 serialization::archive 19 0 0 1 0 "
_GMEM_MOVEABLE = 0x0002
_CLIP_FORMAT = "WeWork Message"

_user32 = None
_kernel32 = None
try:
    # 非 Windows（CI 的 ubuntu runner）没有 WinDLL：模块要能导入，
    # build_card 是纯字节运算，照样可以在 Linux 上跑测试；只有 send_card 需要窗口。
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _user32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
    _user32.SetClipboardData.restype = wt.HANDLE
    _user32.RegisterClipboardFormatW.argtypes = [ctypes.c_wchar_p]
    _user32.RegisterClipboardFormatW.restype = wt.UINT
    _kernel32.GlobalAlloc.restype = wt.HGLOBAL
    _kernel32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
    _kernel32.GlobalLock.restype = ctypes.c_void_p
    _kernel32.GlobalLock.argtypes = [wt.HGLOBAL]
    _kernel32.GlobalUnlock.argtypes = [wt.HGLOBAL]
except (AttributeError, OSError):  # pragma: no cover - 只在非 Windows 触发
    _user32 = None
    _kernel32 = None


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def build_card(lng: float, lat: float, address: str, name: str) -> bytes:
    """按坐标/地址/名称生成一张原生位置卡的剪贴板字节。"""
    addr = (address or "").encode("utf-8")
    label = (name or "").encode("utf-8")
    inner = (
        b"\x09" + struct.pack("<d", float(lng))
        + b"\x11" + struct.pack("<d", float(lat))
        + b"\x1a" + _varint(len(addr)) + addr
        + b"\x22" + _varint(len(label)) + label
        + b"\x29" + b"\x00" * 8
        + b"\x32\x00"
    )
    payload = _PREFIX + b"\x42" + _varint(len(inner)) + inner + _SUFFIX
    header = (_HEADER_PREFIX + str(len(payload)) + " ").encode("ascii")
    return header + payload


def _set_clipboard(blob: bytes) -> bool:
    """写 WeWork Message 自定义格式。必须先 OpenClipboard，否则 SetClipboardData 静默失败。"""
    if _user32 is None or _kernel32 is None:
        return False
    opened = False
    for _ in range(6):
        if _user32.OpenClipboard(0):
            opened = True
            break
        time.sleep(0.12)
    if not opened:
        return False
    try:
        _user32.EmptyClipboard()
        fmt = _user32.RegisterClipboardFormatW(ctypes.c_wchar_p(_CLIP_FORMAT))
        if not fmt:
            return False
        handle = _kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(blob))
        if not handle:
            return False
        ptr = _kernel32.GlobalLock(handle)
        ctypes.memmove(ptr, blob, len(blob))
        _kernel32.GlobalUnlock(handle)
        return bool(_user32.SetClipboardData(fmt, handle))
    finally:
        _user32.CloseClipboard()


def send_card(
    lng: float,
    lat: float,
    address: str,
    name: str,
    log: Callable[[str], None] = lambda _s: None,
) -> tuple[bool, str]:
    """把位置卡粘进**当前已打开**的会话并回车。

    与 paste_media 同一套动作序列：抢前台 → 等可见 → 点输入框 → 写剪贴板 →
    Ctrl+V → 等可见 → 回车。失败只返回原因，不抛异常、不影响已发文本。
    """
    try:
        blob = build_card(lng, lat, address, name)
    except Exception as exc:  # noqa: BLE001
        return False, f"生成位置卡失败：{type(exc).__name__}: {exc}"

    target = win.find_window()
    if not target:
        return False, "没找到企业微信窗口"
    hwnd = target["hwnd"]
    try:
        if not win.ensure_foreground(hwnd, tries=4):
            return False, "抢不到前台，位置卡中止"
        blocked = core_send._wait_visible(hwnd, "位置卡粘贴前")
        if blocked:
            return False, "企微窗口持续隐藏，位置卡中止"
        time.sleep(0.2)
        left, top, w, h = target["rect"]
        win.click(int(left + w * 0.45), int(top + h * 0.86))
        time.sleep(0.2)
        if not _set_clipboard(blob):
            return False, "写剪贴板失败"
        win.hotkey("ctrl", "v")
        time.sleep(1.0)
        blocked = core_send._wait_visible(hwnd, "位置卡发送前")
        if blocked:
            return False, "企微窗口持续隐藏，位置卡发送中止"
        win.tap("enter")
        time.sleep(0.4)
        log(f"[位置卡] {name} {lng},{lat} 已回车发送")
        return True, f"已发送位置卡 {name}"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        try:
            win.release_modifiers()
        except Exception:
            pass

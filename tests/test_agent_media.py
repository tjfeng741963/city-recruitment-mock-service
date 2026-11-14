"""G2 媒体发送：标记解析 + 媒体查找 + 剪贴板写入（mock win32，不真发）。

send.py 顶层 `from . import win` 会拉起 pywin32；这里在导入前先把 win32*
模块替换成假模块，保证根 tests/ 的 pytest 环境可直接跑。
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest import mock

import pytest

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
sys.path.insert(0, str(AGENT_DIR))

# ── 在导入 wecom_io_core 前替换 pywin32 模块 ────────────────────────────────


class FakeWin32Clipboard(types.ModuleType):
    """记录 Open/Empty/Set/Close 调用的假 win32clipboard。"""

    CF_HDROP = 15

    def __init__(self):
        super().__init__("win32clipboard")
        self.ops: list = []

    def OpenClipboard(self):
        self.ops.append("open")
        return True

    def EmptyClipboard(self):
        self.ops.append("empty")

    def CloseClipboard(self):
        self.ops.append("close")

    def SetClipboardData(self, fmt, data):
        self.ops.append(("set", fmt, data))

    def RegisterClipboardFormat(self, name):
        self.ops.append(("regfmt", name))
        return 49173  # 假的已注册格式 id


FAKE_CLIPBOARD = FakeWin32Clipboard()
for _name in ("win32api", "win32con", "win32gui", "win32process"):
    sys.modules[_name] = mock.MagicMock()
sys.modules["win32clipboard"] = FAKE_CLIPBOARD

from wecom_io_core import send  # noqa: E402


class FakeLog:
    def __init__(self):
        self.lines: list[str] = []

    def __call__(self, msg: str) -> None:
        self.lines.append(msg)


class FakeWin:
    """假 core.win：只记录动作，不碰真实键鼠窗口。"""

    def __init__(self):
        self.events: list[tuple] = []

    def find_window(self):
        return {"hwnd": 123, "rect": (0, 0, 1000, 800)}

    def ensure_foreground(self, hwnd, tries=4):
        return True

    def click(self, x, y):
        self.events.append(("click", x, y))

    def hotkey(self, *names):
        self.events.append(("hotkey", names))

    def tap(self, name):
        self.events.append(("tap", name))

    def release_modifiers(self):
        pass


@pytest.fixture
def media_env(tmp_path, monkeypatch):
    d = tmp_path / "media"
    d.mkdir(parents=True)
    monkeypatch.setenv("AGENT_MEDIA_DIR", str(d))
    return d


# ── 标记解析 ────────────────────────────────────────────────────────────────

def test_split_marks_extracts_pairs_in_order():
    body, medias = send.split_media_marks("你好【图片:松下宿舍】看看宿舍【视频:焊工工作】谢谢")
    assert body == "你好看看宿舍谢谢"
    assert medias == [("图片", "松下宿舍"), ("视频", "焊工工作")]


def test_split_marks_strips_name_whitespace():
    _, medias = send.split_media_marks("【图片: 松下宿舍 】")
    assert medias == [("图片", "松下宿舍")]


def test_no_marks_returns_text_untouched():
    text = "普通回复，没有标记"
    body, medias = send.split_media_marks(text)
    assert body == text
    assert medias == []


def test_split_marks_collapses_blank_lines_left_by_marks():
    body, _ = send.split_media_marks("第一行\n【图片:x】\n\n\n\n第二行")
    assert body == "第一行\n\n第二行"


def test_split_marks_empty_text():
    assert send.split_media_marks("") == ("", [])
    assert send.split_media_marks(None) == ("", [])  # type: ignore[arg-type]


# ── 媒体查找 ────────────────────────────────────────────────────────────────

def test_find_media_finds_exact_name(media_env):
    (media_env / "松下宿舍.jpg").write_bytes(b"x")
    found = send.find_media("松下宿舍")
    assert found == media_env / "松下宿舍.jpg"


def test_find_media_ext_priority_jpg_before_png(media_env):
    (media_env / "图.png").write_bytes(b"x")
    (media_env / "图.jpg").write_bytes(b"x")
    assert send.find_media("图").suffix == ".jpg"


def test_find_media_missing_returns_none_and_creates_dir(media_env):
    assert send.find_media("不存在") is None
    assert media_env.is_dir()  # 目录缺失时兜底创建


def test_find_media_rejects_path_traversal(media_env):
    assert send.find_media("../escape") is None
    assert send.find_media("") is None


def test_find_media_ignores_wrong_ext(media_env):
    (media_env / "松下宿舍.txt").write_bytes(b"x")
    assert send.find_media("松下宿舍") is None


# ── 剪贴板写入（假 win32clipboard）──────────────────────────────────────────

def test_set_clipboard_files_uses_hdrop(media_env):
    import struct

    p = media_env / "焊工工作.mp4"
    p.write_bytes(b"v")
    send.set_clipboard_files([p])
    sets = [op for op in FAKE_CLIPBOARD.ops if isinstance(op, tuple) and op[0] == "set"]
    assert sets == [("set", 15, sets[0][2])]  # CF_HDROP=15，单次写入
    data = sets[0][2]
    assert isinstance(data, bytes)
    p_files = struct.unpack("<I", data[:4])[0]      # DROPFILES.pFiles
    f_wide = struct.unpack("<I", data[16:20])[0]    # DROPFILES.fWide=1
    assert p_files == 20 and f_wide == 1
    names = data[p_files:].decode("utf-16-le").rstrip("\0").split("\0")
    assert names == [str(p)]
    assert FAKE_CLIPBOARD.ops.count("open") == FAKE_CLIPBOARD.ops.count("close")


def test_set_clipboard_image_dib_and_png(media_env, monkeypatch):
    monkeypatch.setattr(send, "_dib_from_image", lambda p: b"FAKEDIB")
    p = media_env / "松下宿舍.jpg"
    p.write_bytes(b"pngbytes")
    assert send.set_clipboard_image(p) == "DIB+PNG"
    sets = [op for op in FAKE_CLIPBOARD.ops if isinstance(op, tuple) and op[0] == "set"]
    assert ("set", 8, b"FAKEDIB") in sets          # CF_DIB
    assert ("set", 49173, b"pngbytes") in sets     # 注册的 PNG 格式
    assert any(op == ("regfmt", "PNG") for op in FAKE_CLIPBOARD.ops)


def test_set_clipboard_image_png_only_without_dib(media_env, monkeypatch):
    monkeypatch.setattr(send, "_dib_from_image", lambda p: None)
    p = media_env / "松下宿舍.png"
    p.write_bytes(b"pngbytes")
    assert send.set_clipboard_image(p) == "PNG"


# ── paste_media：动作序列与回退 ─────────────────────────────────────────────

def test_paste_media_missing_file_only_logs(media_env, monkeypatch):
    fake_win = FakeWin()
    monkeypatch.setattr(send, "win", fake_win)
    log = FakeLog()
    ok, detail = send.paste_media("松下宿舍", log=log)
    assert ok is False
    assert "未找到 松下宿舍" in detail
    assert any("[媒体] 未找到 松下宿舍" in line for line in log.lines)
    assert fake_win.events == []  # 没碰键鼠


def test_paste_media_video_full_sequence(media_env, monkeypatch):
    p = media_env / "焊工工作.mp4"
    p.write_bytes(b"v")
    fake_win = FakeWin()
    monkeypatch.setattr(send, "win", fake_win)
    monkeypatch.setattr(send, "_wait_visible", lambda hwnd, stage: None)
    ok, detail = send.paste_media("焊工工作", log=FakeLog())
    assert ok is True
    assert detail == "已发送 焊工工作.mp4"
    seq = [e[0] for e in fake_win.events]
    assert seq == ["click", "hotkey", "tap"]
    assert fake_win.events[1][1] == ("ctrl", "v")
    assert fake_win.events[2][1] == "enter"
    # CF_HDROP 真的写进了（假）剪贴板：DROPFILES 宽字符路径表
    sets = [op for op in FAKE_CLIPBOARD.ops if isinstance(op, tuple) and op[0] == "set"]
    data = sets[-1][2]
    assert sets[-1][:2] == ("set", 15)
    assert str(p) in data.decode("utf-16-le")


def test_paste_media_image_full_sequence(media_env, monkeypatch):
    (media_env / "松下宿舍.jpg").write_bytes(b"i")
    monkeypatch.setattr(send, "_dib_from_image", lambda p: b"DIB")
    fake_win = FakeWin()
    monkeypatch.setattr(send, "win", fake_win)
    monkeypatch.setattr(send, "_wait_visible", lambda hwnd, stage: None)
    ok, _ = send.paste_media("松下宿舍", log=FakeLog())
    assert ok is True
    assert fake_win.events[1][1] == ("ctrl", "v")
    assert fake_win.events[2][1] == "enter"


def test_paste_media_clipboard_error_fails_cleanly(media_env, monkeypatch):
    (media_env / "焊工工作.mp4").write_bytes(b"v")
    fake_win = FakeWin()
    monkeypatch.setattr(send, "win", fake_win)
    monkeypatch.setattr(send, "_wait_visible", lambda hwnd, stage: None)
    monkeypatch.setattr(
        send, "set_clipboard_files",
        mock.MagicMock(side_effect=RuntimeError("写文件剪贴板失败")),
    )
    ok, detail = send.paste_media("焊工工作", log=FakeLog())
    assert ok is False
    assert "RuntimeError" in detail  # 异常被吞成 (False, 原因)，不冒泡

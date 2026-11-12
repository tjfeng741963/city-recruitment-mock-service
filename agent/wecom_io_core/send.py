"""发送：严格照搬 wecom-group-sender 的动作序列。

动作序列（与原项目一一对应，不额外加键）：
  0. 检查 WXWork.exe 是否存活 → 激活窗口 → 等可见
  1. Ctrl+F                          唤出搜索
  2. Ctrl+A → Ctrl+V                 粘贴会话名（先全选，避免与上次搜索拼接）
  3. 等搜索结果                       search_delay
  4. Enter                           进第一个搜索结果
  5. Ctrl+A → Delete                 清空输入框残留草稿（焦点此时在输入框）
  6. 等可见 → Ctrl+V                 粘贴正文
  7. Ctrl+A → Ctrl+C 回读            哨兵法确认字真的进了输入框
  8. 等可见 → Enter                  发送
  外层整体重试 2 次；任一步失败先 Esc + 释放修饰键再退出。

与原项目的唯一差异：发送后用解密库（含 WAL）回读，确认消息真的落到目标会话。
这是本项目「读 + 写」合体的价值所在，不额外产生任何按键。

⚠️ 本模块会模拟键鼠，属于企业微信协议的违规操作，实测会触发风控处置。
"""
from __future__ import annotations

import io
import os
import re
import struct
import time
from pathlib import Path
from typing import Callable

from . import win

SENTINEL = "__WECOM_IO_SENTINEL__"
FAST_MODE = True           # 与原项目一致：单条 5 秒内结束，快于风控 9 秒处置窗口
SEARCH_DELAY = 0.8         # 粘贴会话名后等搜索结果
RESULT_DELAY = 1.0         # 回车进会话后等渲染
MAX_ATTEMPTS = 2           # 原项目 FAST_MODE 下也是 2 次整段重试


def _log_default(msg: str) -> None:
    print(msg, flush=True)


def _norm(s: str) -> str:
    """企微输入框是富文本，回车会被规范成 \r\n，比对时统一。"""
    return (s or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _esc_cleanup(hwnd: int) -> None:
    """原项目 esc_cleanup：Esc 关掉搜索框，再释放可能卡住的修饰键。"""
    try:
        win.tap("esc")
    except Exception:
        pass
    try:
        win.release_modifiers()
    except Exception:
        pass
    time.sleep(0.3)


def _wait_visible(hwnd: int, stage: str) -> str | None:
    """等窗口可见；不可见说明被风控隐藏了，直接返回错误文案。"""
    if win.wait_visible(hwnd, timeout=15.0):
        return None
    return f"企微窗口持续隐藏（{stage}），已中止"


def verify_input_box(text: str, retries: int = 5) -> tuple[bool, str]:
    """原项目 verify_input_box 的等价实现：哨兵法回读输入框。

    先把剪贴板覆盖成哨兵，再 Ctrl+A / Ctrl+C：
      - 读回哨兵 → Ctrl+C 没复制到东西（焦点不在输入框或为空）→ 重试
      - 读回等于正文 → 通过
      - 其他内容 → 焦点在别处（比如消息列表）→ 重试
    """
    sentinel_hit = False
    got = ""
    for attempt in range(retries):
        win.set_clipboard(SENTINEL)
        time.sleep(0.12)
        win.hotkey("ctrl", "a")
        time.sleep(0.2)
        win.hotkey("ctrl", "c")
        time.sleep(0.3)
        got = win.get_clipboard()
        if got and _norm(got) == _norm(text):
            return True, "粘贴已确认"
        if got and got.strip() == SENTINEL:
            sentinel_hit = True
            time.sleep(0.4)
            continue
        sentinel_hit = False
        if attempt < retries - 1:
            time.sleep(0.4)
    if sentinel_hit:
        return False, "焦点未落在输入框（Ctrl+C 未生效，剪贴板仍是哨兵）"
    return False, f"输入框内容不符：{got[:40]!r}"


def _send_once(
    hwnd: int,
    name: str,
    text: str,
    dry: bool,
    log: Callable[[str], None],
) -> tuple[bool, str]:
    """单次完整流程，返回 (ok, status)。对标原项目 _send_once。"""

    # 0. 进程是否还活着（原项目第一步就查这个）
    if not win.wxwork_alive():
        return False, "企业微信已退出，停止发送"

    if not win.ensure_foreground(hwnd, tries=4):
        return False, "抢不到前台，已中止"
    if _wait_visible(hwnd, "激活后") is not None:
        return False, "企微窗口持续隐藏（可能被防自动化机制隐藏），无法发送"
    time.sleep(0.3 if FAST_MODE else 0.5)
    log("步骤0 前台就位、窗口可见")

    # 1. Ctrl+F 唤搜索
    win.hotkey("ctrl", "f")
    time.sleep(0.4 if FAST_MODE else 0.6)

    # 2. 全选 + 粘贴会话名
    win.set_clipboard(name)
    time.sleep(0.1)
    win.hotkey("ctrl", "a")
    time.sleep(0.1)
    win.hotkey("ctrl", "v")

    # 3. 等搜索结果
    time.sleep(SEARCH_DELAY)

    # 4. Enter 进第一个结果
    win.tap("enter")
    time.sleep(RESULT_DELAY)
    log("步骤1 已回车进入会话")

    if dry:
        return True, "DRY-RUN：已进会话，未发送（未清空输入框、未粘贴）"

    # 5. 清空输入框残留草稿（原项目明确：此时焦点默认已在输入框，不要点坐标）
    win.hotkey("ctrl", "a")
    time.sleep(0.08)
    win.tap("delete")
    time.sleep(0.08)
    log("步骤2 已清空输入框残留")

    # 6. 等可见 → 粘贴正文
    if _wait_visible(hwnd, "粘贴前") is not None:
        return False, "企微窗口持续隐藏，粘贴前中止"
    win.set_clipboard(text)
    time.sleep(0.1)
    win.hotkey("ctrl", "v")
    time.sleep(0.3 if FAST_MODE else 0.5)

    # 7. 回读校验
    passed, hint = verify_input_box(text, retries=5)
    if not passed:
        return False, f"输入框校验：{hint}"
    log(f"步骤3 输入框校验通过（{hint}）")

    # 8. 等可见 → Enter 发送
    if _wait_visible(hwnd, "发送前") is not None:
        return False, "企微窗口持续隐藏，发送前中止"
    win.tap("enter")
    time.sleep(0.4 if FAST_MODE else 0.8)
    log("步骤4 已回车发送")
    return True, "已发送"


def send(
    store,
    name: str,
    text: str,
    expect_id: str = "",
    log: Callable[[str], None] = _log_default,
    dry: bool = False,
    verify_db: bool = True,
) -> dict:
    """发一条消息到指定会话，返回 {ok, conversation_id, detail}。"""
    name = (name or "").strip()
    text = (text or "").strip()
    if not name or not text:
        return {"ok": False, "conversation_id": "", "detail": "会话名或内容为空"}

    target = win.find_window()
    if not target:
        return {"ok": False, "conversation_id": "", "detail": "没找到企业微信窗口"}
    hwnd = target["hwnd"]

    log(f"开始发送 -> 「{name}」：{text}")
    before = _sent_snapshot(store) if verify_db and not dry else set()

    ok = False
    status = ""
    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            if attempt > 1:
                log(f"第 {attempt} 次整段重试")
            ok, status = _send_once(hwnd, name, text, dry, log)
            if ok:
                break
            log(f"本轮失败：{status}")
            _esc_cleanup(hwnd)
            time.sleep(0.5)
    finally:
        win.release_modifiers()

    if not ok:
        return {"ok": False, "conversation_id": "", "detail": status}

    if dry:
        return {"ok": True, "conversation_id": "", "detail": status}

    if not verify_db:
        return {"ok": True, "conversation_id": "", "detail": status + "（未回读）"}

    # ---------- 发送后回读解密库（含 WAL），确认落点 ----------
    try:
        store.refresh()
        cid = _find_new_sent(store, text, before)
    except Exception as exc:
        return {"ok": True, "conversation_id": "", "detail": f"已发送但回读失败：{exc}"}

    if not cid:
        return {"ok": True, "conversation_id": "",
                "detail": "已发送，但库里还没读到（WAL 可能有延迟），请人工看一眼"}

    if expect_id and cid != expect_id:
        return {"ok": False, "conversation_id": cid,
                "detail": f"发到了别的会话！期望 {expect_id}，实际 {cid}"}

    log(f"步骤5 回读确认：消息已落到 {cid}")
    return {"ok": True, "conversation_id": cid, "detail": "已发送并回读确认"}


def _sent_snapshot(store) -> set:
    """发送前记录「我」已发出的消息主键，用于发后只找新增的那条。"""
    con = store._conn("message.db")
    if not con:
        return set()
    try:
        me = store.self_id()
        rows = con.execute(
            "select rowid from message_table where sender_id = ? "
            "order by send_time desc limit 200", (me,)
        ).fetchall()
        return {r[0] for r in rows}
    except Exception:
        return set()
    finally:
        con.close()


def _find_new_sent(store, text: str, before: set) -> str:
    """在「我发出的、发送前不存在」的消息里找内容匹配的那条，返回会话 id。"""
    from .store import _pb_text

    con = store._conn("message.db")
    if not con:
        return ""
    try:
        me = store.self_id()
        rows = con.execute(
            "select rowid, conversation_id, content from message_table "
            "where sender_id = ? order by send_time desc limit 200", (me,)
        ).fetchall()
    except Exception:
        rows = []
    finally:
        con.close()

    for r in rows:
        if r["rowid"] in before:
            continue
        if _pb_text(r["content"]).strip() == text:
            return r["conversation_id"]
    return ""


# ═════════════════════════════════════════════════════════════════════════════
# 媒体发送（G2 契约：docs/对齐-数据治理与图片发送.md）
#
# 标记协议：回复文本里写【图片:名称】/【视频:名称】，发送时：
#   1. split_media_marks 剥离标记、拿到剩余文本与媒体清单；
#   2. 先发剩余文本（走上面的 send，动作序列一行不改）；
#   3. 文本发出后逐个 paste_media（图=DIB/PNG 进剪贴板，视频=CF_HDROP 文件列表）；
#   4. 找不到本地文件 → 只发文本 + 日志「[媒体] 未找到 {name}」；
#   5. 任何媒体异常都不影响文本的已发状态（调用方兜底，不回滚、不重发文本）。
#
# 媒体存放：C:\agent\media\{名称}.{jpg|jpeg|png|mp4}，可用环境变量
# AGENT_MEDIA_DIR 覆盖（单测用）。目录不存在时启动即创建。
# ═════════════════════════════════════════════════════════════════════════════

MEDIA_MARK_RE = re.compile(r"【(图片|视频):([^】]{1,80})】")
MEDIA_EXTS = (".jpg", ".jpeg", ".png", ".mp4")
CF_DIB = 8  # win32clipboard.CF_DIB
_PNG_FORMAT: int | None = None


def media_dir() -> Path:
    """媒体目录：默认 C:\\agent\\media，AGENT_MEDIA_DIR 可覆盖（单测）。"""
    return Path(os.environ.get("AGENT_MEDIA_DIR") or r"C:\agent\media")


def ensure_media_dir() -> Path:
    """媒体目录不存在就创建；失败只返回路径，由调用方记日志。"""
    d = media_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return d


def find_media(name: str) -> Path | None:
    """按名称在媒体目录里找 {name}.{jpg|jpeg|png|mp4}，找不到返回 None。"""
    name = (name or "").strip()
    if not name or any(ch in name for ch in ("/", "\\", ":")):
        return None
    d = ensure_media_dir()
    for ext in MEDIA_EXTS:          # 精确匹配优先，扩展名按序
        p = d / f"{name}{ext}"
        if p.is_file():
            return p
    try:                            # 兜底：同主名不同大小写/少见后缀
        for p in d.iterdir():
            if p.is_file() and p.stem == name and p.suffix.lower() in MEDIA_EXTS:
                return p
    except OSError:
        return None
    return None


def split_media_marks(text: str) -> tuple[str, list[tuple[str, str]]]:
    """剥离【图片:名称】/【视频:名称】标记。

    返回 (剩余文本, [(kind, name), ...])，媒体按出现顺序排列；
    剩余文本压掉标记删除后留下的连续空行并去首尾空白。
    """
    text = text or ""
    medias = [(m.group(1), m.group(2).strip()) for m in MEDIA_MARK_RE.finditer(text)]
    cleaned = MEDIA_MARK_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, medias


def _png_clipboard_format() -> int:
    """注册 PNG 剪贴板格式（进程内缓存）。"""
    import win32clipboard

    global _PNG_FORMAT
    if _PNG_FORMAT is None:
        _PNG_FORMAT = win32clipboard.RegisterClipboardFormat("PNG")
    return _PNG_FORMAT


def _dib_from_image(path: Path) -> bytes | None:
    """jpg/png → CF_DIB 字节（BMP 体，去掉 14 字节文件头）。

    依赖 Pillow；没装就返回 None，调用方退化为只放 PNG 原始字节。
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as img:
            buf = io.BytesIO()
            img.convert("RGB").save(buf, "BMP")
            return buf.getvalue()[14:]
    except Exception:
        return None


def set_clipboard_image(path: Path) -> str:
    """把图片写进剪贴板（DIB + PNG 双格式，企微认哪个用哪个）。返回格式说明。"""
    import win32clipboard

    dib = _dib_from_image(path)
    png = path.read_bytes()
    fmt_png = _png_clipboard_format()
    last_err: Exception | None = None
    for _ in range(40):  # 向日葵最长占剪贴板约 5 秒
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                if dib:
                    win32clipboard.SetClipboardData(CF_DIB, dib)
                win32clipboard.SetClipboardData(fmt_png, png)
            finally:
                win32clipboard.CloseClipboard()
            return "DIB+PNG" if dib else "PNG"
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.12)
    raise RuntimeError(f"写图片剪贴板失败：{last_err}")


def set_clipboard_files(paths: list[Path]) -> None:
    """把文件路径列表写进剪贴板（CF_HDROP），企微输入框可直接粘贴文件。

    pywin32 的 SetClipboardData 不接受 list（报 bytes-like required），
    这里手工构造 DROPFILES 结构：头 20 字节（pFiles=20, pt=(0,0), fNC=0,
    fWide=1）+ 双 \\0 结尾的宽字符路径表，按 HGLOBAL 内容体传入。
    """
    import win32clipboard

    targets = [str(p) for p in paths]
    payload = struct.pack("IiiII", 20, 0, 0, 0, 1)  # DROPFILES 头
    payload += b"".join((t + "\0").encode("utf-16-le") for t in targets) + b"\0\0"
    last_err: Exception | None = None
    for _ in range(40):
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_HDROP, payload)
            finally:
                win32clipboard.CloseClipboard()
            return
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.12)
    raise RuntimeError(f"写文件剪贴板失败：{last_err}")


def paste_media(name: str, log: Callable[[str], None] = _log_default) -> tuple[bool, str]:
    """把 media/{name}.* 粘贴进当前会话并回车发送。

    调用时机：文本 send() 刚成功、目标会话已打开。动作序列照现有输入框
    动作精简（会话已在）：抢前台 → 等可见 → 点输入框 → 写剪贴板 →
    Ctrl+V → 等可见 → 回车。图片无法哨兵回读，发送确认靠等待窗口可见。

    失败不影响文本已发状态：只返回 (False, 原因)，不抛异常不碰文本。
    """
    ensure_media_dir()
    path = find_media(name)
    if path is None:
        log(f"[媒体] 未找到 {name}（目录 {media_dir()}）")
        return False, f"未找到 {name}"

    kind = "视频" if path.suffix.lower() == ".mp4" else "图片"
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    log(f"[媒体] {kind}:{name} → {path.name}（{size} 字节）")

    target = win.find_window()
    if not target:
        return False, "没找到企业微信窗口"
    hwnd = target["hwnd"]
    try:
        if not win.ensure_foreground(hwnd, tries=4):
            return False, "抢不到前台，媒体粘贴中止"
        if _wait_visible(hwnd, "媒体粘贴前") is not None:
            return False, "企微窗口持续隐藏，媒体粘贴中止"
        time.sleep(0.2)
        # 焦点到输入框（比例与 compat.CLICK_INPUT_RATIO 一致：0.45, 0.86）
        left, top, w, h = target["rect"]
        win.click(int(left + w * 0.45), int(top + h * 0.86))

        if kind == "视频":
            set_clipboard_files([path])
        else:
            fmt = set_clipboard_image(path)
            log(f"[媒体] 剪贴板格式 {fmt}")
        time.sleep(0.15)
        win.hotkey("ctrl", "v")
        time.sleep(1.0)  # 图片/视频渲染比文本慢
        if _wait_visible(hwnd, "媒体发送前") is not None:
            return False, "企微窗口持续隐藏，媒体发送中止"
        win.tap("enter")
        time.sleep(0.4)
        log(f"[媒体] {kind}:{name} 已回车发送")
        return True, f"已发送 {path.name}"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        try:
            win.release_modifiers()
        except Exception:
            pass

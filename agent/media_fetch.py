"""媒体预取：把服务端素材下到本地 `C:\\agent\\media`，供现有的粘贴发送链路使用。

为什么需要这一层：`wecom_io_core/send.py` 的 `paste_media()` 只会按文件名在
本地媒体目录里找文件，**不发 HTTP**。服务端把素材放在 `/api/v1/agent/media/<name>`，
所以"发送前先把缺的补到本地"这件事必须由客户端自己完成，且不能改动已验证的发送实现。

三条硬约束：

1. **已有就不下**。同名文件存在且大小 > 0 直接跳过——素材是人工上传的静态资源，
   每次发送都重下既慢又多余；服务端确实换了内容时靠 sha256 校验兜底。
2. **半截文件不算可用**。下载写 `.part` 临时文件，校验通过后 `os.replace` 改名，
   避免下载中断留下的残缺文件被下一次发送当成"已存在"。
3. **失败只跳过这一个是媒体**。任何异常都返回 (False, 原因)，由调用方记日志后
   继续发文字——一条素材下载失败不能让整条回复丢失。

鉴权：`Authorization: Bearer <device_token>`（客户端凭证，见 config.json）。
httpx 必须 `trust_env=False`：本机 `HTTP_PROXY` 会拦 `127.0.0.1`。
"""

from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Callable
from urllib.parse import quote

import httpx

# 与 wecom_io_core/send.py 的 media_dir() 保持一致：同一目录、同一套后缀顺序，
# 否则这里下完，find_media() 还是找不到。AGENT_MEDIA_DIR 覆盖用于单测。
MEDIA_EXTS = (".jpg", ".jpeg", ".png", ".mp4")
IMAGE_EXTS = (".jpg", ".jpeg", ".png")
VIDEO_EXTS = (".mp4",)

# 视频可能几十兆，60s 是"够用且不会把主循环挂死"的折中；连不上的情况由 connect 超时兜。
DEFAULT_TIMEOUT = 60.0


def media_dir() -> Path:
    return Path(os.environ.get("AGENT_MEDIA_DIR") or r"C:\agent\media")


def _log_default(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _safe_name(name: str) -> str:
    """标记里的名称直接拼路径前先挡目录穿越：只允许纯文件名。"""
    name = (name or "").strip()
    if not name or any(ch in name for ch in ("/", "\\", ":")):
        return ""
    return name


def local_file(name: str, directory: Path | None = None) -> Path | None:
    """按"标记名"找本地文件，语义与 send.find_media 一致（名称不带后缀）。

    命中条件：文件存在且大小 > 0。0 字节文件视为上一次下载失败留下的残骸，
    不返回（交给下载流程覆盖）。
    """
    name = _safe_name(name)
    if not name:
        return None
    d = directory or media_dir()
    candidates: list[Path] = [d / name]
    if Path(name).suffix.lower() not in MEDIA_EXTS:
        candidates += [d / f"{name}{ext}" for ext in MEDIA_EXTS]
    for p in candidates:
        try:
            if p.is_file() and p.stat().st_size > 0:
                return p
        except OSError:
            continue
    return None


def _url_candidates(name: str, kind: str) -> list[str]:
    """服务端文件名可能带后缀也可能不带，按类型顺序试。

    标记协议里名称不带后缀（【图片:岗位图】），而服务端是按真实文件名存的
    （岗位图.jpg），所以先按原名请求，404 再按类型补后缀重试。
    """
    if Path(name).suffix.lower() in MEDIA_EXTS:
        return [name]
    exts = VIDEO_EXTS if kind == "视频" else IMAGE_EXTS
    return [name] + [f"{name}{ext}" for ext in exts]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_media(
    name: str,
    kind: str = "图片",
    *,
    base_url: str,
    token: str,
    timeout: float = DEFAULT_TIMEOUT,
    directory: Path | None = None,
    log: Callable[[str], None] = _log_default,
) -> tuple[bool, str]:
    """保证 `name` 在本地可用。返回 (ok, 说明)，ok=False 时调用方跳过该条媒体。

    返回值只描述这一条媒体，绝不抛异常——主循环不允许因为一张图崩掉。
    """
    try:
        safe = _safe_name(name)
        if not safe:
            return False, "名称非法（含路径分隔符）"

        d = directory or media_dir()
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return False, f"媒体目录不可写：{exc}"

        found = local_file(safe, d)
        if found is not None:
            # 约束 3：本地已有且非空就不再请求，避免每次发送都重复下载。
            return True, f"本地已存在 {found.name}（{found.stat().st_size} B）"

        base = (base_url or "").rstrip("/")
        if not base:
            return False, "未配置 server，无法下载"
        if not token:
            return False, "未配置 device_token，无法下载"

        last_detail = "未尝试"
        # trust_env=False 是本机的硬要求：HTTP_PROXY 会把 127.0.0.1 也代理掉。
        with httpx.Client(timeout=timeout, trust_env=False, follow_redirects=True) as client:
            for cand in _url_candidates(safe, kind):
                url = f"{base}/api/v1/agent/media/{quote(cand, safe='')}"
                try:
                    resp = client.get(url, headers={"Authorization": f"Bearer {token}"})
                except Exception as exc:  # noqa: BLE001
                    # 网络层失败重试别的后缀没意义，直接放弃这一条
                    return False, f"{type(exc).__name__}: {exc}"

                if resp.status_code == 404:
                    last_detail = f"HTTP 404（{cand}）"
                    continue
                if resp.status_code != 200:
                    return False, f"HTTP {resp.status_code}: {resp.text[:80]}"

                body = resp.content
                if not body:
                    last_detail = f"服务端返回空文件（{cand}）"
                    continue

                expect = (resp.headers.get("X-Content-SHA256") or "").strip().lower()
                actual = hashlib.sha256(body).hexdigest()
                if expect and expect != actual:
                    # 内容不一致说明传输被截断/串包，宁可不发也不发错图
                    return False, f"sha256 校验失败（期望 {expect[:12]}… 实际 {actual[:12]}…）"
                if not expect:
                    log(f"    [媒体] {cand} 无 X-Content-SHA256，本地校验值 {actual[:16]}…")

                target = d / cand
                part = target.with_name(target.name + ".part")
                try:
                    part.write_bytes(body)
                    # 先落盘再改名：中途异常只会留下 .part，不会被 find_media 当成素材
                    os.replace(part, target)
                except OSError as exc:
                    try:
                        part.unlink(missing_ok=True)
                    except OSError:
                        pass
                    return False, f"写入失败：{exc}"

                return True, f"已下载 {target.name}（{len(body)} B）"
        return False, f"服务端没有该素材：{last_detail}"
    except Exception as exc:  # noqa: BLE001
        return False, f"异常：{type(exc).__name__}: {exc}"


def prefetch(
    medias: list[tuple[str, str]],
    *,
    base_url: str,
    token: str,
    log: Callable[[str], None] = _log_default,
) -> dict[str, bool]:
    """批量预取一段回复里的全部媒体标记，返回 {名称: 是否可用}。

    同名只请求一次（一段回复里同一张图出现两次很常见）。
    """
    result: dict[str, bool] = {}
    for kind, name in medias:
        if name in result:
            continue
        ok, detail = ensure_media(name, kind, base_url=base_url, token=token, log=log)
        result[name] = ok
        log(f"    [媒体] 预取 {kind}:{name} {'就绪' if ok else '跳过'}：{detail}")
    return result

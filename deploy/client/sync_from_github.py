"""客户端从 git 取代码并更新（不需要本机装 git）。

背景：客户端机器 `C:\\agent` 一直是「别人手工拷文件」更新的，结果代码与
`origin/main` 漂移（2026-11-15 实测：autopilot/client/screenshot 三个文件比
main 旧一个提交，缺扫码上传）。这个脚本把更新动作固定成：

    从 GitHub 取指定 ref 的 tar 包 → 只覆盖 agent/ 下的 .py
    → 覆盖前逐文件备份 → 不动运行期文件 → 打印差异清单

运行期文件一律不碰：`config.json`、`.greeted.json`、`reply_log.db`、
`media/`、`logs/`、`_decrypted/`。`wecom_io_core/` 只按字节覆盖（冻结区，
内容必须与 git 完全一致，不做任何"优化"）。

用法（在客户端机器上跑）：
    python sync_from_github.py --target C:/agent --ref main --dry-run
    python sync_from_github.py --target C:/agent --ref main --apply

单实例：更新本身不启动进程。`run.cmd` 的 `:loop` 会在进程退出后 5 秒自动
拉起新代码；需要立即生效时加 `--restart`（只结束那一个 python 进程，
autopilot 内的命名互斥体会阻止第二个实例）。
"""

from __future__ import annotations

import argparse
import io
import os
import shutil
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

REPO = "tjfeng741963/city-recruitment-mock-service"
TARBALL = "https://codeload.github.com/{repo}/tar.gz/{ref}"
MANIFEST = ("*.py",)


def _norm(data: bytes) -> bytes:
    """比较时忽略 CRLF/LF 差异——客户端文件长期是 CRLF，不代表内容不同。"""
    return data.replace(b"\r\n", b"\n")


def _fetch_payload(ref: str) -> bytes:
    """取 tar 包。优先用系统 curl（Windows 自带，走 schannel 证书链）。

    客户端 Python 常缺 CA 证书，直接 urllib 会 SSLCertVerificationError；
    用系统 curl 既能验证证书，也不用往客户端塞 certifi。
    """
    url = TARBALL.format(repo=REPO, ref=ref)
    if shutil.which("curl"):
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "repo.tar.gz"
            subprocess.run(
                ["curl", "-sSL", "--fail", "-o", str(out), url],
                check=True, timeout=120,
            )
            return out.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "client-sync"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def _fetch(ref: str) -> tarfile.TarFile:
    return tarfile.open(fileobj=io.BytesIO(_fetch_payload(ref)), mode="r:gz")


def _iter_members(archive: tarfile.TarFile):
    """只挑 agent/ 下的 .py（含 wecom_io_core/）。"""
    for member in archive.getmembers():
        if not member.isfile():
            continue
        parts = Path(member.name).parts
        if len(parts) < 3 or parts[1] != "agent":
            continue
        rel = Path(*parts[2:])
        if rel.suffix != ".py":
            continue
        yield member, rel


def sync(target: Path, ref: str, apply: bool) -> int:
    archive = _fetch(ref)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    changed: list[str] = []
    added: list[str] = []
    same = 0
    for member, rel in _iter_members(archive):
        incoming = archive.extractfile(member)
        if incoming is None:
            continue
        data = incoming.read()
        dest = target / rel
        if dest.exists():
            if _norm(dest.read_bytes()) == _norm(data):
                same += 1
                continue
            changed.append(str(rel))
            if apply:
                shutil.copy2(dest, dest.with_name(dest.name + f".bak-{stamp}"))
        else:
            added.append(str(rel))
        if apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
    mode = "APPLY" if apply else "DRY-RUN"
    print(f"[{mode}] ref={ref} target={target}")
    print(f"  未变 {same} 个；更新 {len(changed)} 个；新增 {len(added)} 个")
    for name in changed:
        print(f"  ~ {name}")
    for name in added:
        print(f"  + {name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="C:/agent")
    parser.add_argument("--ref", default="main")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.apply and not args.dry_run:
        print("需要 --apply 或 --dry-run（默认不写盘）", file=sys.stderr)
        return 2
    target = Path(args.target)
    if not target.is_dir():
        print(f"目标目录不存在：{target}", file=sys.stderr)
        return 2
    return sync(target, args.ref, apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())

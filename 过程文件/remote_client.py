"""只读探查 134.175.40.31 客户端机器（凭据从环境变量取，不落盘）。

用法：
  WB_CLIENT_PW=... python 过程文件/remote_client.py "dir C:\\agent"

只执行一条命令并打印 stdout/stderr/exit code，不做任何写入。
"""
from __future__ import annotations

import os
import sys

import paramiko

HOST = os.environ.get("WB_CLIENT_HOST", "134.175.40.31")
USER = os.environ.get("WB_CLIENT_USER", "Administrator")
PW = os.environ.get("WB_CLIENT_PW", "")


def _decode(raw: bytes) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        if "\ufffd" not in text:
            return text
    return raw.decode("utf-8", "replace")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: remote_client.py <command> | --ls <dir> | --cat <file>", file=sys.stderr)
        return 2
    if not PW:
        print("WB_CLIENT_PW not set", file=sys.stderr)
        return 2
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=22, username=USER, password=PW, timeout=15,
                   banner_timeout=20, auth_timeout=20)
    if sys.argv[1] in ("--ls", "--cat", "--tail"):
        sftp = client.open_sftp()
        target = sys.argv[2]
        if sys.argv[1] == "--ls":
            for item in sorted(sftp.listdir_attr(target), key=lambda a: a.filename.lower()):
                kind = "DIR " if item.st_mode & 0o040000 else "FILE"
                print(f"{kind} {item.st_size:>10} {item.filename}")
        elif sys.argv[1] == "--tail":
            lines = int(sys.argv[3]) if len(sys.argv) > 3 else 60
            size = sftp.stat(target).st_size
            with sftp.open(target, "rb") as handle:
                handle.seek(max(size - 200_000, 0))
                data = _decode(handle.read()).splitlines()
            print("\n".join(data[-lines:]))
        else:
            with sftp.open(target, "rb") as handle:
                print(_decode(handle.read()))
        sftp.close()
        client.close()
        return 0
    _, out, err = client.exec_command(sys.argv[1], timeout=90)
    raw_out = out.read()
    raw_err = err.read()
    stdout = _decode(raw_out)
    stderr = _decode(raw_err)
    code = out.channel.recv_exit_status()
    print(stdout)
    if stderr.strip():
        print("[stderr]", stderr, file=sys.stderr)
    print(f"[exit={code}]")
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

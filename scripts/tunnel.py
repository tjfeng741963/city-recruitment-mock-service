"""本地端口转发到服务器（SSH 隧道），断线自动重连。

用途：服务器只开了 22 端口时，客户端（agent）通过隧道访问后端。

    python scripts/tunnel.py --host 1.2.3.4 --user ubuntu --password *** \
        --local-port 18090 --remote-port 8090

启动后访问 http://127.0.0.1:18090 即等于访问服务器的 127.0.0.1:8090。
"""

from __future__ import annotations

import argparse
import socket
import threading
import time

import paramiko


def _pump(src: socket.socket, dst) -> None:
    """单向搬运数据，任一端关闭就收尾。"""
    try:
        while True:
            data = src.recv(8192)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for closer in (dst, src):
            try:
                closer.shutdown(socket.SHUT_WR)
            except Exception:
                pass


def _serve(transport: paramiko.Transport, client: socket.socket, remote: tuple[str, int]) -> None:
    try:
        chan = transport.open_channel(
            "direct-tcpip", remote, client.getpeername(), timeout=10
        )
    except Exception:
        client.close()
        return

    t = threading.Thread(target=_pump, args=(client, chan), daemon=True)
    t.start()
    _pump(chan, client)
    try:
        chan.close()
    finally:
        client.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=22)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--local-port", type=int, default=18090)
    ap.add_argument("--remote-host", default="127.0.0.1")
    ap.add_argument("--remote-port", type=int, default=8090)
    args = ap.parse_args()

    remote = (args.remote_host, args.remote_port)

    while True:
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            server.bind(("127.0.0.1", args.local_port))
            server.listen(64)
        except OSError as exc:
            print(f"[tunnel] 本地端口 {args.local_port} 绑定失败：{exc}", flush=True)
            return 1

        transport = paramiko.Transport((args.host, args.port))
        try:
            transport.connect(username=args.user, password=args.password)
        except Exception as exc:
            print(f"[tunnel] 连接失败：{exc}，5 秒后重试", flush=True)
            server.close()
            time.sleep(5)
            continue

        print(
            f"[tunnel] 已就绪 127.0.0.1:{args.local_port} -> "
            f"{args.remote_host}:{args.remote_port}（经 {args.host}）",
            flush=True,
        )

        try:
            while transport.is_active():
                server.settimeout(1.0)
                try:
                    client, _ = server.accept()
                except socket.timeout:
                    continue
                threading.Thread(
                    target=_serve, args=(transport, client, remote), daemon=True
                ).start()
        except KeyboardInterrupt:
            print("[tunnel] 手动停止", flush=True)
            transport.close()
            server.close()
            return 0
        except Exception as exc:
            print(f"[tunnel] 隧道中断：{exc}，重连中", flush=True)

        server.close()
        transport.close()
        time.sleep(3)


if __name__ == "__main__":
    raise SystemExit(main())

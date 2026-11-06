"""Run both backends over loopback HTTP with disposable data and no WeCom agent."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
HTTP = build_opener(ProxyHandler({}))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def request(base: str, route: str, payload=None, headers=None, expected=200):
    require(urlsplit(base).hostname == "127.0.0.1", "Only loopback requests are allowed")
    req = Request(base + route, data=None if payload is None else json.dumps(payload).encode(),
                  headers={"Content-Type": "application/json", **(headers or {})})
    try:
        response = HTTP.open(req, timeout=8)
    except HTTPError as error:
        response = error
    with response:
        require(response.code == expected, f"{req.get_method()} {route}: expected HTTP {expected}, got {response.code}")
        data = response.read()
    return json.loads(data) if data else None


class Services:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.children: dict[str, subprocess.Popen] = {}
        self.logs = []
        self.node = shutil.which("node")
        require(bool(self.node), "Node.js is required; install Node 22.19 or newer")
        loader = subprocess.check_output([self.node, "-p", "require.resolve('tsx')"], cwd=ROOT, text=True).strip()
        self.loader = Path(loader).as_uri()
        self.password = secrets.token_urlsafe(24)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.upper().startswith(("APP_", "REA_", "WECOM_", "UVICORN_", "ACCEPTANCE_"))
                    and key.upper() not in ("NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME")}
        self.env.update({
            "ACCEPTANCE_RUN_DIR": str(run_dir), "ACCEPTANCE_PASSWORD": self.password,
            "REA_LOCAL_JWT_SECRET": secrets.token_hex(32),
            "PYTHONPATH": str(ROOT / "backend"), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
            "APP_DATABASE_URL": f"sqlite+aiosqlite:///{(run_dir / 'python.sqlite').as_posix()}",
            "APP_JWT_SECRET": secrets.token_hex(32), "APP_SEED_ADMIN_USERNAME": "local-admin",
            "APP_SEED_ADMIN_PASSWORD": self.password, "APP_KB_SERVICE_TOKEN": secrets.token_hex(32),
            "APP_OUTBOX_WORKER": "false", "APP_SYNC_WORKER": "false", "APP_DEVICE_WORKER": "false",
            "APP_LEAD_WORKER": "false", "APP_LLM_BASE_URL": "http://127.0.0.1:1/v1",
            "APP_LLM_API_KEY": "unset", "APP_LLM_MODEL": "deepseek-chat", "APP_ENV": "acceptance",
        })
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.python_port = listener.getsockname()[1]
        self.python_url = f"http://127.0.0.1:{self.python_port}"
        self.node_url = ""

    def start(self, name: str) -> None:
        require(name not in self.children, "A service is already running")
        if name == "node":
            ready = self.run_dir / "node-ready.json"
            ready.unlink(missing_ok=True)
            args = [self.node, "--import", self.loader, str(ROOT / "scripts/acceptance-server.mjs")]
        else:
            args = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                    "--port", str(self.python_port), "--workers", "1", "--no-access-log"]
        log = (self.run_dir / f"{name}.log").open("ab")
        self.logs.append(log)
        child = subprocess.Popen(args, cwd=self.run_dir, env=self.env, stdout=log, stderr=log,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.children[name] = child
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            require(child.poll() is None, f"{name} exited before readiness; verify dependencies")
            try:
                if name == "node":
                    self.node_url = json.loads(ready.read_text(encoding="utf-8"))["url"]
                    require(urlsplit(self.node_url).hostname == "127.0.0.1", "Unexpected Node listen address")
                    return
                if request(self.python_url, "/healthz").get("ok") is True:
                    return
            except (FileNotFoundError, json.JSONDecodeError, URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(0.1)
        raise RuntimeError(f"{name} startup timed out")

    def stop(self, name: str) -> None:
        child = self.children.pop(name, None)
        if child is None or child.poll() is not None:
            return
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)

    def close(self) -> None:
        for name in list(self.children):
            self.stop(name)
        for log in self.logs:
            log.close()


def exercise(services: Services, checks: list[dict]) -> None:
    def passed(name):
        checks.append({"name": name, "status": "passed"})
        print(f"PASS {name}", flush=True)

    services.start("python")
    services.start("node")
    py = services.python_url
    node = lambda route, payload=None, headers=None, expected=200: request(services.node_url, route, payload, headers, expected)
    login = {"username": "local-admin", "password": services.password}
    pa = {"Authorization": "Bearer " + request(py, "/api/v1/auth/login", login)["access_token"]}
    na = {"Authorization": "Bearer " + node("/api/v1/auth/login", login)["access_token"]}
    install_id = request(py, "/api/v1/instance")["install_id"]
    passed("two-backend-startup-and-login")

    code, contact = "pc-acceptance", "S:acceptance-contact"
    path = f"/api/v1/bridge/devices/{code}"
    ptoken = request(py, "/api/v1/devices", {"device_code": code, "name": "Acceptance"}, pa, 201)["device_token"]
    ph = {"X-Device-Token": ptoken}
    node("/api/v1/agent/devices", {"device_code": code, "device_name": "Acceptance", "observe_only": True}, na)
    ntoken = node(path + "/pair", {}, na)["device_token"]
    nh = {"Authorization": "Bearer " + ntoken}
    request(py, f"/api/v1/devices/{code}/heartbeat", {"wecom_state": "online"}, ph)
    node(path + "/heartbeat", {"state": "online", "account_id": "acceptance-owner"}, nh)
    node(path + "/claim", {}, {"Authorization": "Bearer " + ptoken}, 401)
    request(py, "/api/v1/agent/ingest", {"account_uid": "acceptance-owner"}, {"X-Device-Token": ntoken}, 401)
    passed("device-authentication-and-token-isolation")

    batch = {
        "account_uid": "acceptance-owner", "conversations": [{"external_id": contact, "name": "Acceptance"}],
        "messages": [
            {"external_conversation_id": contact, "external_msgid": "101", "direction": "inbound", "content": "synthetic question", "sent_at": "2026-01-01T00:00:00Z"},
            {"external_conversation_id": contact, "external_msgid": "102", "direction": "outbound", "content": "synthetic answer", "sent_at": "2026-01-01T00:01:00Z"},
        ],
    }
    require(request(py, "/api/v1/agent/ingest", batch, ph)["messages_created"] == 2, "Primary messages were not created")
    require(request(py, "/api/v1/agent/ingest", batch, ph)["messages_created"] == 0, "Primary replay was not deduplicated")
    conversations = request(py, "/api/v1/conversations", headers=pa)["items"]
    require(len(conversations) == 1, "Primary conversation mapping is not unique")
    rows = request(py, f"/api/v1/conversations/{conversations[0]['id']}/messages", headers=pa)["items"]
    require([row["direction"] for row in rows] == ["inbound", "outbound"], "Primary message directions differ")
    passed("primary-bidirectional-ingest-and-replay")

    inbound = {"event_id": f"{contact}:101", "contact_id": contact, "nickname": "Acceptance", "content": "synthetic question", "sent_at": "2026-01-01T00:00:00Z"}
    observed = {**inbound, "event_id": f"{contact}:102", "content": "synthetic answer", "sent_at": "2026-01-01T00:01:00Z"}
    customer = node(path + "/inbound", inbound, nh)["customer_id"]
    node(path + "/inbound", inbound, nh)
    require(node(path + "/outbound", observed, nh)["created"] is True, "Outbound observation was not created")
    require(node(path + "/outbound", observed, nh)["created"] is False, "Outbound replay was not deduplicated")
    message_route = f"/api/v1/agent/messages?device_code={code}&customer_id={customer}"
    require(len(node(message_route, headers=na)["items"]) == 2, "Bridge replay created extra bubbles")
    conv = node(f"/api/v1/agent/conversations?device_code={code}", headers=na)["items"][0]
    require(conv["unread"] == 1, "Outbound observations changed unread count")
    require(node(path + "/claim", {}, nh)["command"] is None, "Observe-only ingest generated an automatic command")
    passed("bridge-bidirectional-observation-without-automatic-send")

    send_route = f"/api/v1/agent/conversations/{customer}/send"
    manual_headers = {**na, "Idempotency-Key": "acceptance-manual"}
    queued = node(send_route, {"device_code": code, "content": "synthetic manual reply"}, manual_headers, 202)
    replay = node(send_route, {"device_code": code, "content": "synthetic manual reply"}, manual_headers, 202)
    require(queued["command_id"] == replay["command_id"], "Manual replay created a new command")
    command = node(path + "/claim", {}, nh)["command"]
    require(command["id"] == queued["command_id"], "Manual command mapping differs")
    require(node(path + "/claim", {}, nh)["command"] is None, "A claimed command was delivered twice")
    node(path + "/outbound", {**observed, "event_id": f"{contact}:103", "content": "synthetic manual reply", "sent_at": "2026-01-01T00:02:00Z"}, nh)
    passed("manual-command-idempotency-and-exclusive-claim")

    services.stop("node")
    services.start("node")
    node(path + "/heartbeat", {"state": "offline"}, nh)
    ack = {"command_id": command["id"], "lease_token": command["lease_token"], "status": "succeeded", "message_id": f"{contact}:103"}
    require(node(path + "/receipts", ack, nh)["ok"] is True, "Late receipt after restart failed")
    node(path + "/receipts", ack, nh)
    rows = node(message_route, headers=na)["items"]
    require(len(rows) == 3, "Receipt reconciliation did not preserve exactly three messages")
    manual = next(row for row in rows if row["content"] == "synthetic manual reply")
    require(manual["status"] == "sent" and manual["created_at"] == "2026-01-01T00:02:00.000Z", "Receipt lost observed status or original time")
    passed("node-restart-offline-receipt-and-observation-reconciliation")

    services.stop("python")
    services.start("python")
    require(request(py, "/api/v1/instance")["install_id"] == install_id, "Python instance identity changed after restart")
    require(request(py, "/api/v1/agent/ingest", batch, ph)["messages_created"] == 0, "Primary replay after restart duplicated data")
    require(len(request(py, "/api/v1/conversations", headers=pa)["items"]) == 1, "Primary credentials or data were lost after restart")
    passed("python-restart-identity-authentication-and-ingest-persistence")

    node(path + "/heartbeat", {"state": "online", "account_id": "acceptance-owner"}, nh)
    node(send_route, {"device_code": code, "content": "claimed before pairing"}, {**na, "Idempotency-Key": "pair-claimed"}, 202)
    claimed = node(path + "/claim", {}, nh)["command"]
    node(send_route, {"device_code": code, "content": "queued before pairing"}, {**na, "Idempotency-Key": "pair-queued"}, 202)
    new_token = node(path + "/pair", {}, na)["device_token"]
    node(path + "/claim", {}, nh, 401)
    nh = {"Authorization": "Bearer " + new_token}
    rows = node(message_route, headers=na)["items"]
    require(next(row for row in rows if row["content"] == "claimed before pairing")["status"] == "unknown", "Pairing did not preserve uncertain outcome")
    require(next(row for row in rows if row["content"] == "queued before pairing")["status"] == "failed", "Pairing left an unsent message queued")
    node(path + "/receipts", {"command_id": claimed["id"], "lease_token": claimed["lease_token"], "status": "succeeded", "message_id": f"{contact}:104"}, nh)
    node(path + "/heartbeat", {"state": "online", "account_id": "acceptance-owner"}, nh)
    require(node(path + "/claim", {}, nh)["command"] is None, "Pairing caused an automatic resend")
    passed("credential-rotation-and-late-receipt-without-requeue")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="Write a credential-free JSON result")
    args = parser.parse_args()
    checks: list[dict] = []
    result = {"started_at": datetime.now(timezone.utc).isoformat(), "mode": "isolated-http-no-agent", "checks": checks}
    started = time.monotonic()
    try:
        require(sys.version_info >= (3, 11), "Python 3.11 or newer is required")
        require(importlib.util.find_spec("uvicorn") is not None, "Install backend/pyproject.toml dependencies in this Python environment")
        with tempfile.TemporaryDirectory(prefix="city-acceptance-") as directory:
            services = Services(Path(directory))
            try:
                exercise(services, checks)
            finally:
                services.close()
        result["status"] = "passed"
        result["temporary_data_removed"] = True
    except Exception as error:
        result["status"] = "failed"
        # Exception payloads from HTTP bodies and child logs can contain credentials.
        result["error"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"FAIL {result['error']}", file=sys.stderr)
    result["duration_seconds"] = round(time.monotonic() - started, 2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(f"Acceptance {result['status']}: {len(checks)} scenarios; no agent or real message sends")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

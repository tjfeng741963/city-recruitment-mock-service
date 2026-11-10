"""Real loopback HTTP faults and process restarts; never load desktop APIs."""
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import pytest


ROOT = Path(__file__).resolve().parents[2]


class RecoveryBackend:
    def __init__(self, smoke, services, admin):
        self.values = (smoke, services, admin)

    def __iter__(self):
        return iter(self.values)

    def __repr__(self):
        return "RecoveryBackend(credentials withheld)"


@pytest.fixture(scope="module")
def backend(tmp_path_factory):
    spec = importlib.util.spec_from_file_location("agent_recovery_smoke", ROOT / "scripts/acceptance-smoke.py")
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    folder = tmp_path_factory.mktemp("agent-recovery-http")
    services = smoke.Services(folder)
    try:
        services.start("node")
        token = smoke.request(services.node_url, "/api/v1/auth/login", {"username": "local-admin", "password": services.password})["access_token"]
        yield RecoveryBackend(smoke, services, {"Authorization": "Bearer " + token})
    finally:
        services.close()


@contextmanager
def receipt_proxy(upstream, mode):
    state = {"blocked": True, "receipt_calls": 0, "forwarded_receipts": 0}
    http = build_opener(ProxyHandler({}))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            receipt = self.path.endswith("/receipts")
            if receipt:
                state["receipt_calls"] += 1
            if receipt and state["blocked"] and mode == "unavailable":
                self.send_response(503)
                self.end_headers()
                return
            request = Request(upstream + self.path, data=body, headers={"Content-Type": "application/json", "Authorization": self.headers.get("Authorization", "")})
            try:
                response = http.open(request, timeout=8)
            except HTTPError as error:
                response = error
            with response:
                status, payload = response.code, response.read()
            if receipt:
                state["forwarded_receipts"] += 1
            if receipt and state["blocked"] and mode == "lost-response":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def worker(folder, phase, env):
    result = subprocess.run([sys.executable, "-B", "-m", "tests.agent_recovery_worker", str(folder), phase],
                            cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", timeout=35,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    assert result.returncode == 0, f"Isolated agent phase {phase} failed (output withheld to protect credentials)"
    return json.loads(result.stdout)


@pytest.mark.parametrize("mode", ["unavailable", "lost-response"])
def test_receipt_fault_and_process_restart_never_repeat_sender(backend, tmp_path, mode):
    smoke, services, admin = backend
    request = lambda route, body=None, headers=admin, expected=200: smoke.request(services.node_url, route, body, headers, expected)
    code = "recovery-" + mode
    path = f"/api/v1/bridge/devices/{code}"
    request("/api/v1/agent/devices", {"device_code": code, "device_name": "Recovery fixture", "observe_only": True})
    token = request(path + "/pair", {})["device_token"]
    device = {"Authorization": "Bearer " + token}
    request(path + "/heartbeat", {"state": "online", "account_id": "fixture-owner"}, device)
    customer = request(path + "/inbound", {"event_id": "S:recovery:101", "contact_id": "S:recovery", "nickname": "Recovery fixture", "content": "synthetic question"}, device)["customer_id"]
    queued = request(f"/api/v1/agent/conversations/{customer}/send", {"device_code": code, "content": "synthetic recovery reply"}, {**admin, "Idempotency-Key": "recovery-once"}, 202)
    messages = f"/api/v1/agent/messages?device_code={code}&customer_id={customer}"

    with receipt_proxy(services.node_url, mode) as (url, fault):
        (tmp_path / "config.json").write_text(json.dumps({"bridge_server": url, "bridge_token": token, "device_code": code}), encoding="utf-8")
        first = worker(tmp_path, "pump", services.env)
        assert first["events"]["sender_calls"] == 1
        assert first["stats"] == {"claimed": 1, "sent": 1, "failed": 0}
        assert first["receipt_counts"].get("pending") == 1
        with closing(sqlite3.connect(tmp_path / "reply_log.db")) as db:
            persisted = db.execute("SELECT status,message_id,receipt_state FROM manual_commands").fetchone()
        assert persisted == ("succeeded", "S:recovery:102", "pending")
        assert fault["receipt_calls"] == 1
        assert fault["forwarded_receipts"] == (0 if mode == "unavailable" else 1)
        items = request(messages)["items"]
        assert next(m for m in items if m["direction"] == "outbound")["status"] == ("queued" if mode == "unavailable" else "sent")
        fault["blocked"] = False
        replay = worker(tmp_path, "flush", services.env)
        assert replay["exit_code"] == 0
        assert replay["events"]["sender_calls"] == 0
        assert replay["stats"] == {"claimed": 0, "sent": 0, "failed": 0}
        assert not replay["receipt_counts"].get("pending")
        assert fault["receipt_calls"] == 2
        request(path + "/outbound", {"event_id": "S:recovery:102", "contact_id": "S:recovery", "nickname": "Recovery fixture", "content": "synthetic recovery reply"}, device)
        items = request(messages)["items"]
        outbound = [m for m in items if m["direction"] == "outbound"]
        assert len(outbound) == 1 and outbound[0]["status"] == "sent"
        assert request(path + "/claim", {}, device)["command"] is None
        with closing(sqlite3.connect(services.run_dir / "node.sqlite")) as db:
            assert db.execute("SELECT status FROM bridge_commands WHERE id=?", (queued["command_id"],)).fetchone() == ("succeeded",)
        with closing(sqlite3.connect(tmp_path / "reply_log.db")) as db:
            assert db.execute("SELECT status,message_id,receipt_state FROM manual_commands").fetchone() == ("succeeded", "S:recovery:102", "acked")


def test_held_survives_process_restart_and_retry_cli_only_requeues(backend, tmp_path):
    _, services, _ = backend
    (tmp_path / "config.json").write_text(json.dumps({"bridge_server": services.node_url, "bridge_token": "unused", "device_code": "held-fixture"}), encoding="utf-8")
    held = worker(tmp_path, "hold", services.env)
    assert held["reply_counts"].get("held") == 1
    assert held["events"] == {"sender_calls": 0, "brain_calls": 1}
    restarted = worker(tmp_path, "held-restart", services.env)
    assert restarted["reply_counts"].get("held") == 1
    assert restarted["events"] == {"sender_calls": 0, "brain_calls": 0}
    requeued = worker(tmp_path, "retry-held", services.env)
    assert requeued["exit_code"] == 0
    assert requeued["events"]["sender_calls"] == 0
    assert requeued["reply_counts"].get("pending") == 1
    assert not requeued["reply_counts"].get("held")

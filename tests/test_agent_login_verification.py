"""Exercise the Windows login transport without starting the desktop client."""

import ast
import importlib.util
from pathlib import Path
from urllib.parse import quote

AGENT = Path(__file__).resolve().parents[1] / "agent"


def test_windows_bridge_exposes_the_one_time_verification_request(monkeypatch):
    spec = importlib.util.spec_from_file_location("verification_client", AGENT / "client.py")
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)

    source = AGENT / "autopilot.py"
    module = ast.parse(source.read_text(encoding="utf-8"))
    bridge_definitions = [
        node for node in module.body
        if isinstance(node, (ast.ClassDef, ast.FunctionDef))
        and node.name in {"LoginBridgeClient", "_make_bridge"}
    ]
    namespace = {"agent_client": client, "quote": quote, "log": lambda _: None}
    exec(compile(ast.Module(body=bridge_definitions, type_ignores=[]), str(source), "exec"), namespace)
    bridge = namespace["_make_bridge"](
        {"bridge_server": "https://bridge.example", "bridge_token": "test-device-token"}, "device 1"
    )
    calls = []

    def request(method, path):
        calls.append((method, path))
        return {"available": True, "code": "012345", "at": "test-timestamp"}

    monkeypatch.setattr(bridge, "_request", request)
    assert bridge.fetch_verify_code() == {"available": True, "code": "012345", "at": "test-timestamp"}
    assert calls == [("GET", "/api/v1/agent/devices/device%201/verify-code")]

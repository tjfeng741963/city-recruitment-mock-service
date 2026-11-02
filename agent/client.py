"""与服务端通信（仅标准库 urllib，避免给采集机装依赖）。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class AgentClient:
    def __init__(self, base_url: str, device_token: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.device_token = device_token
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None, timeout: float | None = None) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Device-Token", self.device_token)
        if data:
            req.add_header("Content-Type", "application/json")
        # 本地/内网直连，绕过系统代理
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout or self.timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else {}

    def ingest(self, payload: dict) -> dict:
        return self._request("POST", "/api/v1/agent/ingest", payload)

    def commands(self, wait: int = 0) -> list[dict]:
        return self._request("GET", f"/api/v1/agent/commands?wait={wait}", timeout=wait + 30)

    def ack(self, delivery_id: int, status: str, external_msgid: str = "", error: str = "") -> dict:
        return self._request(
            "POST",
            f"/api/v1/agent/commands/{delivery_id}/ack",
            {"status": status, "external_msgid": external_msgid, "error": error},
        )


def describe_error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            body = exc.read().decode("utf-8", "replace")[:200]
        except Exception:  # noqa: BLE001
            body = ""
        return f"HTTP {exc.code} {body}"
    if isinstance(exc, urllib.error.URLError):
        return f"连接失败: {exc.reason}"
    return f"{type(exc).__name__}: {exc}"

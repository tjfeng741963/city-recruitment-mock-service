"""与服务端通信（仅标准库 urllib，避免给采集机装依赖）。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import quote

# 采集端版本号，心跳里原样上报（服务端只落库，不做版本判断）
AGENT_VERSION = "1.0.0"

# 心跳/上报都是"尽力而为"：本地发送不能被它们拖住，所以单独给短超时
HEARTBEAT_TIMEOUT = 5.0
INGEST_TIMEOUT = 10.0
BRIDGE_TIMEOUT = 5.0


class AgentClient:
    def __init__(
        self,
        base_url: str,
        device_token: str,
        timeout: float = 30.0,
        device_code: str = "",
    ) -> None:
        # device_code 只影响心跳（POST /devices/{code}/heartbeat 的路径参数）。
        # 放在最后且有默认值，main.py 的 AgentClient(server, token) 调用不受影响。
        self.base_url = base_url.rstrip("/")
        self.device_token = device_token
        self.timeout = timeout
        self.device_code = (device_code or "").strip()

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

    def ingest(self, payload: dict, timeout: float | None = None) -> dict:
        return self._request(
            "POST", "/api/v1/agent/ingest", payload, timeout=timeout or INGEST_TIMEOUT
        )

    def heartbeat(
        self,
        agent_version: str = "",
        wecom_state: str = "unknown",
        queue_size: int = 0,
        last_error: str = "",
    ) -> dict:
        """POST /api/v1/devices/{device_code}/heartbeat。

        device_code 来源优先级：构造参数 > 环境变量 AGENT_DEVICE_CODE。
        都没有就抛异常——由调用方（autopilot）捕获并只记日志，不影响发送。
        """
        code = self.device_code or os.environ.get("AGENT_DEVICE_CODE", "").strip()
        if not code:
            raise RuntimeError("缺少 device_code（构造时传 device_code 或设 AGENT_DEVICE_CODE）")
        payload = {
            "agent_version": agent_version or AGENT_VERSION,
            "capabilities": {},
            "wecom_state": wecom_state or "unknown",
            "queue_size": int(queue_size),
            # 契约要求截断 200 字，服务端还会再截一次
            "last_error": (last_error or "")[:200],
        }
        return self._request(
            "POST",
            f"/api/v1/devices/{quote(code, safe='')}/heartbeat",
            payload,
            timeout=min(self.timeout, HEARTBEAT_TIMEOUT),
        )

    def commands(self, wait: int = 0) -> list[dict]:
        return self._request("GET", f"/api/v1/agent/commands?wait={wait}", timeout=wait + 30)

    def ack(self, delivery_id: int, status: str, external_msgid: str = "", error: str = "") -> dict:
        return self._request(
            "POST",
            f"/api/v1/agent/commands/{delivery_id}/ack",
            {"status": status, "external_msgid": external_msgid, "error": error},
        )


class BridgeClient:
    """Node 桥接（4222）设备心跳客户端。

    协议（服务器已部署验证，不要改语义）：
        POST {bridge_server}/api/v1/bridge/devices/{device_code}/heartbeat
        Authorization: Bearer {bridge_token}
        {"state": "online"|"offline"|"scanning", "account_id": "..."}
        → 200 {"device": {...}}

    与 AgentClient 的区别：鉴权用 Bearer 头（桥接配对凭证），不走 X-Device-Token。
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        device_code: str,
        timeout: float = BRIDGE_TIMEOUT,
    ) -> None:
        self.base_url = (base_url or "").strip().rstrip("/")
        self.token = (token or "").strip()
        self.device_code = (device_code or "").strip()
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        """三项配置缺一不可；不完整时调用方应完全跳过桥接上报。"""
        return bool(self.base_url and self.token and self.device_code)

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data:
            req.add_header("Content-Type", "application/json")
        # 公网直连，绕过系统代理（与 AgentClient 同一套做法）
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=self.timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else {}

    def heartbeat(self, state: str, account_id: str = "") -> dict:
        """state 必须已经是桥接语义（online/offline/scanning），映射在 autopilot 做。"""
        code = quote(self.device_code, safe="")
        return self._request(
            "POST",
            f"/api/v1/bridge/devices/{code}/heartbeat",
            {"state": state or "offline", "account_id": (account_id or "")[:128]},
        )

    def fetch_config(self, device_code: str = "") -> dict | None:
        """GET /api/v1/bridge/devices/{code}/config：远端运行参数 + 设备话术。

        鉴权与其他桥接接口一致（Bearer bridge_token），超时沿用 BRIDGE_TIMEOUT(5s)。
        任何失败（网络/HTTP/空响应）都返回 None，由调用方用本地缓存兜底，绝不抛出。
        """
        code = quote((device_code or self.device_code).strip(), safe="")
        if not code:
            return None
        try:
            res = self._request("GET", f"/api/v1/bridge/devices/{code}/config")
        except Exception:  # noqa: BLE001
            return None
        return res if isinstance(res, dict) and res else None

    def inbound(self, event_id: str, contact_id: str, content: str, nickname: str = "") -> dict:
        """POST /api/v1/bridge/devices/{device_code}/inbound（入站消息上报）。

        桥内按 event_id 去重，重复上报幂等；要求设备 online（心跳正常就满足）。
        """
        code = quote(self.device_code, safe="")
        return self._request(
            "POST",
            f"/api/v1/bridge/devices/{code}/inbound",
            {
                "event_id": (event_id or "")[:200],
                "contact_id": (contact_id or "")[:200],
                "content": (content or "")[:20000],
                "nickname": (nickname or "")[:200],
            },
        )

    def claim(self) -> dict | None:
        """POST /claim：领一条待发指令（人工回复/接管）。

        没有可领的指令、或设备不在线时服务端返回 {"command": null}。
        返回结构：{id, device_code, customer_id, contact_id, nickname,
        content, status, lease_token, ...}
        """
        code = quote(self.device_code, safe="")
        res = self._request("POST", f"/api/v1/bridge/devices/{code}/claim", {})
        return res.get("command") or None

    def receipt(
        self,
        command_id: str,
        lease_token: str,
        status: str,
        message_id: str = "",
    ) -> dict:
        """POST /receipts：回报指令执行结果（succeeded/failed/unknown）。"""
        code = quote(self.device_code, safe="")
        return self._request(
            "POST",
            f"/api/v1/bridge/devices/{code}/receipts",
            {
                "command_id": command_id,
                "lease_token": lease_token,
                "status": status,
                # succeeded 时服务端强制要求非空 message_id
                "message_id": message_id,
            },
        )

    def upload_login_qr(
        self,
        image_b64: str,
        width: int,
        height: int,
        captured_at: str,
    ) -> dict:
        """POST /login-qr：把企微登录窗的截图送到服务端，供网页显示给用户扫。

        机器在云端，扫码的人看不到那块屏幕——不把二维码送出去，掉登录就只能
        干等现场有人去看。服务端按 device_code 只保留最新一张（旧帧对扫码没用）。

        返回 {"ok": true}；失败抛异常，由调用方决定是否记日志重试。
        """
        code = quote(self.device_code, safe="")
        return self._request(
            "POST",
            f"/api/v1/bridge/devices/{code}/login-qr",
            {
                "image_b64": image_b64,
                "width": int(width or 0),
                "height": int(height or 0),
                "captured_at": captured_at or "",
            },
        )

    def clear_login_qr(self) -> dict:
        """DELETE /login-qr：登录恢复后清掉残留的二维码，免得网页还在显示旧图。"""
        code = quote(self.device_code, safe="")
        return self._request("DELETE", f"/api/v1/bridge/devices/{code}/login-qr")


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

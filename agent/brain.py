"""回复内容来源：4222 的 Agent 会话（受控编排）。

旧的两条链路（8090 的 /flow/answer、/kb/answer）已废弃，本文件只对 4222：

1. 开场：GET /api/v1/agent/opening?device_code=
   新会话第一次出现消息时按 seq 逐条播：文本真发，图片/视频只占位不真发；
   每条都 POST /api/v1/agent/opening/log 上报回执，失败也记。
2. 对话：POST /api/v1/agent/chat
   {device_code, text, history} → {reply:{messages:[...], script_used, ...}}。
   history 是客户端本地库的全量对话（DeepSeek 无状态多轮拼接）。
   图片/视频消息用文件名占位，当前阶段不真实发送。

鉴权：设备 Bearer token（config.json 的 bridge_token，与心跳同一份）。
三条原则沿用旧 brain 的设计：失败暂停该条回复、有超时、忽略系统代理。
"""

from __future__ import annotations

import time
from typing import Any

import httpx


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Brain:
    """4222 Agent 客户端：开场队列 + 受控对话。"""

    mode = "agent"

    def __init__(
        self,
        base_url: str,
        device_code: str,
        device_token: str,
        *,
        timeout: float = 45.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.device_code = device_code
        self.device_token = device_token
        self.timeout = timeout
        self._opening: dict[str, Any] | None = None
        # trust_env=False：不读 HTTP_PROXY/HTTPS_PROXY，本机回环直连
        self._client = httpx.Client(timeout=timeout, trust_env=False)

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.device_token}"}

    def _get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        response = self._client.get(
            f"{self.base_url}{path}", params=params, headers=self._headers()
        )
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:120]}")
        return response.json()

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._client.post(
            f"{self.base_url}{path}", json=payload, headers=self._headers()
        )
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:120]}")
        return response.json()

    # ── 开场 ──────────────────────────────────────────────

    def opening(self, force: bool = False) -> dict[str, Any]:
        """设备绑定的岗位开场清单。进程内缓存一份，配置改动要重启客户端。"""
        if self._opening is None or force:
            try:
                data = self._get("/api/v1/agent/opening", {"device_code": self.device_code})
                items = data.get("items") or []
                self._opening = {
                    "ok": bool(items),
                    "items": [
                        {
                            "seq": int(item.get("seq") or 0),
                            "kind": str(item.get("kind") or "text"),
                            "content": str(item.get("content") or ""),
                            "media_name": str(item.get("media_name") or ""),
                            "delay_ms": int(item.get("delay_ms") or 2000),
                        }
                        for item in items
                    ],
                    "detail": str(data.get("detail") or ("" if items else "岗位没有配置开场")),
                }
            except Exception as exc:  # noqa: BLE001
                self._opening = {"ok": False, "items": [], "detail": f"{type(exc).__name__}: {exc}"}
        return self._opening

    def log_receipt(
        self,
        session_key: str,
        seq: int,
        kind: str,
        status: str,
        error: str = "",
    ) -> None:
        """开场逐条回执。失败也上报（status=failed），运营在库里能查到。"""
        try:
            self._post(
                "/api/v1/agent/opening/log",
                {
                    "session_key": session_key,
                    "device_code": self.device_code,
                    "seq": seq,
                    "kind": kind,
                    "status": status,
                    "error": error,
                },
            )
        except Exception as exc:  # noqa: BLE001  回执是尽力而为，不能打断发送
            log(f"    [回执] 上报失败：{exc}")

    # ── 对话 ──────────────────────────────────────────────

    def chat(self, text: str, dialogue: list[dict[str, Any]]) -> dict[str, Any]:
        """一轮受控对话。返回 {ok, parts, medias, scene, detail}。

        parts 是纯文本列表（逐条发送）；medias 是 [(kind, name)] 媒体占位，
        当前阶段不真实发送，调用方只记录。
        """
        payload: dict[str, Any] = {
            "device_code": self.device_code,
            "text": (text or "")[:2000],
            "history": dialogue,
        }
        try:
            data = self._post("/api/v1/agent/chat", payload)
        except httpx.TimeoutException:
            return {"ok": False, "parts": [], "medias": [], "detail": f"超过 {self.timeout}s"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "parts": [], "medias": [], "detail": f"{type(exc).__name__}: {exc}"}

        if not data.get("ok"):
            return {
                "ok": False,
                "parts": [],
                "medias": [],
                "detail": str(data.get("error") or data.get("code") or "对话失败"),
            }

        reply = data.get("reply") or {}
        parts: list[str] = []
        medias: list[tuple[str, str]] = []
        for item in reply.get("messages") or []:
            kind = str(item.get("type") or "text")
            if kind == "text":
                content = str(item.get("content") or "").strip()
                if content:
                    parts.append(content)
            else:
                # 媒体用文件名占位：当前阶段不真实发送，只让调用方记录
                medias.append((kind, str(item.get("name") or "")))
        if not parts and not medias:
            return {"ok": False, "parts": [], "medias": [], "detail": "模型返回了空回复"}

        script_used = reply.get("script_used")
        replaced = bool(data.get("script_replaced"))
        detail_bits = [f"{data.get('model')} {data.get('latency_ms')}ms"]
        if script_used:
            detail_bits.append(f"话术 {script_used}{'(已替换回原文)' if replaced else ''}")
        return {
            "ok": True,
            "reply": parts[0] if parts else "",
            "parts": parts,
            "medias": medias,
            "scene": "Agent",
            "detail": "；".join(detail_bits),
        }

    def close(self) -> None:
        self._client.close()

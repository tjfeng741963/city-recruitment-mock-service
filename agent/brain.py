"""回复内容来源：本地知识库（后端 `/api/v1/kb/answer`）。

三条设计原则：

1. **失败暂停该条回复**。知识库在任何键鼠动作之前调用；失败返回给
   调用方保留为 held，待人工处理，不回落测试文本。
2. **有超时**。请求失败后继续处理其他消息与心跳。
3. **忽略系统代理**。本机 `HTTP_PROXY` 指向的代理连不上 `127.0.0.1`
   （今天已踩过：curl 访问 localhost 也被拦成 502），httpx 必须 `trust_env=False`。

配置（`config.json`）：

    "brain": {
      "mode": "kb",                                  // kb | fixed
      "base_url": "http://127.0.0.1:8090",
      "username": "local-admin",
      "password": "local-demo-only",
      "timeout": 20,
      "history_limit": 6
    }
"""

from __future__ import annotations

import time
from typing import Any

import httpx


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Brain:
    """把一条客户消息变成一句可发送的回复。"""

    def __init__(
        self,
        base_url: str,
        username: str = "",
        password: str = "",
        *,
        timeout: float = 20.0,
        history_limit: int = 6,
        mode: str = "kb",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout
        self.history_limit = history_limit
        self.mode = mode
        self._token: str = ""
        self._token_at: float = 0.0
        # trust_env=False：不读 HTTP_PROXY/HTTPS_PROXY，本机回环直连
        self._client = httpx.Client(timeout=timeout, trust_env=False, follow_redirects=False)

    # ── 认证 ──────────────────────────────────────────────
    def _login(self) -> bool:
        if not self.username or not self.password:
            return False
        try:
            r = self._client.post(
                f"{self.base_url}/api/v1/auth/login",
                json={"username": self.username, "password": self.password},
            )
            if r.status_code != 200:
                log(f"    [brain] 登录失败 HTTP {r.status_code}")
                return False
            self._token = r.json().get("access_token", "")
            self._token_at = time.time()
            return bool(self._token)
        except Exception as exc:  # noqa: BLE001
            log(f"    [brain] 登录异常：{type(exc).__name__}: {exc}")
            return False

    def _headers(self) -> dict[str, str]:
        # token 一小时有效，提前 5 分钟换
        if not self._token or time.time() - self._token_at > 3300:
            self._login()
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    # ── 流程模式（状态机在 backend）────────────────────────
    def _reply_flow(self, text: str, session_key: str) -> dict[str, Any]:
        """调 /api/v1/flow/answer。session_key 用企微会话 ID，状态存在服务端。"""
        key = (session_key or "unknown")[:64]
        payload = {"session_key": key, "text": text[:2000]}
        try:
            r = self._client.post(
                f"{self.base_url}/api/v1/flow/answer", json=payload, headers=self._headers()
            )
            if r.status_code == 401:
                self._token = ""
                r = self._client.post(
                    f"{self.base_url}/api/v1/flow/answer",
                    json=payload,
                    headers=self._headers(),
                )
            if r.status_code != 200:
                return {
                    "ok": False,
                    "reply": "",
                    "source": "http",
                    "detail": f"HTTP {r.status_code}: {r.text[:120]}",
                }
            data = r.json()
            stage = str(data.get("stage") or "")
            reply = (data.get("reply") or "").strip()
            if data.get("finished") and not reply:
                return {
                    "ok": True,
                    "reply": "",
                    "source": "flow",
                    "skip": True,
                    "detail": f"流程已结束（{stage}），不再自动回复",
                }
            if not reply:
                return {
                    "ok": False,
                    "reply": "",
                    "source": "empty",
                    "detail": "流程返回空回复",
                }
            return {
                "ok": True,
                "reply": reply,
                "source": "flow",
                "scene": "流程",
                "detail": f"阶段 {stage}",
            }
        except httpx.TimeoutException:
            return {
                "ok": False,
                "reply": "",
                "source": "timeout",
                "detail": f"超过 {self.timeout}s",
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "reply": "",
                "source": "error",
                "detail": f"{type(exc).__name__}: {exc}",
            }

    # ── 主入口 ────────────────────────────────────────────
    def reply(
        self,
        text: str,
        history: list[str] | None = None,
        session_key: str = "",
    ) -> dict[str, Any]:
        """返回 {ok, reply, source, detail}。失败时 ok=False，由调用方暂停。

        mode=flow 时多返回一个 skip=True：流程已经走完（约到面试），
        这条消息不需要再回，调用方应记为跳过而不是发空消息。
        """
        if self.mode == "fixed":
            return {"ok": False, "reply": "", "source": "fixed", "detail": "mode=fixed"}

        text = (text or "").strip()
        if not text:
            return {"ok": False, "reply": "", "source": "empty", "detail": "客户消息为空"}

        if self.mode == "flow":
            return self._reply_flow(text, session_key)

        payload = {
            "text": text[:2000],
            "history": (history or [])[-self.history_limit :],
        }

        try:
            r = self._client.post(
                f"{self.base_url}/api/v1/kb/answer", json=payload, headers=self._headers()
            )
            if r.status_code == 401:  # token 过期，重登一次
                self._token = ""
                r = self._client.post(
                    f"{self.base_url}/api/v1/kb/answer", json=payload, headers=self._headers()
                )
            if r.status_code != 200:
                return {
                    "ok": False,
                    "reply": "",
                    "source": "http",
                    "detail": f"HTTP {r.status_code}: {r.text[:120]}",
                }
            data = r.json()
            reply = (data.get("reply") or "").strip()
            if not reply:
                return {"ok": False, "reply": "", "source": "empty", "detail": "知识库返回空回复"}
            return {
                "ok": True,
                "reply": reply,
                "source": data.get("source", "kb"),
                "detail": (
                    f"命中 {len(data.get('matched_entry_ids') or [])} 条"
                    f"，校验{'通过' if data.get('validation_passed') else '未过'}"
                    f"，llm_fallback={data.get('llm_fallback')}"
                ),
            }
        except httpx.TimeoutException:
            return {"ok": False, "reply": "", "source": "timeout", "detail": f"超过 {self.timeout}s"}
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "reply": "",
                "source": "error",
                "detail": f"{type(exc).__name__}: {exc}",
            }

    def observe_lead(
        self,
        conversation_external_id: str,
        channel_external_id: str,
        dialogue: list[dict[str, Any]],
        *,
        nickname: str = "",
        last_message_id: str = "",
    ) -> dict[str, Any]:
        """把最近几轮对话交给后端判定谈单状态（约面/到面/放弃）。

        只读回执，不产生任何键鼠动作。失败一律返回 ok=False，调用方忽略即可——
        抽取不能影响发消息，这是硬约束。
        """
        if self.mode == "fixed":
            return {"ok": False, "detail": "mode=fixed"}
        if not dialogue:
            return {"ok": False, "detail": "没有对话内容"}

        payload = {
            "conversation_external_id": conversation_external_id,
            "channel_external_id": channel_external_id,
            "nickname": nickname or None,
            "last_message_id": last_message_id or "",
            "history": dialogue[-12:],
        }
        try:
            r = self._client.post(
                f"{self.base_url}/api/v1/leads/observe", json=payload, headers=self._headers()
            )
            if r.status_code == 401:
                self._token = ""
                r = self._client.post(
                    f"{self.base_url}/api/v1/leads/observe", json=payload, headers=self._headers()
                )
            if r.status_code != 200:
                return {"ok": False, "detail": f"HTTP {r.status_code}: {r.text[:120]}"}
            data = r.json()
            return {"ok": True, "changed": bool(data.get("changed")), **data}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}

    def close(self) -> None:
        self._client.close()

"""回复内容来源：4222 的 Agent 会话（受控编排）。

旧的两条链路（8090 的 /flow/answer、/kb/answer）已废弃，本文件只对 4222：

1. 开场：GET /api/v1/agent/opening?device_code=
   新会话第一次出现消息时按 seq 逐条播：文本真发，图片/视频只占位不真发；
   每条都 POST /api/v1/agent/opening/log 上报回执，失败也记。
2. 对话：POST /api/v1/agent/chat
   {device_code, session_key, text} → {reply:{messages:[...], ...}}。
   会话记忆在服务端（agent_session 表），客户端不传历史——客户端只是操作。
   图片/视频消息用文件名占位，当前阶段不真实发送。

鉴权：设备 Bearer token（config.json 的 bridge_token，与心跳同一份）。
三条原则沿用旧 brain 的设计：失败暂停该条回复、有超时、忽略系统代理。
"""

from __future__ import annotations

import time
import json
import re
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from typing import Any

import httpx


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Brain:
    """4222 Agent 客户端：开场队列 + 受控对话。"""

    mode = "agent"
    location_steps = 1

    def __init__(
        self,
        base_url: str,
        device_code: str,
        device_token: str,
        *,
        timeout: float = 45.0,
        flow_cache_path: str | Path | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.device_code = device_code
        self.device_token = device_token
        self.timeout = timeout
        self._opening: dict[str, Any] | None = None
        self._flow: dict[str, Any] | None = None
        self._opening_checked_at: float | None = None
        self._flow_checked_at: float | None = None
        self._state_lock = threading.RLock()
        self._refresh_locks = {"opening": threading.Lock(), "flow": threading.Lock()}
        self._report_lock = threading.Lock()
        self._last_sync_report_at: float | None = None
        self._config_timeout = min(5.0, float(timeout))
        self.reply_mode_generation: str | None = None
        self._reply_mode_id: str | None = None
        self.reply_provider = ""
        self.reply_mode_status: dict[str, Any] = {}
        self._sync = {
            "flow": {"position_id": 0, "version": 0, "status": "disabled", "synced_at": None,
                     "checked_at": None, "state": "error", "error": ""},
            "opening": {"position_id": 0, "version": None, "synced_at": None,
                        "checked_at": None, "state": "error", "error": ""},
        }
        self._flow_cache_loaded = False
        # Kept separate from RemoteConfig's file: two writers must never replace
        # each other's config.remote.json keys. Cache is bound to server+device.
        self._flow_cache_path = Path(flow_cache_path) if flow_cache_path else Path(__file__).parent / "state" / "flow.remote.json"
        # trust_env=False：不读 HTTP_PROXY/HTTPS_PROXY，本机回环直连
        self._client = httpx.Client(timeout=timeout, trust_env=False)

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.device_token}"}

    def _get(self, path: str, params: dict[str, str] | None = None, *, timeout: float | None = None) -> dict[str, Any]:
        response = self._client.get(
            f"{self.base_url}{path}", params=params, headers=self._headers(),
            **({"timeout": timeout} if timeout is not None else {}),
        )
        response.raise_for_status()
        return response.json()

    def _post(self, path: str, payload: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        response = self._client.post(
            f"{self.base_url}{path}", json=payload, headers=self._headers(),
            **({"timeout": timeout} if timeout is not None else {}),
        )
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:120]}")
        return response.json()

    # ── 开场 ──────────────────────────────────────────────

    def opening(self, force: bool = False) -> dict[str, Any]:
        """Refresh at most every minute; each caller receives an isolated welcome snapshot."""
        self._refresh_config("opening", force)
        return self._config_snapshot("opening")

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _error_code(exc: Exception) -> str:
        if isinstance(exc, httpx.HTTPStatusError):
            return "auth" if exc.response.status_code in (401, 403) else "http"
        if isinstance(exc, httpx.RequestError):
            return "network"
        return "invalid_response" if isinstance(exc, (ValueError, TypeError, KeyError)) else "unknown"

    def _config_snapshot(self, kind: str) -> dict[str, Any]:
        with self._state_lock:
            summary = self._sync[kind]
            cached = self._opening if kind == "opening" else self._flow
            if summary["state"] == "blocked":
                return {"ok": False, "blocked": True, "items": [], "nodes": [], "edges": [],
                        "detail": "设备鉴权失效" if summary["error"] == "auth" else str((cached or {}).get("detail") or "配置不可执行"),
                        "position_id": summary["position_id"], "version": summary["version"]}
            if cached is None:
                return {"ok": False, "pending": True, "items": [], "nodes": [], "edges": [], "version": 0,
                        "detail": "配置尚未成功同步"}
            return deepcopy(cached)

    def _load_flow_cache(self) -> None:
        with self._state_lock:
            if self._flow_cache_loaded:
                return
            self._flow_cache_loaded = True
        try:
            cached = json.loads(self._flow_cache_path.read_text(encoding="utf-8"))
            if cached.get("base_url") != self.base_url or cached.get("device_code") != self.device_code:
                return
            data = cached.get("flow")
            # Older caches may have silently omitted location steps.
            if not isinstance(data, dict) or (not data.get("blocked") and data.get("location_steps") != 1):
                return
            summary = cached.get("sync") or {}
            with self._state_lock:
                if self._flow is None:
                    self._flow = deepcopy(data)
                    self._sync["flow"].update({"position_id": int(data.get("position_id") or 0),
                        "version": int(data.get("version") or 0), "status": "enabled" if data.get("status") == "enabled" else "disabled",
                        "synced_at": summary.get("synced_at"),
                        "state": "blocked" if data.get("blocked") or summary.get("state") == "blocked" else "stale",
                        "error": str(summary.get("error") or "invalid_response") if data.get("blocked") or summary.get("state") == "blocked" else "cache"})
        except (OSError, ValueError, AttributeError, TypeError):
            pass

    def _refresh_config(self, kind: str, force: bool = False) -> bool:
        # Never hold a state lock during network IO. In particular a Reporter
        # refresh must not make the sender wait for that request to finish.
        if not self._refresh_locks[kind].acquire(blocking=False):
            return False
        try:
            if kind == "flow":
                self._load_flow_cache()
            now = time.monotonic()
            with self._state_lock:
                last = self._flow_checked_at if kind == "flow" else self._opening_checked_at
                if not force and last is not None and now - last < 60:
                    return False
                if kind == "flow":
                    self._flow_checked_at = now
                else:
                    self._opening_checked_at = now
                self._sync[kind]["checked_at"] = self._utc_now()
            try:
                params = {"device_code": self.device_code}
                if kind == "flow":
                    params["location_steps"] = "1"
                    params["location_links"] = "1"
                    params["recontact"] = "1"
                data = self._get(f"/api/v1/agent/{kind}", params, timeout=self._config_timeout)
                if not isinstance(data, dict):
                    raise ValueError("invalid config response")
                stamp = self._utc_now()
                position_id = int(data.get("position_id") or 0)
                if kind == "opening":
                    items = data.get("items")
                    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                        raise ValueError("invalid opening items")
                    version = data.get("opening_version")
                    version = version if isinstance(version, str) and re.fullmatch(r"[0-9a-fA-F]{64}", version) else None
                    result = {"ok": bool(items), "position_id": position_id, "version": version,
                        "synced_at": stamp, "provider": data.get("provider", "agent"),
                        "items": [{"seq": int(item.get("seq") or 0), "kind": str(item.get("kind") or "text"),
                            "content": str(item.get("content") or ""), "media_name": str(item.get("media_name") or ""),
                            "delay_ms": int(item.get("delay_ms") if item.get("delay_ms") is not None else 2000),
                            # 位置卡条目的坐标/地址/名称：autopilot 生成卡片要用。
                            # 原来这里重建 item 时把 location 丢了，开场位置卡永远「缺坐标」被跳过。
                            "location": item.get("location") if isinstance(item.get("location"), dict) else None}
                            for item in items],
                        "detail": str(data.get("detail") or ("" if items else "岗位没有配置开场"))}
                    summary = {"position_id": position_id, "version": version, "synced_at": stamp}
                else:
                    if data.get("location_steps") != 1 or not isinstance(data.get("nodes"), list):
                        raise ValueError("invalid flow nodes")
                    result = deepcopy(data)
                    result["synced_at"] = stamp
                    summary = {"position_id": position_id, "version": int(data.get("version") or 0),
                        "status": "enabled" if data.get("status") == "enabled" else "disabled", "synced_at": stamp}
                with self._state_lock:
                    if kind == "opening":
                        self._opening = result
                    else:
                        self._flow = result
                    self._sync[kind].update({**summary, "state": "blocked" if data.get("blocked") else "synced",
                                             "error": "invalid_response" if data.get("blocked") else ""})
                if kind == "flow":
                    try:
                        self._flow_cache_path.parent.mkdir(parents=True, exist_ok=True)
                        tmp = self._flow_cache_path.with_suffix(".tmp")
                        tmp.write_text(json.dumps({"base_url": self.base_url, "device_code": self.device_code,
                            "flow": result, "sync": self.sync_status()["flow"]}, ensure_ascii=False), encoding="utf-8")
                        tmp.replace(self._flow_cache_path)
                    except OSError:
                        with self._state_lock:
                            self._sync[kind]["error"] = "write"
                return True
            except Exception as exc:  # noqa: BLE001 - keep the last successful response for transient failures
                error = self._error_code(exc)
                with self._state_lock:
                    cached = self._opening if kind == "opening" else self._flow
                    prior = self._sync[kind]["state"]
                    self._sync[kind].update({"state": "blocked" if error == "auth" or prior == "blocked" else "stale" if cached is not None else "error",
                                            "error": self._sync[kind]["error"] if prior == "blocked" and error != "auth" else error})
                if kind == "flow" and error == "auth":
                    # Do not let an offline restart revive a previously revoked
                    # device from its last successful on-disk configuration.
                    try:
                        self._flow_cache_path.parent.mkdir(parents=True, exist_ok=True)
                        tmp = self._flow_cache_path.with_suffix(".tmp")
                        with self._state_lock:
                            sync = deepcopy(self._sync[kind])
                        tmp.write_text(json.dumps({"base_url": self.base_url, "device_code": self.device_code,
                            "flow": {"blocked": True, "position_id": sync["position_id"], "version": sync["version"],
                                     "status": sync["status"], "nodes": [], "edges": []}, "sync": sync}, ensure_ascii=False), encoding="utf-8")
                        tmp.replace(self._flow_cache_path)
                    except OSError:
                        pass
            return False
        finally:
            self._refresh_locks[kind].release()

    def _apply_reply_mode(self, provider: str, generation: str) -> bool:
        flow_ok = self._refresh_config("flow", force=True)
        opening_ok = self._refresh_config("opening", force=True)
        flow = self._config_snapshot("flow")
        opening = self._config_snapshot("opening")
        return (flow_ok and opening_ok and not flow.get("blocked") and not opening.get("blocked") and flow.get("provider", "agent") == provider
                and flow.get("reply_mode_id", "") == generation and opening.get("provider", "agent") == provider)

    def sync_reply_mode(self, online: bool, *, can_prepare: bool = True, desktop: bool = True) -> bool:
        path = f"/api/v1/bridge/devices/{quote(self.device_code, safe='')}/reply-mode"

        def exchange(**fields: Any) -> dict[str, Any]:
            status = self._post(path, {"wecom_online": online, "desktop_active": desktop, **fields}, timeout=self._config_timeout)
            if (not isinstance(status, dict) or not isinstance(status.get("id"), str)
                    or status.get("phase") not in ("idle", "waiting", "applying", "completed", "cancelled")
                    or status.get("effective") not in ("agent", "dify") or status.get("target") not in ("agent", "dify")):
                raise ValueError("invalid reply mode response")
            self.reply_mode_status = status
            return status

        try:
            status = exchange(ready_id=self._reply_mode_id, ready_provider=self.reply_provider)
            if not desktop:
                self.reply_mode_status = {**status, "local_issue": "desktop"}
                return False
            if not online:
                return False
            if status["phase"] == "waiting":
                if not can_prepare:
                    exchange(id=status["id"], issue="local_state")
                    return False
                status = exchange(id=status["id"], step="prepared")
            if status["phase"] == "waiting":
                return False
            if status["phase"] == "applying":
                request_id, target = status["id"], status["target"]
                generation = status.get("target_generation", request_id)
                if not self._apply_reply_mode(target, generation):
                    exchange(id=request_id, issue="configuration")
                    return False
                status = exchange(id=request_id, step="applied", provider=target)
                if status["id"] != request_id or status["effective"] != target or status["phase"] not in ("completed", "cancelled"):
                    return False
                self.reply_mode_generation = generation
                self._reply_mode_id = request_id
                self.reply_provider = target
                return True
            provider, generation = status["effective"], status.get("generation", status["id"])
            if (self.reply_mode_generation, self.reply_provider) != (generation, provider):
                if not self._apply_reply_mode(provider, generation):
                    self.reply_mode_status = {**status, "local_issue": "configuration"}
                    return False
                self.reply_mode_generation = generation
                self.reply_provider = provider
            self._reply_mode_id = status["id"]
            return True
        except (ValueError, RuntimeError, httpx.HTTPError) as exc:
            detail = str(exc)
            issue = "auth" if detail.startswith(("HTTP 401:", "HTTP 403:")) else "network"
            self.reply_mode_status = {**self.reply_mode_status, "local_issue": issue}
            return False

    def sync_status(self) -> dict[str, Any]:
        """Read only successful configuration identity and the latest check outcome."""
        with self._state_lock:
            return deepcopy(self._sync)

    def report_config_sync(self, client_commit: str = "") -> bool:
        """Reporter-only minute poll + receipt. Network IO never holds the state lock."""
        if not self._report_lock.acquire(blocking=False):
            return False
        try:
            now = time.monotonic()
            if self._last_sync_report_at is not None and now - self._last_sync_report_at < 60:
                return True
            self._last_sync_report_at = now
            self.flow()
            self.opening()
            payload = {"device_code": self.device_code, **self.sync_status()}
            if isinstance(client_commit, str) and re.fullmatch(r"[0-9a-fA-F]{40}", client_commit):
                payload["client_commit"] = client_commit.lower()
            try:
                return bool(self._post("/api/v1/agent/config-sync", payload, timeout=self._config_timeout).get("ok"))
            except Exception:  # noqa: BLE001 - telemetry failure cannot stop sending
                return False
        finally:
            self._report_lock.release()

    def log_receipt(
        self,
        session_key: str,
        seq: int,
        kind: str,
        status: str,
        error: str = "",
    ) -> str:
        """开场逐条回执。失败也上报（status=failed），运营在库里能查到。"""
        try:
            data = self._post(
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
            return str(data.get("trace_id") or "")
        except Exception as exc:  # noqa: BLE001  回执是尽力而为，不能打断发送
            log(f"    [回执] 上报失败：{exc}")
            return ""

    def log_delivery(
        self,
        trace_id: str,
        status: str,
        *,
        session_key: str = "",
        node_key: str = "",
        message_id: str = "",
        detail: str = "",
    ) -> None:
        """把真实企微发送/回读结果关联到一次 Agent 执行记录。"""
        trace_id = str(trace_id or "").strip()
        if not trace_id:
            return
        try:
            self._post(
                f"/api/v1/agent/execution-traces/{trace_id}/delivery",
                {
                    "status": str(status or "unknown"),
                    "message_id": str(message_id or "")[:200],
                    "detail": str(detail or "")[:1000],
                    "device_code": self.device_code,
                    "session_key": str(session_key or "")[:120],
                    "node_key": str(node_key or "")[:120],
                },
            )
        except Exception as exc:  # noqa: BLE001  证据上报失败不能阻断键鼠发送
            log(f"    [执行证据] 发送结果上报失败：{exc}")

    def start_trace(
        self,
        *,
        position_id: int,
        session_key: str,
        request_text: str,
        flow_version: int = 0,
        stage: str = "",
        node_key: str = "",
    ) -> str:
        """为客户端直接执行的节点创建一条可回查的执行记录。"""
        try:
            data = self._post(
                "/api/v1/agent/execution-traces",
                {
                    "position_id": int(position_id),
                    "device_code": self.device_code,
                    "session_key": str(session_key or "")[:120],
                    "request_text": str(request_text or "")[:2000],
                    "engine": "agent",
                    "flow_version": int(flow_version or 0),
                    "stage": str(stage or "")[:200],
                    "node_key": str(node_key or "")[:120],
                },
            )
            return str(data.get("trace_id") or "")
        except Exception as exc:  # noqa: BLE001
            log(f"    [执行证据] 创建流程记录失败：{exc}")
            return ""

    # ── 对话 ──────────────────────────────────────────────

    def flow(self, force: bool = False) -> dict[str, Any]:
        """Poll at most once a minute, fall back to a scoped durable cache."""
        self._refresh_config("flow", force)
        return self._config_snapshot("flow")

    def states(self) -> list[dict[str, Any]] | None:
        """None means mirror unavailable; an empty list is a confirmed empty mirror."""
        try:
            data = self._get("/api/v1/agent/state", {"device_code": self.device_code})
            return data.get("items") if isinstance(data.get("items"), list) else None
        except Exception as exc:
            log(f"    [流程状态] 对账失败：{type(exc).__name__}")
            return None

    def report_state(self, items: list[dict[str, Any]]) -> bool:
        """批量上报会话镜像；状态上报失败不阻断本地发送。"""
        if not items:
            return True
        try:
            data = self._post("/api/v1/agent/state", {"device_code": self.device_code, "items": items})
            return bool(data.get("ok"))
        except Exception as exc:  # noqa: BLE001
            log(f"    [流程状态] 上报失败：{exc}")
            return False

    def authorize_faq_media(self, trace_id: str, session_key: str, name: str) -> bool:
        if not trace_id:
            return False
        try:
            return self._post("/api/v1/agent/faq-media/validate", {
                "device_code": self.device_code, "trace_id": trace_id,
                "session_key": session_key, "name": name,
            }, timeout=5).get("ok") is True
        except (httpx.HTTPError, OSError, RuntimeError, ValueError):
            return False

    def chat(self, text: str, session_key: str, *, sent_summary: list[str] | None = None,
             turn_id: str = "") -> dict[str, Any]:
        """一轮对话，按服务端能力返回旧回复或有序发送计划。

        会话记忆在服务端（agent_session 表）：客户端只报 session_key + 这句话，
        不传历史。旧回复继续使用 parts 与 medias。
        """
        payload: dict[str, Any] = {
            "device_code": self.device_code,
            "session_key": (session_key or "").strip()[:120],
            "text": (text or "")[:2000],
            "ordered_reply": True,
            "faq_media": True,
        }
        if sent_summary is not None:
            payload["sent_summary"] = [str(item)[:500] for item in sent_summary[:50]]
        if turn_id:
            payload["turn_id"] = turn_id
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
                "code": data.get("code"),
                "detail": str(data.get("error") or data.get("code") or "对话失败"),
            }

        reply = data.get("reply") or {}
        faq = reply.get("faq")
        is_faq = isinstance(faq, dict) and type(faq.get("id")) is int and faq["id"] > 0
        if (data.get("provider") == "dify" or is_faq) and "delays_before_ms" in reply:
            messages = reply.get("messages")
            delays = reply["delays_before_ms"]
            plan = []
            valid = isinstance(messages, list) and isinstance(delays, list) and bool(messages) and len(messages) == len(delays)
            if valid:
                for item, delay in zip(messages, delays):
                    kind = item.get("type") if isinstance(item, dict) else None
                    key = "content" if kind == "text" else "name"
                    if (kind not in ("text", "image", "video") or not isinstance(item.get(key), str)
                            or not item[key].strip() or type(delay) is not int or not 0 <= delay <= 30_000):
                        break
                    plan.append({"type": kind, key: item[key].strip(), "delay_ms": delay})
            if not valid or len(plan) != len(messages) or plan[0]["type"] != "text" or plan[0]["delay_ms"] != 0:
                return {"ok": False, "detail": "有序回复的发送计划格式无效"}
            if is_faq and [step["type"] for step in plan[1:]] not in (["image"], ["video"], ["image", "video"]):
                return {"ok": False, "detail": "岗位问答素材顺序无效"}
            return {"ok": True, "trace_id": str(data.get("trace_id") or ""), "reply": plan[0]["content"],
                    "plan": plan, "scene": "岗位问答" if is_faq else "Dify",
                    "faq_media": is_faq, "detail": str(data.get("model") or "Dify"),
                    # 面试点坐标：客户端在文字送达后补发原生位置卡（2026-11-26）。
                    # 少了这个键，agent_card 永远是 None，客户问「导航」也拿不到定位。
                    "location_card": data.get("location_card") or None}
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

        detail_bits = [f"{data.get('model')} {data.get('latency_ms')}ms"]
        return {
            "ok": True,
            "trace_id": str(data.get("trace_id") or ""),
            "reply": parts[0] if parts else "",
            "parts": parts,
            "medias": medias,
            "scene": "Agent",
            "detail": "；".join(detail_bits),
            # 同 plan 分支：服务端给坐标就透传，客户端据此补发原生位置卡。
            "location_card": data.get("location_card") or None,
        }

    def close(self) -> None:
        self._client.close()

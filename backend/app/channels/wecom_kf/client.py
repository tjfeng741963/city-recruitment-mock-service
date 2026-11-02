"""企业微信客服 HTTP 客户端：access_token 缓存、单飞、重试与错误映射。

设计要点（每条都对应 tests/test_client.py 的用例）：

* 路径白名单：`call()` 只接受 `kf/xxx` 形式或 `gettoken`，否则直接 ValueError，
  防止凭据被拼进任意 URL。
* access_token 内存缓存（TTL = expires_in - 60）+ asyncio.Lock 单飞：
  并发首次调用只会打一次 gettoken。
* 40014 / 42001 视为 token 失效：刷新并重试一次；`kf/send_msg` 例外，
  绝不重试，避免客户收到重复消息。
* 网络异常（超时、连接失败、非 2xx、非 JSON、非对象）统一抛
  `WeComApiError(..., uncertain=True)`，让发送侧知道「结果不明，不能自动重投」。
* 日志与异常消息里都不出现 access_token / app_secret 明文。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable
from typing import Any

import httpx

from .config import WeComSettings
from .errors import WeComApiError, describe

_log = logging.getLogger(__name__)

_BASE_URL = "https://qyapi.weixin.qq.com/cgi-bin"
_GETTOKEN = "gettoken"

#: 业务接口只允许 kf/... 的形式，禁止任何 ../、协议、查询串
_PATH_RE = re.compile(r"kf/[a-z_]+(?:/[a-z_]+)*")

#: token 失效类错误码：刷新后可安全重试一次
_TOKEN_ERRCODES = frozenset({40014, 42001})

#: 这些接口绝不重试（重试可能造成重复发送）
_NO_RETRY_PATHS = frozenset({"kf/send_msg"})

_TIMEOUT_SECONDS = 12.0
_TOKEN_EXPIRY_MARGIN = 60
_DEFAULT_EXPIRES_IN = 7200

#: httpx 会按 INFO 打印完整 URL（含 corpsecret / access_token），必须脱敏
_SENSITIVE_QUERY_RE = re.compile(r"(corpsecret|access_token)=[^&\s\"']+")
_REDACTED = r"\1=***"
_HTTPX_LOGGER_NAME = "httpx"


class _RedactSensitiveQuery(logging.Filter):
    """把 httpx 日志里的 corpsecret / access_token 值替换成 ***。"""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(self._scrub(arg) for arg in record.args)
        elif isinstance(record.msg, str):
            record.msg = _SENSITIVE_QUERY_RE.sub(_REDACTED, record.msg)
        return True

    @staticmethod
    def _scrub(value: object) -> object:
        if isinstance(value, httpx.URL):
            return _SENSITIVE_QUERY_RE.sub(_REDACTED, str(value))
        if isinstance(value, str):
            return _SENSITIVE_QUERY_RE.sub(_REDACTED, value)
        return value


_redaction_installed = False


def _install_log_redaction() -> None:
    """幂等地给 httpx logger 挂脱敏 filter，避免凭据进日志。"""
    global _redaction_installed
    if _redaction_installed:
        return
    logging.getLogger(_HTTPX_LOGGER_NAME).addFilter(_RedactSensitiveQuery())
    _redaction_installed = True


def _errcode(data: dict[str, Any]) -> int:
    raw = data.get("errcode", 0)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return -1


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class WeComClient:
    """企微 API 的薄封装。生命周期内的 token 缓存与并发控制都在这里。"""

    def __init__(self, config: WeComSettings, http: httpx.AsyncClient | None = None) -> None:
        _install_log_redaction()
        self._config = config
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(
            timeout=httpx.Timeout(_TIMEOUT_SECONDS),
            follow_redirects=False,
        )
        self._token: str | None = None
        self._expires_at = 0.0
        self._token_lock = asyncio.Lock()
        # 测试可替换成假时钟；生产用单调时钟，不受系统时间调整影响
        self._clock: Callable[[], float] = time.monotonic

    # ------------------------------------------------------------------ #
    # 对外主入口
    # ------------------------------------------------------------------ #
    async def call(self, api_path: str, body: dict | None = None) -> dict:
        """调用一个企微接口。`body is None` 走 GET，否则 POST JSON。"""
        self._check_path(api_path)

        if api_path == _GETTOKEN:
            # gettoken 用 corp_id + app_secret，不走 access_token 参数
            async with self._token_lock:
                return await self._refresh_token()

        token = await self._access_token()
        can_retry = api_path not in _NO_RETRY_PATHS
        retried = False

        while True:
            data = await self._invoke(api_path, body, token)
            code = _errcode(data)
            if code == 0:
                return data
            if code in _TOKEN_ERRCODES and can_retry and not retried:
                _log.info("接口 %s 返回 errcode=%s，刷新 access_token 后重试一次", api_path, code)
                retried = True
                token = await self._access_token(stale=token)
                continue
            raise WeComApiError(self._error_message(api_path, code, data), code)

    async def aclose(self) -> None:
        """只关闭自己创建的连接池；外部传入的由调用方负责。"""
        if self._owns_http:
            self._owns_http = False
            await self._http.aclose()

    # ------------------------------------------------------------------ #
    # 便捷方法
    # ------------------------------------------------------------------ #
    async def sync_msg(
        self,
        open_kfid: str,
        cursor: str = "",
        token: str = "",
        limit: int = 1000,
    ) -> dict:
        """拉取消息。返回体含 next_cursor / has_more / msg_list。"""
        return await self.call(
            "kf/sync_msg",
            {"cursor": cursor, "token": token, "limit": limit, "open_kfid": open_kfid},
        )

    async def send_text(
        self,
        open_kfid: str,
        external_userid: str,
        content: str,
        msgid: str,
    ) -> dict:
        """发送文本消息。

        该路径永不重试：企微侧按 msgid 去重，但网络不明时重发仍有风险，
        由上层依据 `uncertain` 决定是否人工介入。
        成功返回 `{"errcode": 0, "errmsg": "ok", "msgid": "<msgid>"}`。
        """
        return await self.call(
            "kf/send_msg",
            {
                "touser": external_userid,
                "open_kfid": open_kfid,
                "msgid": msgid,
                "msgtype": "text",
                "text": {"content": content},
            },
        )

    async def service_state(self, open_kfid: str, external_userid: str) -> int:
        """接待状态：0 未处理 / 1 由智能助手接待 / 2 待接入池 / 3 人工接待中。"""
        data = await self.call(
            "kf/service_state/get",
            {"open_kfid": open_kfid, "external_userid": external_userid},
        )
        state = data.get("service_state")
        if isinstance(state, bool) or not isinstance(state, int):
            try:
                return int(state)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                raise WeComApiError("kf/service_state/get 响应缺少 service_state") from None
        return state

    async def customer_batchget(self, external_userids: list[str]) -> list[dict]:
        """批量拉取客户资料。返回 customer_list 列表（无匹配时为空列表）。"""
        data = await self.call(
            "kf/customer/batchget",
            {"external_userid_list": list(external_userids), "need_enter_session_context": 0},
        )
        customers = data.get("customer_list")
        if customers is None:
            return []
        if not isinstance(customers, list):
            raise WeComApiError("kf/customer/batchget 响应的 customer_list 不是数组")
        return [item for item in customers if isinstance(item, dict)]

    # ------------------------------------------------------------------ #
    # 内部实现
    # ------------------------------------------------------------------ #
    @staticmethod
    def _check_path(api_path: str) -> None:
        """白名单校验。不合法时直接 ValueError，且不回显入参以免泄露凭据。"""
        if not isinstance(api_path, str):
            raise ValueError("企微接口路径必须是字符串")
        if api_path == _GETTOKEN:
            return
        if not _PATH_RE.fullmatch(api_path):
            raise ValueError("企微接口路径不合法：只允许 gettoken 或 kf/<小写字母下划线> 形式")

    @staticmethod
    def _error_message(api_path: str, code: int, data: dict[str, Any]) -> str:
        detail = data.get("errmsg") or ""
        message = f"{describe(code)}（{api_path}"
        if detail:
            message += f" errmsg={detail}"
        return message + "）"

    def _token_valid(self) -> bool:
        return self._token is not None and self._clock() < self._expires_at

    async def _access_token(self, stale: str | None = None) -> str:
        """取 token。

        `stale` 不为 None 时表示「这个 token 刚被服务端判定失效」：
        若缓存已经是别的（更新的）token，就直接用新的，避免并发时重复刷新。

        单飞靠 `_token_lock` + 锁内二次检查：并发首次调用里只有一个协程真正请求
        gettoken，其余协程在锁上等待后命中缓存直接返回。
        """
        if stale is None and self._token_valid():
            return self._token  # type: ignore[return-value]

        async with self._token_lock:
            if self._token_valid() and (stale is None or self._token != stale):
                return self._token  # type: ignore[return-value]
            data = await self._refresh_token()
            token = data.get("access_token")
            if not isinstance(token, str):  # pragma: no cover - _refresh_token 已校验
                raise WeComApiError("获取 access_token 失败：响应缺少 access_token", uncertain=True)
            return token

    async def _refresh_token(self) -> dict[str, Any]:
        """请求 gettoken 并写入缓存。调用方必须持有 `_token_lock`。"""
        data = await self._request_gettoken()
        code = _errcode(data)
        if code != 0:
            raise WeComApiError(f"获取 access_token 失败：{describe(code)}", code)

        token = data.get("access_token")
        if not isinstance(token, str) or not token:
            raise WeComApiError("获取 access_token 失败：响应缺少 access_token", uncertain=True)

        expires_in = _as_int(data.get("expires_in"), _DEFAULT_EXPIRES_IN)
        ttl = max(expires_in - _TOKEN_EXPIRY_MARGIN, 0)
        self._token = token
        self._expires_at = self._clock() + ttl
        _log.info("access_token 已刷新，缓存 %s 秒", ttl)
        return data

    async def _request_gettoken(self) -> dict[str, Any]:
        try:
            resp = await self._http.get(
                f"{_BASE_URL}/{_GETTOKEN}",
                params={"corpid": self._config.corp_id, "corpsecret": self._config.app_secret},
                timeout=_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            raise WeComApiError(
                f"获取 access_token 网络异常（{type(exc).__name__}），结果不明",
                uncertain=True,
            ) from None
        return self._parse(resp, _GETTOKEN)

    async def _invoke(self, api_path: str, body: dict | None, token: str) -> dict[str, Any]:
        url = f"{_BASE_URL}/{api_path}"
        params = {"access_token": token}
        # 超时与不跟随重定向按请求下发：即使外部传入了 AsyncClient 也强制生效，
        # 避免 302 把 access_token 带到别的地址。
        options = {"timeout": _TIMEOUT_SECONDS, "follow_redirects": False}
        try:
            if body is None:
                resp = await self._http.get(url, params=params, **options)
            else:
                resp = await self._http.post(url, params=params, json=body, **options)
        except httpx.HTTPError as exc:
            # 只带异常类型名：httpx 的异常文本里可能含完整 URL（含 access_token）
            raise WeComApiError(
                f"调用 {api_path} 网络异常（{type(exc).__name__}），结果不明",
                uncertain=True,
            ) from None
        return self._parse(resp, api_path)

    @staticmethod
    def _parse(resp: httpx.Response, api_path: str) -> dict[str, Any]:
        if not 200 <= resp.status_code < 300:
            raise WeComApiError(f"调用 {api_path} 失败：HTTP {resp.status_code}", uncertain=True)
        try:
            data = resp.json()
        except ValueError:
            raise WeComApiError(f"调用 {api_path} 失败：响应不是合法 JSON", uncertain=True) from None
        if not isinstance(data, dict):
            raise WeComApiError(f"调用 {api_path} 失败：响应不是 JSON 对象", uncertain=True)
        return data

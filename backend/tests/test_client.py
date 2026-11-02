"""WeComClient 测试：全部走 httpx.MockTransport，不发真实网络请求。

隔离说明：本文件不碰数据库、不 import app.main，只依赖 httpx + settings，
因此可以与其他并行任务共用同一个 backend 目录而不互相干扰。
"""

from __future__ import annotations

import asyncio
import logging

import httpx
import pytest

from app.channels.wecom_kf.client import WeComClient
from app.channels.wecom_kf.config import WeComSettings
from app.channels.wecom_kf.errors import WeComApiError

CORP_ID = "ww0000testcorp"
SECRET = "SUPER-SECRET-do-not-leak-9f8e7d"
OPEN_KFID = "wkAAAAAA"
EXTERNAL_USERID = "wmBBBBBB"
MSGID = "msg-0001"

GETTOKEN = "gettoken"


# --------------------------------------------------------------------------- #
# 假企微：按 URL 分流、记录调用顺序
# --------------------------------------------------------------------------- #
class FakeWeCom:
    """MockTransport 的 handler。

    `handler(name, request, body)` 只处理业务接口（name 形如 `kf/sync_msg`）；
    gettoken 由本类自己实现，方便统计调用次数与发放不同的 token。
    """

    def __init__(self, *, expires_in: int = 7200, gettoken_delay: float = 0.0) -> None:
        self.expires_in = expires_in
        self.gettoken_delay = gettoken_delay
        self.calls: list[str] = []
        self.requests: list[httpx.Request] = []
        self.issued: list[str] = []
        self.handler = None  # type: ignore[assignment]

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        name = request.url.path.removeprefix("/cgi-bin/")
        self.calls.append(name)

        if name == GETTOKEN:
            if self.gettoken_delay:
                await asyncio.sleep(self.gettoken_delay)
            token = f"ACCESS-TOKEN-{len(self.issued) + 1}"
            self.issued.append(token)
            return httpx.Response(
                200,
                json={
                    "errcode": 0,
                    "errmsg": "ok",
                    "access_token": token,
                    "expires_in": self.expires_in,
                },
            )

        assert self.handler is not None, f"未配置业务 handler，却收到了 {name}"
        body = {}
        if request.method == "POST" and request.content:
            import json as _json

            body = _json.loads(request.content)
        return self.handler(name, request, body)

    # -- 便捷断言 -- #
    def count(self, name: str) -> int:
        return self.calls.count(name)


@pytest.fixture()
def config() -> WeComSettings:
    return WeComSettings(
        enabled=True,
        corp_id=CORP_ID,
        app_secret=SECRET,
        callback_token="cb-token",
        encoding_aes_key="a" * 43,
        open_kfid=OPEN_KFID,
    )


def make_client(config: WeComSettings, fake: FakeWeCom) -> WeComClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake), follow_redirects=False)
    return WeComClient(config, http=http)


def ok(**payload) -> httpx.Response:
    return httpx.Response(200, json={"errcode": 0, "errmsg": "ok", **payload})


def fail(code: int, errmsg: str = "boom") -> httpx.Response:
    return httpx.Response(200, json={"errcode": code, "errmsg": errmsg})


# --------------------------------------------------------------------------- #
# 1. 首次 call：先 gettoken 再业务接口
# --------------------------------------------------------------------------- #
async def test_first_call_fetches_token_before_api(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok(next_cursor="c1", has_more=0, msg_list=[])
    client = make_client(config, fake)
    try:
        data = await client.call("kf/sync_msg", {"cursor": ""})
    finally:
        await client.aclose()

    assert fake.calls == ["gettoken", "kf/sync_msg"]
    assert data["next_cursor"] == "c1"

    token_req, api_req = fake.requests
    # 凭据放在 query / body，不放在 path
    assert token_req.url.path == "/cgi-bin/gettoken"
    assert token_req.url.params["corpid"] == CORP_ID
    assert token_req.url.params["corpsecret"] == SECRET
    assert api_req.method == "POST"
    assert api_req.url.host == "qyapi.weixin.qq.com"
    assert api_req.url.path == "/cgi-bin/kf/sync_msg"
    assert api_req.url.params["access_token"] == "ACCESS-TOKEN-1"


async def test_call_without_body_uses_get(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)
    try:
        await client.call("kf/service_state/get")
    finally:
        await client.aclose()

    assert fake.requests[-1].method == "GET"
    assert fake.requests[-1].content == b""


async def test_call_gettoken_is_allowed_and_returns_payload(config: WeComSettings) -> None:
    fake = FakeWeCom()
    client = make_client(config, fake)
    try:
        payload = await client.call("gettoken")
    finally:
        await client.aclose()

    assert payload["access_token"] == "ACCESS-TOKEN-1"
    assert fake.calls == ["gettoken"]


# --------------------------------------------------------------------------- #
# 2. token 命中缓存
# --------------------------------------------------------------------------- #
async def test_token_is_cached_between_calls(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)
    try:
        await client.call("kf/sync_msg", {})
        await client.call("kf/sync_msg", {})
        await client.call("kf/customer/batchget", {})
    finally:
        await client.aclose()

    assert fake.count("gettoken") == 1
    tokens = {r.url.params.get("access_token") for r in fake.requests[1:]}
    assert tokens == {"ACCESS-TOKEN-1"}


# --------------------------------------------------------------------------- #
# 3. token 过期（TTL = expires_in - 60）后重新获取
# --------------------------------------------------------------------------- #
async def test_token_refreshed_after_expiry(config: WeComSettings) -> None:
    fake = FakeWeCom(expires_in=7200)  # TTL = 7140s
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)

    now = [1000.0]
    client._clock = lambda: now[0]
    try:
        await client.call("kf/sync_msg", {})
        assert fake.count("gettoken") == 1

        # 还没到 TTL：继续用缓存
        now[0] += 7000
        await client.call("kf/sync_msg", {})
        assert fake.count("gettoken") == 1

        # 超过 7140s：过期，重新取
        now[0] += 141
        await client.call("kf/sync_msg", {})
        assert fake.count("gettoken") == 2
        assert fake.requests[-1].url.params["access_token"] == "ACCESS-TOKEN-2"
    finally:
        await client.aclose()


# --------------------------------------------------------------------------- #
# 4. 业务接口 40014 → 重取 token 并重试一次 → 成功
# --------------------------------------------------------------------------- #
async def test_40014_refreshes_token_and_retries_once(config: WeComSettings) -> None:
    fake = FakeWeCom()
    attempts: list[str] = []

    def handler(name, req, body):
        attempts.append(req.url.params["access_token"])
        if len(attempts) == 1:
            return fail(40014, "invalid credential")
        return ok(msgid=MSGID)

    fake.handler = handler
    client = make_client(config, fake)
    try:
        data = await client.call("kf/sync_msg", {})
    finally:
        await client.aclose()

    assert fake.calls == ["gettoken", "kf/sync_msg", "gettoken", "kf/sync_msg"]
    assert attempts == ["ACCESS-TOKEN-1", "ACCESS-TOKEN-2"]
    assert data["msgid"] == MSGID


# --------------------------------------------------------------------------- #
# 5. kf/send_msg 返回 40014 → 绝不重试
# --------------------------------------------------------------------------- #
async def test_send_msg_never_retries_on_40014(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: fail(40014, "invalid credential")
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.send_text(OPEN_KFID, EXTERNAL_USERID, "你好", MSGID)
    finally:
        await client.aclose()

    assert excinfo.value.code == 40014
    assert excinfo.value.uncertain is False
    assert fake.calls == ["gettoken", "kf/send_msg"]  # 只打了一次业务接口


# --------------------------------------------------------------------------- #
# 6. 超时 → uncertain=True
# --------------------------------------------------------------------------- #
async def test_timeout_marked_uncertain(config: WeComSettings) -> None:
    fake = FakeWeCom()

    def handler(name, req, body):
        raise httpx.ReadTimeout("timed out")

    fake.handler = handler
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.send_text(OPEN_KFID, EXTERNAL_USERID, "你好", MSGID)
    finally:
        await client.aclose()

    assert excinfo.value.uncertain is True
    assert excinfo.value.code is None


async def test_gettoken_timeout_marked_uncertain(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)

    async def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("connect timed out")

    client._http = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.call("kf/sync_msg", {})
    finally:
        await client._http.aclose()

    assert excinfo.value.uncertain is True


# --------------------------------------------------------------------------- #
# 7. 响应不是 JSON / 不是对象 → uncertain=True
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"<html>gateway</html>", headers={"content-type": "text/html"}),
        httpx.Response(200, json=[1, 2, 3]),
        httpx.Response(200, json="ok"),
    ],
    ids=["html", "array", "string"],
)
async def test_bad_payload_marked_uncertain(config: WeComSettings, response: httpx.Response) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: response
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.send_text(OPEN_KFID, EXTERNAL_USERID, "你好", MSGID)
    finally:
        await client.aclose()

    assert excinfo.value.uncertain is True


async def test_non_2xx_marked_uncertain(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: httpx.Response(502, text="bad gateway")
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.send_text(OPEN_KFID, EXTERNAL_USERID, "你好", MSGID)
    finally:
        await client.aclose()

    assert excinfo.value.uncertain is True
    assert "502" in str(excinfo.value)


# --------------------------------------------------------------------------- #
# 8. errcode 映射：60020 → 提示可信 IP
# --------------------------------------------------------------------------- #
async def test_error_code_mapped_to_chinese_description(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: fail(60020, "not allow to access from your ip")
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.call("kf/sync_msg", {})
    finally:
        await client.aclose()

    assert excinfo.value.code == 60020
    assert "可信 IP" in str(excinfo.value)
    assert excinfo.value.uncertain is False


async def test_unknown_error_code_still_reports_code(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: fail(123456, "weird")
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError) as excinfo:
            await client.call("kf/sync_msg", {})
    finally:
        await client.aclose()

    assert excinfo.value.code == 123456
    assert "123456" in str(excinfo.value)


# --------------------------------------------------------------------------- #
# 9. 非法 api_path → ValueError，且不发任何请求
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "bad_path",
    [
        "../etc/passwd",
        "http://evil.com",
        "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
        "kf/../kf/sync_msg",
        "kf/Send_Msg",
        "kf/send_msg?access_token=x",
        "cgi-bin/kf/sync_msg",
        "kf/",
        "kf/sync_msg/",
        "",
    ],
)
async def test_invalid_api_path_rejected(config: WeComSettings, bad_path: str) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)
    try:
        with pytest.raises(ValueError):
            await client.call(bad_path, {})
    finally:
        await client.aclose()

    assert fake.calls == []


# --------------------------------------------------------------------------- #
# 10. 单飞：并发 10 个首次调用只打 1 次 gettoken
# --------------------------------------------------------------------------- #
async def test_single_flight_token_fetch(config: WeComSettings) -> None:
    fake = FakeWeCom(gettoken_delay=0.02)
    fake.handler = lambda name, req, body: ok(next_cursor="c")
    client = make_client(config, fake)
    try:
        results = await asyncio.gather(*(client.call("kf/sync_msg", {}) for _ in range(10)))
    finally:
        await client.aclose()

    assert len(results) == 10
    assert fake.count("gettoken") == 1
    assert fake.count("kf/sync_msg") == 10
    assert all(len(fake.issued) == 1 for _ in [0])


async def test_concurrent_40014_refreshes_only_once(config: WeComSettings) -> None:
    """并发场景下多个协程都拿到 40014，也只应刷新一次 token。"""
    fake = FakeWeCom()
    seen: list[str] = []

    def handler(name, req, body):
        token = req.url.params["access_token"]
        seen.append(token)
        if token == "ACCESS-TOKEN-1":
            return fail(42001, "expired")
        return ok()

    fake.handler = handler
    client = make_client(config, fake)
    try:
        await asyncio.gather(*(client.call("kf/sync_msg", {}) for _ in range(5)))
    finally:
        await client.aclose()

    # 首轮 5 次失败 + 次轮 5 次成功；gettoken 只多刷了 1 次
    assert fake.count("gettoken") == 2
    assert len(fake.issued) == 2


# --------------------------------------------------------------------------- #
# 11. 异常与日志里不出现 app_secret / access_token 明文
# --------------------------------------------------------------------------- #
async def test_no_secret_leak_in_errors_or_logs(
    config: WeComSettings, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    texts: list[str] = []

    async def scenario(handler, *, calls: int = 1) -> None:
        fake = FakeWeCom()
        fake.handler = handler
        client = make_client(config, fake)
        try:
            for _ in range(calls):
                try:
                    await client.call("kf/sync_msg", {})
                except WeComApiError as exc:
                    texts.extend([str(exc), repr(exc), str(exc.args)])
        finally:
            await client.aclose()
        # 假 token 确实被发出去过，用于反向确认「日志/异常里查不到它」
        assert fake.issued

    # a) 40014：刷新后重试仍失败
    await scenario(lambda name, req, body: fail(40014, "invalid credential"))
    # b) 60020
    await scenario(lambda name, req, body: fail(60020, "ip not allowed"))
    # c) 网络异常
    def boom(name, req, body):
        raise httpx.ConnectError("connection refused")

    await scenario(boom)

    haystack = "\n".join(texts) + "\n" + caplog.text
    assert SECRET not in haystack
    assert "ACCESS-TOKEN" not in haystack
    # httpx 自身会打完整 URL，脱敏后仍保留字段名便于排查
    assert "corpsecret=***" in caplog.text or "access_token=***" in caplog.text
    # 日志里要能定位问题：接口名、错误码
    assert "kf/sync_msg" in caplog.text or "40014" in caplog.text


# --------------------------------------------------------------------------- #
# 便捷方法：请求体形状
# --------------------------------------------------------------------------- #
async def test_sync_msg_request_shape(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok(next_cursor="", has_more=0, msg_list=[])
    client = make_client(config, fake)
    try:
        await client.sync_msg(OPEN_KFID, cursor="CUR", token="TOK", limit=50)
    finally:
        await client.aclose()

    import json as _json

    body = _json.loads(fake.requests[-1].content)
    assert body == {"cursor": "CUR", "token": "TOK", "limit": 50, "open_kfid": OPEN_KFID}


async def test_send_text_request_shape_and_response(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok(msgid=MSGID)
    client = make_client(config, fake)
    try:
        data = await client.send_text(OPEN_KFID, EXTERNAL_USERID, "你好 🎉", MSGID)
    finally:
        await client.aclose()

    import json as _json

    assert fake.requests[-1].url.path == "/cgi-bin/kf/send_msg"
    assert _json.loads(fake.requests[-1].content) == {
        "touser": EXTERNAL_USERID,
        "open_kfid": OPEN_KFID,
        "msgid": MSGID,
        "msgtype": "text",
        "text": {"content": "你好 🎉"},
    }
    # 企微 send_msg 成功形态：errcode=0 + 回传 msgid
    assert data["msgid"] == MSGID


async def test_service_state_returns_int(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok(service_state=2, servicer_userid="")
    client = make_client(config, fake)
    try:
        state = await client.service_state(OPEN_KFID, EXTERNAL_USERID)
    finally:
        await client.aclose()

    assert state == 2
    assert fake.requests[-1].url.path == "/cgi-bin/kf/service_state/get"


async def test_service_state_missing_field_raises(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)
    try:
        with pytest.raises(WeComApiError):
            await client.service_state(OPEN_KFID, EXTERNAL_USERID)
    finally:
        await client.aclose()


async def test_customer_batchget_returns_list(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok(
        customer_list=[{"external_userid": EXTERNAL_USERID, "nickname": "张三"}],
        invalid_external_userid=[],
    )
    client = make_client(config, fake)
    try:
        customers = await client.customer_batchget([EXTERNAL_USERID])
    finally:
        await client.aclose()

    assert customers == [{"external_userid": EXTERNAL_USERID, "nickname": "张三"}]
    assert fake.requests[-1].url.path == "/cgi-bin/kf/customer/batchget"


async def test_customer_batchget_empty_response(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    client = make_client(config, fake)
    try:
        assert await client.customer_batchget([]) == []
    finally:
        await client.aclose()


# --------------------------------------------------------------------------- #
# 生命周期
# --------------------------------------------------------------------------- #
async def test_aclose_closes_own_http_client(config: WeComSettings) -> None:
    client = WeComClient(config)
    try:
        assert client._owns_http is True
        await client.aclose()
        assert client._http.is_closed
    finally:
        await client.aclose()


async def test_aclose_leaves_injected_client_open(config: WeComSettings) -> None:
    fake = FakeWeCom()
    fake.handler = lambda name, req, body: ok()
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    client = WeComClient(config, http=http)
    await client.aclose()
    try:
        assert http.is_closed is False
    finally:
        await http.aclose()

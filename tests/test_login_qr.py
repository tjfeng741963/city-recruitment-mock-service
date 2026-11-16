"""企微登录二维码上传（agent/login_qr.py）。

为什么要测：这条链路的意义是"人不在那台机器前面也能扫码登录"。它一旦不工作，
表现是网页上永远显示"还没收到二维码"——安静地失效，没人会立刻发现。
真正危险的两条是：

1. **正常在线时不该传**：把聊天界面当二维码传上去，用户会扫一个莫名其妙的东西；
2. **异常不许冒到主循环**：截图/编码/上传任何一步失败都必须吞掉，否则整个
   自动回复进程会被一个截图错误搞停。

直接 import autopilot 会拉 win32api（见 conftest.py 说明），所以这里用
假的 bridge 替身直接测 pusher，不启动真实客户端。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import login_qr  # noqa: E402


class FakeBridge:
    """记录调用，不碰网络。"""

    enabled = True

    def __init__(self) -> None:
        self.uploads: list[tuple[int, int, str]] = []
        self.clears = 0
        self.fail = False

    def upload_login_qr(self, image_b64: str, width: int, height: int, captured_at: str) -> dict:
        if self.fail:
            raise RuntimeError("network down")
        self.uploads.append((width, height, captured_at))
        return {"ok": True}

    def clear_login_qr(self) -> dict:
        self.clears += 1
        return {"ok": True}


@pytest.fixture
def bridge() -> FakeBridge:
    return FakeBridge()


@pytest.fixture
def pusher() -> login_qr.LoginQrPusher:
    p = login_qr.LoginQrPusher()
    p.reset()
    return p


def test_online_state_never_uploads(pusher, bridge) -> None:  # noqa: ANN001
    """正常在线：一次都不该传。传上去的会是聊天界面，不是二维码。"""
    for state in ("online", "hidden", "not_running", "unknown"):
        assert pusher.tick(state, bridge, log=lambda _m: None) is False
    assert bridge.uploads == []
    assert bridge.clears == 0


def test_login_required_without_window_does_not_crash(pusher, bridge, monkeypatch) -> None:  # noqa: ANN001
    """看到登录态但找不到登录窗（比如窗口在托盘里）：安静跳过，不抛异常。"""
    monkeypatch.setattr(login_qr, "find_login_window", lambda: 0)
    assert pusher.tick("login_required", bridge, log=lambda _m: None) is False
    assert bridge.uploads == []


def test_upload_errors_never_escape(pusher, bridge, monkeypatch) -> None:  # noqa: ANN001
    """上传失败必须被吞掉——一个截图错误不能把自动回复进程搞停。"""
    monkeypatch.setattr(login_qr, "find_login_window", lambda: 12345)
    bridge.fail = True
    assert pusher.tick("login_required", bridge, log=lambda _m: None) is False


def test_screenshot_error_never_escapes(pusher, bridge, monkeypatch) -> None:  # noqa: ANN001
    """截图本身炸了（窗口刚好被关掉）同样不许冒到主循环。"""
    import screenshot

    monkeypatch.setattr(login_qr, "find_login_window", lambda: 12345)

    def boom(*_a, **_k):
        raise OSError("窗口已关闭")

    monkeypatch.setattr(screenshot, "png_base64", boom)
    assert pusher.tick("login_required", bridge, log=lambda _m: None) is False


def test_disabled_bridge_is_skipped(pusher, monkeypatch) -> None:  # noqa: ANN001
    """桥接没配好（没 token / 没地址）时完全跳过，不是每轮报错。"""

    class Disabled:
        enabled = False

        def upload_login_qr(self, *_a, **_k):  # pragma: no cover - 不该被调用
            raise AssertionError("不该上传")

    monkeypatch.setattr(login_qr, "find_login_window", lambda: 12345)
    assert pusher.tick("login_required", Disabled(), log=lambda _m: None) is False
    assert pusher.tick("login_required", None, log=lambda _m: None) is False


def test_recovery_clears_server_frame(pusher, bridge) -> None:  # noqa: ANN001
    """从登录态恢复到在线：必须把服务端那张旧二维码清掉。

    否则网页会一直显示一张已经失效的码，用户扫了没反应，还以为系统坏了。
    """
    pusher._was_login_required = True
    assert pusher.tick("online", bridge, log=lambda _m: None) is False
    assert bridge.clears == 1
    # 清一次就够，后续在线轮次不再重复请求
    pusher.tick("online", bridge, log=lambda _m: None)
    assert bridge.clears == 1


def test_push_is_throttled(pusher, bridge, monkeypatch) -> None:  # noqa: ANN001
    """30 秒节流：短时间内连续 tick 只传一次，避免每轮都截图上传。"""
    import screenshot

    monkeypatch.setattr(login_qr, "find_login_window", lambda: 12345)
    monkeypatch.setattr(screenshot, "png_base64", lambda *_a, **_k: ("ZmFrZQ==", 228, 312))

    assert pusher.tick("login_required", bridge, log=lambda _m: None) is True
    assert pusher.tick("login_required", bridge, log=lambda _m: None) is False
    assert len(bridge.uploads) == 1

    # 超过间隔后重新上传
    real_now = login_qr._now
    monkeypatch.setattr(login_qr, "_now", lambda: real_now() + login_qr.PUSH_INTERVAL + 1)
    assert pusher.tick("login_required", bridge, log=lambda _m: None) is True
    assert len(bridge.uploads) == 2


def test_login_window_lookup_is_safe_on_non_windows() -> None:
    """非 Windows 平台返回 0，不抛异常（CI 在 Linux 上跑）。"""
    if sys.platform == "win32":
        pytest.skip("这条只验证非 Windows 的降级行为")
    assert login_qr.find_login_window() == 0

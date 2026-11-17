"""首次登录引导：企微还没登录过时，Data 目录不存在，autopilot 进不去。

本脚本只做三件事：
1. 企微没跑就拉起 WXWork.exe；
2. 每 15 秒探测登录窗（WeChatLogin 窗口类）；
3. 掉登录态下每 30 秒把扫码窗截图推到 4222，网页 /dev 设备登录页可见。

用户扫码成功、Data 目录出现后，autopilot 就能正常接管（本脚本可停）。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import login_qr  # noqa: E402
import login_watch  # noqa: E402
from autopilot import detect_wecom_state  # noqa: E402
from client import BridgeClient  # noqa: E402

WXWORK_CANDIDATES = [
    Path(r"C:\Program Files (x86)\WXWork\WXWork.exe"),
    Path(r"C:\Program Files\WXWork\WXWork.exe"),
]

# 企微登录窗的二维码有效期大约 2~4 分钟；过期后窗口里也不会自己换新码，
# 远程机器没人点「刷新」，只能整窗重启。同一张图（按内容哈希）持续超过
# 这个秒数，就认为已过期，重启企微换新码。
QR_MAX_AGE_SECONDS = 150


class QrFreshness:
    """跟踪最近上传二维码的内容变化：同一张图持续多久了。"""

    def __init__(self, max_age: int) -> None:
        self.max_age = max_age
        self.hash = ""
        self.changed_at = 0.0

    def record(self, image_b64: str) -> None:
        digest = hashlib.md5(image_b64.encode("utf-8")).hexdigest()
        now = time.time()
        if digest != self.hash:
            self.hash = digest
            self.changed_at = now

    def stale(self) -> bool:
        return bool(self.hash) and (time.time() - self.changed_at) > self.max_age

    def reset(self) -> None:
        self.hash = ""
        self.changed_at = time.time()


def restart_wxwork(wxwork: Path) -> None:
    """杀掉企微再拉起：登录窗重新生成一张有效二维码。"""
    subprocess.run(["taskkill", "/F", "/IM", "WXWork.exe"], capture_output=True)
    time.sleep(3)
    subprocess.Popen([str(wxwork)], cwd=str(wxwork.parent))
    time.sleep(12)


def verify_dialog_open() -> bool:
    """短信验证码弹窗（WXworkWindow 类，浮在登录窗上方）是否已出现。

    这个类的存在本身就是「验证码界面出现了」的信号——比截图哈希
    变化更可靠：弹窗是独立顶层窗口，出现即可立即敲码，不用等 90 秒兜底。
    """
    try:
        import win32gui

        hit = []

        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd) and win32gui.GetClassName(hwnd) == "WXworkWindow":
                hit.append(hwnd)
            return True

        win32gui.EnumWindows(cb, None)
        return bool(hit)
    except Exception:
        return False


def poll_verify_code(bridge) -> str:
    """轮询前端提交的短信验证码（one-shot）：有就返回，没有返回空串。"""
    try:
        response = httpx.get(
            f"{bridge.base_url}/api/v1/agent/devices/{bridge.device_code}/verify-code",
            headers={"authorization": f"Bearer {bridge.token}"},
            timeout=8,
        )
        body = response.json()
        if body.get("available"):
            return str(body.get("code") or "")
    except Exception as exc:  # noqa: BLE001
        print(f"验证码轮询失败（忽略）: {type(exc).__name__}: {exc}")
    return ""


def type_verify_code(code: str) -> None:
    """在 Console 会话里把验证码敲进企微登录窗（input-code.py 同会话可见窗口）。"""
    result = subprocess.run(
        [sys.executable, str(ROOT / "input-code.py"), code],
        capture_output=True,
        text=True,
        timeout=30,
    )
    out = ((result.stdout or "") + (result.stderr or "")).strip()
    print(f"验证码 {code} 输入结果: exit={result.returncode} {out[-200:]}")


def main() -> int:
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    bridge = None
    if cfg.get("bridge_server") and cfg.get("bridge_token"):
        bridge = BridgeClient(
            cfg["bridge_server"],
            cfg["bridge_token"],
            cfg.get("device_code", ""),
        )
        print(f"桥接就绪: {bridge.base_url} / {bridge.device_code}")
    else:
        print("未配置 bridge_server/bridge_token，二维码无法上传")
        return 2

    fresh = QrFreshness(QR_MAX_AGE_SECONDS)
    # 挂一层包装：每次上传都记录内容哈希，用于过期判断
    original_upload = bridge.upload_login_qr

    def tracked_upload(image_b64: str, width: int, height: int, captured_at: str) -> object:
        fresh.record(image_b64)
        return original_upload(image_b64, width, height, captured_at)

    bridge.upload_login_qr = tracked_upload  # type: ignore[method-assign]

    qr = login_qr.LoginQrPusher()
    wxwork = next((p for p in WXWORK_CANDIDATES if p.exists()), None)
    print(f"WXWork: {wxwork or '未找到'}")

    # 验证码敲入的时机控制（教训来自 923070 那次：码敲进了二维码屏幕）：
    # 用户提交码时窗口往往还在二维码界面（手机端还没确认完），数字全部落空。
    # 正确顺序：收到码 → 记录当前截图哈希 → 等窗口真的离开二维码界面
    # （截图内容变化 = 验证码界面出现）再敲；最多等 90 秒，超时敲一次碰运气。
    pending: dict | None = None
    last_code_at = 0.0

    def window_hash() -> str:
        hwnd = login_qr.find_login_window()
        if not hwnd:
            return ""
        import screenshot

        b64, _w, _h = screenshot.png_base64(hwnd, scale=login_qr.SCALE)
        return hashlib.md5(b64.encode("utf-8")).hexdigest()

    while True:
        try:
            state = detect_wecom_state()
            if state == "not_running":
                if wxwork and wxwork.exists():
                    print("企微没在跑，拉起 WXWork.exe")
                    subprocess.Popen([str(wxwork)], cwd=str(wxwork.parent))
                    time.sleep(10)
                    state = detect_wecom_state()
                pending = None
            print(f"状态: {state}")
            qr.tick(state, bridge, log=print)
            if state == "online":
                if pending:
                    print("已登录，丢弃未输入的验证码")
                    pending = None
                print("企微已登录！可以让 autopilot 接管了（本脚本继续值守）")
            elif state == "login_required":
                # 前端提交的新码：记录提交时刻的窗口哈希
                code = poll_verify_code(bridge)
                if code:
                    pending = {"code": code, "hash": window_hash(), "at": time.time()}
                    print(f"收到前端提交的验证码 {code}，等验证码界面出现后再输入（最多等 90 秒）")
                # 等到验证码弹窗出现（WXworkWindow 类）或窗口离开二维码界面才敲
                if pending:
                    current = window_hash()
                    waited = int(time.time() - pending["at"])
                    dialog = verify_dialog_open()
                    if dialog or (current and current != pending["hash"]):
                        print(
                            f"验证码界面就绪（{'弹窗已出现' if dialog else '截图已变化'}，等了 {waited} 秒），"
                            "输入验证码"
                        )
                        type_verify_code(pending["code"])
                        pending = None
                        last_code_at = time.time()
                        fresh.reset()
                    elif waited > 90:
                        print("等了 90 秒窗口没变化，直接输入碰运气")
                        type_verify_code(pending["code"])
                        pending = None
                        last_code_at = time.time()
                        fresh.reset()
                    else:
                        print(f"窗口仍在二维码界面，等手机端确认（已等 {waited} 秒）")
                # 过期重启：同图超时 + 不在敲码保护期 + 验证码弹窗没开着。
                # （弹窗开着 = 正在等验证码，绝不能重启；「手机确认中」的界面
                # 超时重启是无害的——登录请求本来就会过期，重扫即可。
                # 旧版 ever_moved「换过界面就永不重启」会造成死锁：二维码过期
                # 界面永远卡住不换新码，2026-11-17 线上实测。）
                elif (
                    wxwork
                    and fresh.stale()
                    and time.time() - last_code_at > 180
                    and not verify_dialog_open()
                ):
                    print(
                        f"二维码已过期（同一张图持续 {int(time.time() - fresh.changed_at)} 秒），"
                        "重启企微换新码"
                    )
                    restart_wxwork(wxwork)
                    fresh.reset()
        except Exception as exc:  # noqa: BLE001
            print(f"轮询失败（忽略）: {type(exc).__name__}: {exc}")
        time.sleep(15)


if __name__ == "__main__":
    sys.exit(main())

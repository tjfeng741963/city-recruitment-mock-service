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

    while True:
        try:
            state = detect_wecom_state()
            if state == "not_running" and wxwork and wxwork.exists():
                print("企微没在跑，拉起 WXWork.exe")
                subprocess.Popen([str(wxwork)], cwd=str(wxwork.parent))
                time.sleep(10)
                state = detect_wecom_state()
            print(f"状态: {state}")
            qr.tick(state, bridge, log=print)
            if state == "online":
                print("企微已登录！可以让 autopilot 接管了（本脚本继续值守）")
            elif state == "login_required" and wxwork and fresh.stale():
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

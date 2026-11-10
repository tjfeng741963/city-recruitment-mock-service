"""设备自注册（方案 A）：首次启动算机器码、换 token、写回 config.json。

设计要点：
  - device_code 由机器标识派生，同一台机器永远得到同一个码，重装系统才变
  - 只做 HTTP，不碰企微、不产生任何键鼠事件
  - 拿到的 token 立刻落盘，下次启动直接读，不再联网注册
  - 注册失败一律不阻塞主流程：调用方按"没有 token"处理（跳过心跳/桥接）
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

DEVICE_CODE_PREFIX = "pc-"
MACHINE_HASH_LENGTH = 12
REGISTER_TIMEOUT = 20


def machine_guid() -> str:
    """读 Windows 的 MachineGuid：重装系统才变，换硬件不变。

    读不到时退回主机名 + 用户名，保证同一台机器仍然稳定。
    """
    try:
        out = subprocess.run(
            ["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        for line in (out.stdout or "").splitlines():
            if "MachineGuid" in line:
                value = line.split()[-1].strip()
                if value:
                    return value
    except (OSError, subprocess.SubprocessError):
        pass
    return f"{platform.node()}|{os.environ.get('USERNAME', '')}"


def derive_device_code(guid: str | None = None) -> str:
    """机器码 = pc- + sha256(MachineGuid) 前 12 位。"""
    raw = guid or machine_guid()
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return DEVICE_CODE_PREFIX + digest[:MACHINE_HASH_LENGTH]


def _post(url: str, body: dict, headers: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    # 关掉代理：注册是本机/内网直连，走系统代理经常 502。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=REGISTER_TIMEOUT) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload) if payload else {}


def register(
    server: str,
    register_key: str,
    device_code: str,
    name: str = "",
    bridge_server: str = "",
) -> dict:
    """同时向 8090（device_token）与 4222（bridge_token）注册。

    两边都是幂等的：重复调用只换发 token。返回可以直接合并进 config 的字典；
    某一边失败就跳过那一边，另一边的结果照常返回——桥接挂了不应导致心跳也没了。
    """
    result: dict[str, str] = {}
    key = (register_key or "").strip()
    if not key:
        return result
    code = (device_code or "").strip()
    if not code:
        raise ValueError("device_code 为空，无法注册")

    base = (server or "").rstrip("/")
    if base:
        try:
            created = _post(
                f"{base}/api/v1/devices/register",
                {"device_code": code, "name": name or code},
                {"X-Register-Key": key},
            )
            token = created.get("device_token")
            if isinstance(token, str) and token:
                result["device_token"] = token
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass

    bridge = (bridge_server or "").rstrip("/")
    if not bridge and base and ":8090" in base:
        # 默认约定：8090 与 4222 在同一台服务器上。
        bridge = base.replace(":8090", ":4222")
    if bridge:
        try:
            paired = _post(
                f"{bridge}/api/v1/bridge/devices/{code}/register",
                {"name": name or code},
                {"X-Register-Key": key},
            )
            token = paired.get("device_token")
            if isinstance(token, str) and token:
                result["bridge_token"] = token
                result["bridge_server"] = bridge
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass

    return result


def write_back(config_path: Path, values: dict) -> None:
    """把注册结果合并进 config.json，保留其余字段与顺序。

    新机器第一次注册时强制 dry_run=true：装上去就对着真实客户发消息，这个
    教训 2026-11-05 已经付过一次代价（见 docs/交接文档.md 事故记录）。
    已有 config 里显式写了 dry_run 的，尊重原值。
    """
    existing: dict = {}
    if config_path.is_file():
        try:
            loaded = json.loads(config_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, ValueError):
            existing = {}
    fresh = not existing
    merged = {**existing, **values}
    if fresh and "dry_run" not in merged:
        merged["dry_run"] = True
    config_path.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

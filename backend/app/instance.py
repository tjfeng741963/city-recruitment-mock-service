"""实例身份：install_id。

阶段一没有授权码，用一个持久化的 UUID 代替：

- 首次启动生成，写入 `data/instance.json`
- 之后每次读到同一个值（重启不变）
- 服务器端做好后，用它关联租户、下发指令、统计用量

⚠️ 这不是安全机制，只是标识。真正的授权校验（签名 / 到期 / 吊销）
等服务器端接入后再加，那时会有 `tenant_id` + 签名 token。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

INSTANCE_FILE = Path("data/instance.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_or_create(path: Path | None = None) -> dict:
    """读取实例信息；文件不存在或损坏时生成一个新的。"""
    p = path or INSTANCE_FILE
    if p.is_file():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("install_id"):
                return data
        except (OSError, ValueError):
            pass  # 损坏就重建，不阻塞启动

    data = {
        "install_id": str(uuid.uuid4()),
        "created_at": _now(),
        "tenant_id": None,   # 服务器端接入后回填
        "name": "",          # 客户可自定义，用于区分多台机器
    }
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def current() -> dict:
    return load_or_create()


def public_view() -> dict:
    """对外暴露的字段：不含任何敏感信息，只用于「我是谁」。"""
    data = load_or_create()
    return {
        "install_id": data["install_id"],
        "created_at": data.get("created_at"),
        "tenant_id": data.get("tenant_id"),
        "name": data.get("name", ""),
    }

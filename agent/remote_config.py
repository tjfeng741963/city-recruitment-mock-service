"""远端配置（Node 4222 下发）：拉取、合并、缓存、version 热更。

契约：docs/对齐-配置分发与按设备话术.md §1/§4。
- 只依赖标准库（根 tests/ 的 pytest 环境没有 pywin32，所以不从 autopilot 拆回来）；
- 远端有就用远端，本地 config.json 兜底；
- 失败静默：拉不到就用缓存/本地，只在状态变化时打一行日志，不刷屏。
"""

from __future__ import annotations

import json
import time
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REMOTE_CONFIG_CACHE = ROOT / "config.remote.json"

# 远端键 → 本地 cfg 键（interval/cooldown 即时生效：主循环每轮读 cfg 字典）
REMOTE_PARAM_KEYS = {
    "interval_seconds": "interval",
    "cooldown": "cooldown",
    "merge_delay_seconds": "merge_delay",
}

# 远端可以切换的 brain.mode。改动需要重建 Brain 实例，由 autopilot 的
# brain_mode_changed 回调处理；这里只负责把值合并进 cfg["brain"]。
BRAIN_MODES = ("kb", "flow", "fixed")

# 全量话术存内存；发送侧（brain/flow）按 device+stage+city 匹配
_device_scripts: list[dict] = []

# 人工接管中的会话（企微会话 ID）。drain 每轮读这里，命中就跳过不自动回复。
_takeover_sessions: set[str] = set()

# 已流失的会话（客户说「我不去了」）。drain 命中就整轮不碰，不再发任何消息。
_abandoned_sessions: set[str] = set()


# Recipient bindings may authorize sending, so only a live, account-scoped
# snapshot can supply them. Publish the account and rows together.
_recipient_binding_snapshot: tuple[str, dict[str, dict], float] = ("", {}, 0.0)
_RECIPIENT_BINDING_MAX_AGE = 90.0
_RECIPIENT_BINDING_STATES = {"conflict", "awaiting", "verified", "needs_confirmation"}


def recipient_bindings(account_id: str) -> dict[str, dict]:
    account, bindings, observed = _recipient_binding_snapshot
    if not account or account_id != account or time.monotonic() - observed > _RECIPIENT_BINDING_MAX_AGE:
        return {}
    return {cid: dict(binding) for cid, binding in bindings.items()}


def recipient_binding_account_active(account_id: str) -> bool:
    account, _, observed = _recipient_binding_snapshot
    return bool(account and account_id == account and time.monotonic() - observed <= _RECIPIENT_BINDING_MAX_AGE)


def _parse_recipient_binding_snapshot(remote: dict) -> tuple[str, dict[str, dict]]:
    account = remote.get("recipient_bindings_account_id")
    rows = remote.get("recipient_bindings")
    if not isinstance(account, str) or not account.strip() or not isinstance(rows, list):
        return "", {}
    account = account.strip()
    prefix, suffix = f"S:{account}_", f"_{account}"
    bindings, duplicates = {}, set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        cid, remark, status = (row.get(key) for key in ("conversation_id", "remark", "status"))
        if not all(isinstance(field, str) for field in (cid, remark, status)):
            continue
        if status not in _RECIPIENT_BINDING_STATES:
            continue
        if cid.startswith(prefix):
            other = cid[len(prefix):]
        elif cid.startswith("S:") and cid.endswith(suffix):
            other = cid[2:-len(suffix)]
        else:
            continue
        if not other or other == account:
            continue
        if cid in bindings:
            duplicates.add(cid)
        bindings[cid] = {"conversation_id": cid, "remark": remark, "status": status}
    for cid in duplicates:
        del bindings[cid]
    return account, bindings


def device_scripts() -> list[dict]:
    """当前生效的设备话术（拉不到远端时为 config.remote.json 兜底值，可能为空）。"""
    return list(_device_scripts)


def takeover_sessions() -> set[str]:
    """当前被人工接管的会话 ID 集合（拉不到远端时为空 = 全部自动回复）。"""
    return set(_takeover_sessions)


def abandoned_sessions() -> set[str]:
    """已流失的会话 ID 集合。命中后不再发送任何消息（人工可在网页上恢复）。

    和接管名单分开：接管是「这次我来回」，可以交还；流失是「这个人不找了」，
    需要人工显式恢复。混成一个集合会让「交还 AI」把流失的人也放回自动回复。
    """
    return set(_abandoned_sessions)


def _parse_session_list(value: object) -> set[str]:
    """远端名单只接受字符串数组；脏值一律当空，避免误把整个设备停掉。"""
    if not isinstance(value, list):
        return set()
    return {item.strip() for item in value if isinstance(item, str) and item.strip()}


# 兼容旧名（接管名单一直用这个解析器）
_parse_takeover = _parse_session_list


def _valid_seconds(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


def apply_remote_params(cfg: dict, remote: dict) -> list[str]:
    """远端有的键覆盖本地，返回发生变化的本地键名。

    只动运行参数；interval 不接受 0（与 load_config 的校验一致，0 会死循环）。
    brain_mode 只接受 kb/flow/fixed，写进 cfg["brain"]["mode"]，调用方据此重建 Brain。
    """
    changed: list[str] = []
    for remote_key, local_key in REMOTE_PARAM_KEYS.items():
        value = _valid_seconds(remote.get(remote_key))
        if value is None or (local_key == "interval" and value <= 0):
            continue
        if cfg.get(local_key) != value:
            cfg[local_key] = value
            changed.append(local_key)
    mode = remote.get("brain_mode")
    if isinstance(mode, str) and mode in BRAIN_MODES:
        brain = cfg.get("brain")
        if not isinstance(brain, dict):
            brain = {}
        if brain.get("mode") != mode:
            brain = {**brain, "mode": mode}
            cfg["brain"] = brain
            changed.append("brain_mode")
    return changed


def load_remote_cache(path: Path | None = None) -> dict:
    cache_path = path if path is not None else REMOTE_CONFIG_CACHE
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_remote_cache(data: dict, path: Path | None = None) -> None:
    cache_path = path if path is not None else REMOTE_CONFIG_CACHE
    tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(cache_path)


class RemoteConfig:
    """持有远端配置（version + 运行参数 + scripts），心跳时比对 version 热更。

    client 只要求有 fetch_config() -> dict | None（BridgeClient 满足；
    测试里注入假对象）。缓存 config.remote.json 含 version + scripts（外加
    运行参数），重启后即使 version 没变也会把缓存参数并回 cfg。
    """

    def __init__(self, client, cache_path: Path | None = None, log_fn=None) -> None:
        self.client = client
        self.cache_path = Path(cache_path) if cache_path is not None else REMOTE_CONFIG_CACHE
        self.log_fn = log_fn or (lambda msg: None)
        self.version = ""
        self.scripts: list[dict] = []
        self.params: dict = {}
        # 人工接管中的会话 ID；每次 version 变化时整体替换（不是增量合并，
        # 因为「交还 AI」是删除动作，增量合并没有办法表达删除）。
        self.takeover: set[str] = set()
        # 已流失的会话 ID（同上，整体替换）。
        self.abandoned: set[str] = set()
        # 最近一次 sync 里真正发生变化的本地键（含 "brain_mode"）。
        # 调用方据此决定要不要重建 Brain——Brain 在 main() 只构造一次，
        # 光改 cfg["brain"]["mode"] 不会切换行为。
        self.last_changed: list[str] = []
        global _recipient_binding_snapshot
        _recipient_binding_snapshot = ("", {}, 0.0)
        cached = load_remote_cache(self.cache_path)
        if cached:
            self.version = str(cached.get("version") or "")
            self.scripts = [s for s in (cached.get("scripts") or []) if isinstance(s, dict)]
            self.params = {
                key: value
                for key, value in cached.items()
                if key in REMOTE_PARAM_KEYS and _valid_seconds(value) is not None
            }
            # 重启后先按缓存里的名单工作，避免拉到新配置前误回不该回的会话
            self.takeover = _parse_takeover(cached.get("takeover_sessions"))
            self.abandoned = _parse_session_list(cached.get("abandoned_sessions"))
            global _device_scripts, _takeover_sessions, _abandoned_sessions
            _device_scripts = list(self.scripts)
            _takeover_sessions = set(self.takeover)
            _abandoned_sessions = set(self.abandoned)
        self._last_ok = True  # 有缓存可兜底就不算失败态，避免启动即报错

    def _fetch(self) -> dict | None:
        try:
            remote = self.client.fetch_config()
        except Exception:  # noqa: BLE001
            remote = None
        return remote if isinstance(remote, dict) and remote else None

    def sync(self, cfg: dict | None = None) -> bool:
        """心跳周期调用：比对 version，变了才热更参数/话术并写缓存。

        成功 True；拉不到返回 False（cfg 与缓存都不动，用兜底值）。
        """
        remote = self._fetch()
        if remote is None:
            if self._last_ok:
                self._last_ok = False
                self.log_fn("[远端配置] 拉取失败（忽略，用本地/缓存兜底）")
            return False
        self._last_ok = True
        global _recipient_binding_snapshot
        account, bindings = _parse_recipient_binding_snapshot(remote)
        _recipient_binding_snapshot = (account, bindings, time.monotonic())
        version = str(remote.get("version") or "")
        if version != self.version:
            scripts = remote.get("scripts")
            self.scripts = [s for s in scripts if isinstance(s, dict)] if isinstance(scripts, list) else []
            self.params = {
                key: float(value)
                for key, value in remote.items()
                if key in REMOTE_PARAM_KEYS and _valid_seconds(value) is not None
            }
            # 名单整体替换：远端没给这个键时保留上一次的值（老服务端不下发时
            # 不该把已接管的会话放回自动回复），给了才覆盖。
            if "takeover_sessions" in remote:
                self.takeover = _parse_takeover(remote.get("takeover_sessions"))
            if "abandoned_sessions" in remote:
                self.abandoned = _parse_session_list(remote.get("abandoned_sessions"))
            self.version = version
            global _device_scripts, _takeover_sessions, _abandoned_sessions
            _device_scripts = list(self.scripts)
            _takeover_sessions = set(self.takeover)
            _abandoned_sessions = set(self.abandoned)
            try:
                save_remote_cache(
                    {"version": version, **self.params, "scripts": self.scripts,
                     "takeover_sessions": sorted(self.takeover),
                     "abandoned_sessions": sorted(self.abandoned)},
                    self.cache_path,
                )
            except OSError as exc:
                self.log_fn(f"[远端配置] 缓存写盘失败（忽略）：{exc}")
            changed = apply_remote_params(cfg, remote) if cfg is not None else []
            self.last_changed = changed
            detail = f"，热更 {', '.join(changed)}" if changed else ""
            self.log_fn(
                f"[远端配置] version={version or '(空)'} scripts={len(self.scripts)} 条"
                f"，人工接管 {len(self.takeover)} 个会话{detail}"
            )
        elif cfg is not None and self.params:
            # 重启后 version 未变：config.json 可能还是旧值，把缓存参数并回去
            self.last_changed = apply_remote_params(cfg, self.params)
        else:
            self.last_changed = []
        return True

"""本地采集端入口。

一个循环做两件事：
1. 采集：源库有变化 → 解密 → 解析 → 上报服务端
2. 发送：向服务端领指令 → 键鼠发送 → 回执

用法：
    python main.py --once              # 跑一轮后退出（调试/验收用）
    python main.py                     # 常驻循环
    python main.py --once --dry-run    # 只采集不发送
    python main.py --send-test "你好" --to "文件传输助手"   # 单发一条验证键鼠
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

import client as agent_client
import collector
import sender

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "config.json"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_config(path: Path) -> dict:
    if not path.is_file():
        raise SystemExit(f"配置文件不存在：{path}\n先复制 config.example.json 并填 device_token")
    cfg = json.loads(path.read_text(encoding="utf-8"))
    # 注意：setdefault 对空字符串不生效，必须用 or —— 空值会把快照目录退化成当前目录
    cfg["snapshot_dir"] = cfg.get("snapshot_dir") or str(ROOT / ".snapshot")
    cfg["state_file"] = cfg.get("state_file") or str(ROOT / ".state.json")
    cfg["interval_seconds"] = int(cfg.get("interval_seconds") or 60)
    cfg["tool_path"] = cfg.get("tool_path") or ""
    cfg["dry_run"] = bool(cfg.get("dry_run"))
    cfg["send_mode"] = cfg.get("send_mode") or "search"  # search | current
    if not cfg.get("device_token") or "填" in str(cfg["device_token"]):
        raise SystemExit("config.json 里的 device_token 还是占位符，请填真实值")
    return cfg


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"signature": "", "last_msg": {}, "conv_names": {}}


def collect_once(cfg: dict, state: dict, api: agent_client.AgentClient) -> dict:
    uid, data_dir = collector.find_account_dir()
    signature = collector.source_signature(data_dir)

    convs = collector.load_conversations(Path(cfg["snapshot_dir"]))
    if signature != state.get("signature") or not convs:
        tool = Path(cfg["tool_path"]) if cfg["tool_path"] else None
        if not tool or not tool.is_file():
            raise RuntimeError("tool_path 未配置或文件不存在（需指向 wecomcracker.py）")
        t0 = time.time()
        collector.decrypt_snapshot(data_dir, Path(cfg["snapshot_dir"]), tool)
        log(f"解密完成 {time.time() - t0:.1f}s")
        convs = collector.load_conversations(Path(cfg["snapshot_dir"]))
        state["signature"] = signature

    messages = collector.load_messages(Path(cfg["snapshot_dir"]), uid, state.get("last_msg", {}))
    payload = collector.build_payload(uid, convs, messages)
    payload["account_name"] = f"企业微信({uid[-6:]})"

    result = api.ingest(payload)
    for m in messages:
        state.setdefault("last_msg", {})[m.conversation_id] = int(m.msg_id)
    state["conv_names"] = {c.external_id: c.name for c in convs}
    log(
        f"上报完成 会话 {len(convs)} / 新消息 {len(messages)} → "
        f"新建会话 {result.get('conversations_created')} 消息 {result.get('messages_created')} "
        f"跳过 {result.get('messages_skipped')}"
    )
    return result


def handle_commands(cfg: dict, state: dict, api: agent_client.AgentClient, wait: int = 0) -> int:
    commands = api.commands(wait=wait)
    done = 0
    for cmd in commands:
        conv_id = cmd.get("conversation_external_id", "")
        name = (state.get("conv_names") or {}).get(conv_id, "")
        if not name:
            api.ack(cmd["delivery_id"], "failed", error="本地找不到该会话名称，无法定位窗口")
            log(f"指令 {cmd['delivery_id']} 失败：未知会话 {conv_id}")
            continue
        try:
            result = sender.send_text(
                name, cmd["content"], switch=cfg["send_mode"] != "current", dry_run=cfg["dry_run"]
            )
            api.ack(cmd["delivery_id"], "sent", external_msgid=f"local-{cmd['delivery_id']}")
            log(f"指令 {cmd['delivery_id']} → {name}: {result['detail']}")
            done += 1
        except Exception as exc:  # noqa: BLE001
            api.ack(cmd["delivery_id"], "failed", error=f"{type(exc).__name__}: {exc}"[:200])
            log(f"指令 {cmd['delivery_id']} 失败：{exc}")
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description="企业微信本地采集端")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--once", action="store_true", help="跑一轮就退出")
    parser.add_argument("--dry-run", action="store_true", help="只采集，不真正发送")
    parser.add_argument("--skip-collect", action="store_true", help="只处理发送指令")
    parser.add_argument("--send-test", help="直接发一条测试文本")
    parser.add_argument("--to", default="文件传输助手", help="--send-test 的目标会话")
    args = parser.parse_args()

    cfg = load_config(Path(args.config))
    if args.dry_run:
        cfg["dry_run"] = True

    if args.send_test:
        print(
            sender.send_text(
                args.to, args.send_test, switch=cfg["send_mode"] != "current", dry_run=cfg["dry_run"]
            )
        )
        return 0

    api = agent_client.AgentClient(cfg["server"], cfg["device_token"])
    state_path = Path(cfg["state_file"])
    state = load_state(state_path)

    while True:
        try:
            if not args.skip_collect:
                collect_once(cfg, state, api)
                collector.dump_json(state_path, state)
            handle_commands(cfg, state, api, wait=0 if args.once else 20)
        except KeyboardInterrupt:
            return 0
        except Exception as exc:  # noqa: BLE001
            log(f"本轮失败：{agent_client.describe_error(exc)}")
            traceback.print_exc(limit=2)

        if args.once:
            return 0
        time.sleep(cfg["interval_seconds"])


if __name__ == "__main__":
    sys.exit(main())

"""历史会话档案补录：把客户导出的聊天记录抽成档案，补推给 4222。

跑法（在 ``backend/`` 下）::

    uv run python -m scripts.backfill_profiles --input 记录.txt --dry-run            # 默认
    uv run python -m scripts.backfill_profiles --input 记录.txt --commit --llm      # 写库+LLM 补抽
    uv run python -m scripts.backfill_profiles --input 记录.txt --commit --device pc-win-01

输入格式见 ``scripts/backfill_template.txt`` 与 ``docs/客户聊天记录补录说明.md``：
会话之间 ``=====`` 分隔；头部字段「设备:」「客户昵称:」「时间:」（「会话ID:」可选，
没有就把客户昵称当 session_key 试）；正文行首 ``客户:``/``运营:``（兼容 我:/顾问:）。

三条硬约束，改这个文件前先看：

1. **只补录已存在的会话**。4222 对定位不到的会话返回 404 且不新建（契约如此），
   404 的会话进失败清单并提示先在前端确认客户——本脚本不依赖 allow_create。
2. **不覆盖人工值**。推送前先 GET 对比，系统里已非空的键从推送体剔除；
   4222 是部分更新语义（出现的键才覆盖），所以剔除名单就是安全边界。
3. **不走 a_step**。本脚本只抽档案，绝不推进状态机：build_profile 出来的
   ``stage`` 一律丢弃，不往推送体里放。

幂等：本地 ``logs/backfill_state.json`` 记 会话指纹(昵称+首条客户消息 hash)→时间，
重跑自动跳过已成功会话。dry-run 只打印将推送的键与值，零写库（也不写状态文件）。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.services.flow_engine import absorb_profile, extract_city
from app.services.profile_push import DEFAULT_DEVICE
from app.services.profile_push import build_profile

# GET/POST 是 4222 的同一个端点，环境变量与 profile_push 保持同一套
PROFILE_URL = os.getenv("FLOW_PROFILE_URL", "http://127.0.0.1:4222/api/v1/agent/profile")
TIMEOUT = 10.0
STATE_PATH = Path(__file__).resolve().parents[2] / "logs" / "backfill_state.json"

# LLM 补抽的节流：并发 2、相邻调用间隔 0.5s（DeepSeek 中转站扛不住突发）
LLM_CONCURRENCY = 2
LLM_INTERVAL = 0.5
LLM_ATTEMPTS = 2  # 首发 + 失败重试 1 次

# ─────────────────────────── 解析 ───────────────────────────
_SEPARATOR = re.compile(r"^={4,}.*$", re.MULTILINE)
_HEADER_LINE = re.compile(r"^(设备|客户昵称|时间|会话ID|会话id)\s*[:：]\s*(.*)$")
_ROLE_LINE = re.compile(r"^(客户|运营|我|顾问)\s*[:：]\s*(.*)$")
_ROLE_OF = {"客户": "customer", "我": "customer", "运营": "operator", "顾问": "operator"}


@dataclass
class ChatBlock:
    """一个会话块。messages 是 (role, text)，role 只有 customer/operator。"""

    device: str = ""
    nickname: str = ""
    time_text: str = ""
    session_key_hint: str = ""  # 「会话ID:」字段，可选
    messages: list[tuple[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class SkippedBlock:
    """解析失败被跳过的块，reason 给人看。"""

    index: int
    reason: str
    head: str


def parse_blocks(text: str) -> tuple[list[ChatBlock], list[SkippedBlock]]:
    """txt → 会话块列表 + 跳过清单。空块直接忽略，坏块进跳过清单。"""
    blocks: list[ChatBlock] = []
    skipped: list[SkippedBlock] = []
    raw_chunks = _SEPARATOR.split(text) if _SEPARATOR.search(text) else [text]
    # _SEPARATOR.split 丢掉了分隔符本身，split 后每段就是一个块
    for chunk in raw_chunks:
        lines = [line.rstrip() for line in chunk.splitlines()]
        if not any(line.strip() for line in lines):
            continue
        block = ChatBlock()
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            header = _HEADER_LINE.match(stripped)
            if header:
                label, value = header.group(1), header.group(2).strip()
                if label == "设备":
                    block.device = value
                elif label == "客户昵称":
                    block.nickname = value
                elif label == "时间":
                    block.time_text = value
                else:
                    block.session_key_hint = value
                continue
            role = _ROLE_LINE.match(stripped)
            if role:
                block.messages.append((_ROLE_OF[role.group(1)], role.group(2).strip()))
                continue
            block.warnings.append(f"无法识别的行（已忽略）：{stripped[:40]}")
        head = next((ln for ln in lines if ln.strip()), "")
        if not block.nickname:
            skipped.append(SkippedBlock(len(blocks) + len(skipped) + 1, "缺少「客户昵称」头部字段", head))
            continue
        if not any(role == "customer" for role, _ in block.messages):
            skipped.append(SkippedBlock(len(blocks) + len(skipped) + 1, "没有客户发言", head))
            continue
        blocks.append(block)
    return blocks, skipped


def fingerprint(nickname: str, messages: list[tuple[str, str]]) -> str:
    """会话指纹：昵称 + 首条客户消息。同一次补录重跑时用来跳过已成功会话。"""
    first_customer = next((text for role, text in messages if role == "customer"), "")
    digest = hashlib.sha256(f"{nickname}|{first_customer}".encode("utf-8")).hexdigest()
    return digest[:32]


# ─────────────────────────── 确定性抽取 ───────────────────────────
def extract_slots_deterministic(messages: list[tuple[str, str]]) -> dict[str, Any]:
    """只看客户发言，逐条 absorb_profile + extract_city（零成本，不碰 LLM）。"""
    slots: dict[str, Any] = {}
    for role, text in messages:
        if role != "customer":
            continue
        absorb_profile(slots, text)
        city = extract_city(text)
        if city:
            slots["city"] = city
    return slots


# ─────────────────────────── LLM 补抽 ───────────────────────────
_LLM_SYSTEM = (
    "你是招聘运营助理。下面是一段运营与客户（求职者）的聊天记录，"
    "请从**客户说的话**里提取档案字段，只输出一个严格的 JSON 对象，"
    "不要 markdown、不要解释。格式：\n"
    '{"city":"","gender":"","name":"","phone":"","job_title":"","notes":""}\n'
    "- city：客户想去工作的城市（如 广州/深圳/东莞）\n"
    "- gender：男 或 女，没提到就空串\n"
    "- name：客户自报的姓名，没提到空串\n"
    "- phone：11 位手机号，没提到空串\n"
    "- job_title：客户感兴趣的岗位/工种，没提到空串\n"
    "- notes：客户的其他要求或备注（如「要长白班」），没有空串\n"
    "只用客户说的内容，运营说的话不算；不确定就留空串。"
)


def render_transcript(messages: list[tuple[str, str]]) -> str:
    """会话块 → 整段文本，喂给 LLM 一次抽完。"""
    return "\n".join(f"{'客户' if role == 'customer' else '运营'}: {text}" for role, text in messages)


def parse_llm_json(content: str) -> dict[str, str]:
    """LLM 输出 → 字段 dict。剥掉代码围栏、截取首个 {...}，坏输出给空 dict。"""
    text = (content or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): value for key, value in data.items() if isinstance(value, (str, int))}


def merge_llm_slots(slots: dict[str, Any], data: dict[str, str]) -> None:
    """LLM 结果只填确定性抽取没抽到的键，绝不覆盖已有值。"""
    for key in ("city", "gender", "name", "phone", "job_title", "notes"):
        value = str(data.get(key) or "").strip()
        if not value:
            continue
        if key == "gender" and value not in ("男", "女"):
            value = ""
        if not value:
            continue
        if not str(slots.get(key) or "").strip():
            slots[key] = value


def build_llm_messages(transcript: str) -> list[Any]:
    """OpenAI 协议消息列表。用延迟导入避免测试环境强依赖 llm_provider。"""
    from app.services.llm_provider import ChatMessage

    return [ChatMessage(role="system", content=_LLM_SYSTEM), ChatMessage(role="user", content=transcript)]


async def extract_all_llm(provider: Any, blocks: list[ChatBlock]) -> list[dict[str, str] | None]:
    """每会话整段拼一次 LLM 调用；Semaphore(2) + 间隔 0.5s，失败重试 1 次后跳过记录。"""
    semaphore = asyncio.Semaphore(LLM_CONCURRENCY)
    last_started = 0.0

    async def one(block: ChatBlock) -> dict[str, str] | None:
        nonlocal last_started
        transcript = render_transcript(block.messages)
        async with semaphore:
            for attempt in range(LLM_ATTEMPTS):
                gap = LLM_INTERVAL - (time.monotonic() - last_started)
                if gap > 0:
                    await asyncio.sleep(gap)
                last_started = time.monotonic()
                try:
                    content = await provider.complete(build_llm_messages(transcript))
                    return parse_llm_json(content)
                except Exception:  # noqa: BLE001  LLM 挂了不连累其他会话
                    continue
        return None

    return list(await asyncio.gather(*(one(block) for block in blocks)))


# ─────────────────────────── GET 对比与推送 ───────────────────────────
# profile 键 → GET 返回里可能存放现值的键（列名 + profile_json 里的键）
_EXISTING_SOURCES: dict[str, tuple[str, ...]] = {
    "name": ("name",),
    "phone": ("phone",),
    "province": ("province",),
    "city": ("city",),
    "district": ("district",),
    "gender": ("gender",),
    "record": ("record",),
    "age": ("age",),
    "job_title": ("job_title",),
    "factory_name": ("factory_name",),
    "interview_date": ("interview_date",),
    "interview_time": ("interview_time",),
    "notes": ("notes", "remark"),  # 4222 把 8090 的 notes 存进 remark 列
}

# GET 返回里与档案列同名的顶层键（权威值，盖过 profile_json 里的旧副本）
_COLUMN_KEYS = (
    "name", "phone", "factory_name", "interview_date", "interview_time",
    "province", "city", "district", "remark",
)


def flatten_current(response: dict[str, Any]) -> dict[str, Any]:
    """GET /agent/profile 的响应 → 现值字典：profile_json 打底，列值覆盖。"""
    current = dict(response.get("profile") or {})
    for key in _COLUMN_KEYS:
        if key in response:
            current[key] = response[key]
    return current


def _filled(value: Any) -> bool:
    """「系统里已非空」：非空字符串，或正整数（age）。空串/0/None 都算空。"""
    if value is None:
        return False
    if isinstance(value, int):
        return value > 0
    return bool(str(value).strip())


def drop_filled_keys(profile: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """系统里已非空的键从推送体剔除（不覆盖人工值），空字段照推。"""
    if not current:
        return dict(profile)
    flat = flatten_current(current)
    return {
        key: value
        for key, value in profile.items()
        if not any(_filled(flat.get(source)) for source in _EXISTING_SOURCES.get(key, (key,)))
    }


def build_push_profile(slots: dict[str, Any]) -> dict[str, Any]:
    """slots → 推送体。复用 build_profile 字段契约，但丢掉 stage（不推进状态机）。"""
    profile = build_profile(slots)
    profile.pop("stage", None)
    explicit_title = str(slots.get("job_title") or "").strip()
    if explicit_title:
        # build_profile 的 job_title 来自城市岗位表；客户点名的岗位优先。
        # 岗位名带空格（如「钟村电子厂 组装工」）时首段就是厂名，一并修正
        profile["job_title"] = explicit_title
        if " " in explicit_title:
            profile["factory_name"] = explicit_title.split(" ", 1)[0]
        elif not profile.get("factory_name"):
            profile["factory_name"] = explicit_title
    return profile


def _headers(token: str) -> dict[str, str]:
    return {"X-Profile-Token": token}


async def fetch_current(
    client: httpx.AsyncClient, token: str, device: str, session_key: str
) -> tuple[int, dict[str, Any]]:
    """GET 现状。返回 (status_code, body)；404/异常时 body 为空 dict。"""
    try:
        resp = await client.get(
            PROFILE_URL,
            params={"device_code": device, "external_conversation_id": session_key},
            headers=_headers(token),
        )
        return resp.status_code, (resp.json() if resp.status_code < 300 else {})
    except Exception:  # noqa: BLE001  4222 挂了按失败处理
        return 0, {}


async def push_profile(
    client: httpx.AsyncClient, token: str, device: str, session_key: str, profile: dict[str, Any]
) -> int:
    """POST 推送，返回状态码（404 会被调用方特殊标注）。"""
    body = {
        "device_code": device or DEFAULT_DEVICE,
        "external_conversation_id": session_key,
        "profile": profile,
    }
    try:
        resp = await client.post(PROFILE_URL, json=body, headers=_headers(token))
        return resp.status_code
    except Exception:  # noqa: BLE001
        return 0


# ─────────────────────────── 幂等状态 ───────────────────────────
def load_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def is_done(state: dict[str, Any], fp: str) -> bool:
    """指纹已在状态里且结果是 ok → 重跑跳过。"""
    return str(state.get(fp, {}).get("result")) == "ok"


# ─────────────────────────── 主流程 ───────────────────────────
def _fmt_slots(slots: dict[str, Any]) -> str:
    return "  ".join(f"{key}={value}" for key, value in slots.items() if value not in ("", None)) or "（无）"


async def run(args: argparse.Namespace) -> int:
    text = Path(args.input).read_text(encoding="utf-8")
    blocks, skipped = parse_blocks(text)
    for item in skipped:
        print(f"[跳过] 块 {item.index}：{item.reason}（开头：{item.head[:20]}…）")

    provider = None
    if args.llm:
        from app.services.llm_provider import build_provider

        provider = build_provider()
        if provider is None:
            print("警告：未配置 LLM（APP_LLM_API_KEY 等），--llm 无效，仅用确定性抽取")
    llm_results: list[dict[str, str] | None] = (
        await extract_all_llm(provider, blocks) if provider else [None] * len(blocks)
    )

    token = os.getenv("FLOW_PROFILE_TOKEN", "").strip()
    state = load_state(STATE_PATH)
    state_dirty = False
    ok = fail = skip = 0
    failures: list[str] = []

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for index, (block, llm) in enumerate(zip(blocks, llm_results), start=1):
            device = block.device or args.device or DEFAULT_DEVICE
            session_key = block.session_key_hint or block.nickname
            fp = fingerprint(block.nickname, block.messages)
            title = f"[{index}/{len(blocks)}] {block.nickname}（session_key={session_key}，设备={device}）"

            if is_done(state, fp):
                print(f"{title} 已成功过，跳过")
                skip += 1
                continue

            if args.llm and provider is not None and llm is None:
                reason = "LLM 补抽失败（重试 1 次仍失败），本轮跳过"
                print(f"{title} {reason}")
                failures.append(f"{block.nickname}: {reason}")
                fail += 1
                continue

            slots = extract_slots_deterministic(block.messages)
            if llm:
                merge_llm_slots(slots, llm)
            profile = build_push_profile(slots)

            if not args.commit:
                print(f"{title} dry-run 将推送：")
                for key, value in profile.items():
                    print(f"    {key} = {value}")
                if not profile:
                    print("    （没有可推送的字段）")
                ok += 1
                continue

            status, current = await fetch_current(client, token, device, session_key)
            if status == 404:
                reason = "会话不存在，先在前端确认客户"
                print(f"{title} 推送失败：{reason}")
                failures.append(f"{block.nickname}（session_key={session_key}）: {reason}")
                fail += 1
                continue
            if status == 0:
                reason = "4222 不可达或网络异常"
                print(f"{title} 推送失败：{reason}")
                failures.append(f"{block.nickname}（session_key={session_key}）: {reason}")
                fail += 1
                continue

            profile = drop_filled_keys(profile, current or {})
            if not profile:
                print(f"{title} 系统里已有值，无新增字段，跳过推送")
                skip += 1
                continue

            status = await push_profile(client, token, device, session_key, profile)
            if 200 <= status < 300:
                print(f"{title} 推送成功：{_fmt_slots(profile)}")
                state[fp] = {
                    "result": "ok",
                    "session_key": session_key,
                    "nickname": block.nickname,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "pushed": sorted(profile.keys()),
                }
                state_dirty = True
                ok += 1
            else:
                reason = f"HTTP {status}"
                print(f"{title} 推送失败：{reason}")
                failures.append(f"{block.nickname}（session_key={session_key}）: {reason}")
                fail += 1

    if args.commit and state_dirty:
        save_state(STATE_PATH, state)

    print(f"\n===== 汇总：成功 {ok} / 跳过 {skip} / 失败 {fail}（解析跳过 {len(skipped)} 块）=====")
    for item in failures:
        print(f"  [失败] {item}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="backfill_profiles", description="历史会话档案补录（推 4222，只补已存在的会话）"
    )
    parser.add_argument("--input", required=True, help="聊天记录 txt 文件路径")
    parser.add_argument("--commit", action="store_true", help="真正写库；缺省为 dry-run 只打印")
    parser.add_argument("--llm", action="store_true", help="启用 LLM 补抽（DeepSeek，走 settings 配置）")
    parser.add_argument("--device", default="", help="块内没写「设备:」时使用的设备号")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())

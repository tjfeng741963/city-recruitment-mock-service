"""上报前的「回声」防御：客户原话被当成 AI 出站时的兜底。

背景（2026-11-13 实测）：4222 的 agent_messages 里出现 direction=outbound、
内容却是客户原话的记录（「深圳的」「广州」「你好」「工资多少」），
created_at 还正好等于客户那条消息的 sent_at —— 同一条事件曾经以 outbound
方向进过桥接队列。方向的唯一依据是 message_table.sender_id 与自己的 id 比对，
只要这一层判错一次（self_id 取错、队列里方向串了、游标回退重放、重复实例），
客户原话就会变成 AI 发言，污染会话历史与档案/阶段。

这里不去猜上游，而是按内容兜一层：出站消息如果 60 秒内同会话存在文本完全
相同或高度相似（>85%）的入站，就判为回声。

为什么是「丢弃 outbound」而不是「改成 inbound 重报」：
入站那条通常已经上报过（同一个 msgid 走的是 inbound 通道），改方向重报会
在同一个 sent_at 上再多出一条同文本的入站气泡，前端照样错乱。

本模块只依赖标准库，方便单测直接 import。
"""

from __future__ import annotations

import difflib
import re
from datetime import datetime

ECHO_WINDOW = 60.0        # 秒：同会话、这个时间窗内的入站才算「回声候选」
ECHO_SIMILARITY = 0.85    # 归一化后的相似度阈值

_SPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """去掉空白并统一小写，用于比对（挤掉换行/空格造成的差异）。"""
    return _SPACE.sub("", (text or "")).strip().lower()


def similarity(left: str, right: str) -> float:
    """归一化后的相似度 0~1；任一为空返回 0。"""
    a, b = normalize(left), normalize(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _sent_ts(value: object) -> float:
    """sent_at 可能是 ISO 串（带时区）或秒级数字；解析不出来返回 0。"""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _conversation_of(item: dict) -> str:
    return str(item.get("external_conversation_id") or item.get("conv_id") or "")


def _content_of(item: dict) -> str:
    return str(item.get("content") or item.get("text") or "")


def filter_echo_messages(
    messages: list[dict],
    *,
    pool: list[dict] | None = None,
    window: float = ECHO_WINDOW,
    threshold: float = ECHO_SIMILARITY,
) -> tuple[list[dict], list[tuple[dict, dict, float]]]:
    """丢弃疑似回声的出站消息。

    messages: 本批要上报的消息（字段与 Reporter._collect 一致）
    pool:     额外的入站来源（一般是本地库最近消息），用来匹配不在本批里的那条

    返回 (保留的消息, [(被丢弃的出站, 匹配到的入站, 相似度), ...])
    """
    inbound: dict[str, list[tuple[float, str, dict]]] = {}
    for source in (pool or []), messages:
        for item in source:
            if item.get("direction") != "inbound":
                continue
            key = normalize(_content_of(item))
            if not key:
                continue
            inbound.setdefault(_conversation_of(item), []).append(
                (_sent_ts(item.get("sent_at")), key, item)
            )

    kept: list[dict] = []
    dropped: list[tuple[dict, dict, float]] = []
    for item in messages:
        if item.get("direction") != "outbound":
            kept.append(item)
            continue
        key = normalize(_content_of(item))
        if not key:
            kept.append(item)          # 空文本（图片/卡片）无从比对，原样放行
            continue
        ts = _sent_ts(item.get("sent_at"))
        hit: tuple[dict, float] | None = None
        for its, ikey, matched in inbound.get(_conversation_of(item), ()):
            if ts and its and abs(its - ts) > window:
                continue
            score = 1.0 if ikey == key else difflib.SequenceMatcher(None, key, ikey).ratio()
            if score >= threshold:
                hit = (matched, score)
                break
        if hit is None:
            kept.append(item)
        else:
            dropped.append((item, hit[0], hit[1]))
    return kept, dropped

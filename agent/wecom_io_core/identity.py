"""方向判定的纯逻辑：从会话 id 反推「自己」，再决定消息方向。

依据（企微本地库的真实结构）：
  - `message_table.sender_id` 就是真实发送方（自己的会话成员 id 或对方 id），
    库里没有「是否我发的」布尔列，方向只能由 sender_id 与自己的 id 比对得出；
  - 单聊会话 id 恒为 `S:<A>_<B>`，A/B 里必有一个是自己；自己在**每一个**单聊里
    都出现一次，而对方只出现一次 —— 所以出现次数最多的那个 id 就是自己。
    这条证据来自库本身，比数据目录名（`Documents/WXWork/<vid>/Data`）可靠：
    目录名在 data_dir 被显式配置成副本目录、或多账号切换时会取错，
    一旦取错，整批消息的方向会一起翻转。

本模块只依赖标准库，方便单测直接 import。
"""

from __future__ import annotations

from collections.abc import Iterable


def split_single_chat(conversation_id: str) -> tuple[str, str] | None:
    """`S:<a>_<b>` -> (a, b)；不是单聊返回 None。"""
    cid = (conversation_id or "").strip()
    if not cid.startswith("S:") or "_" not in cid:
        return None
    left, right = cid[2:].split("_", 1)
    return (left, right) if left and right else None


def infer_self_id(conversation_ids: Iterable[str]) -> tuple[str, int]:
    """从单聊会话 id 里投票出自己：返回 (id, 票数)。"""
    votes: dict[str, int] = {}
    for cid in conversation_ids:
        sides = split_single_chat(cid)
        if sides is None:
            continue
        for side in sides:
            votes[side] = votes.get(side, 0) + 1
    if not votes:
        return "", 0
    return max(votes.items(), key=lambda kv: kv[1])


def resolve_self_id(conversation_ids: Iterable[str], dir_id: str = "") -> tuple[str, str]:
    """返回 (自己的 id, 判定来源)。

    只有会话证据明显更强（同一个 id 出现在 >=2 个单聊里）时才推翻目录名，
    避免只有一两个会话时把对方误当成自己。
    """
    dir_id = (dir_id or "").strip()
    voted, votes = infer_self_id(conversation_ids)
    if not voted:
        return dir_id, "data-dir" if dir_id else "unknown"
    if not dir_id:
        return voted, "session-majority"
    if voted == dir_id:
        return dir_id, "data-dir+session"
    if votes >= 2:
        return voted, "session-majority"
    return dir_id, "data-dir"


def counterpart_of(conversation_id: str, self_id: str) -> str:
    """单聊里的对方 id；群聊/系统会话或认不出自己时返回空串。"""
    sides = split_single_chat(conversation_id)
    if sides is None or not self_id:
        return ""
    left, right = sides
    if left == self_id:
        return right
    if right == self_id:
        return left
    return ""


def direction_of(sender_id: str, self_id: str, conversation_id: str = "") -> str:
    """inbound / outbound。

    单聊先用「对方」判定（sender 是对方 → inbound），再用自己兜底；
    认不出对方时退回 sender == self_id。两条规则都不成立就按 inbound，
    宁可把消息当客户说的，也不要把客户原话当 AI 发言写进档案。
    """
    sender = str(sender_id or "").strip()
    if not sender:
        return "inbound"
    other = counterpart_of(conversation_id, self_id)
    if other and sender == other:
        return "inbound"
    if self_id and sender == self_id:
        return "outbound"
    return "inbound"

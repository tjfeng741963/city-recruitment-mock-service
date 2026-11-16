"""老客户识别（客户原话：「老友管理这个是从客户聊天后，ai 判断转为老友的」）。

业务后果很重：一旦被标成「不可聊」，AI 就不再自动回复这位客户，等他人工放行。
所以这里的判定必须是**保守**的——只认客户自己说「我来过」，绝不靠猜：

    命中：「我之前来过」「上次面试」「以前在你们这干过」「又来问一下」

反过来，像「done 之后又来消息」这种信号**不采用**：客户约完面试再问工资、
换个城市看看，都是正常业务，把他标成老客户等于让 AI 闭嘴，属于误伤。

这也是为什么判定放在**入站文本**上（客户说的话），而不是像打标签那样放在
出站文本上——「老客户」这件事只有客户本人会提，AI 不会替客户宣布。
"""

from __future__ import annotations

import re
from typing import Any

# 每条都是「客户自述过去来过」，避免单个动词造成的误判：
#   「之前」单独出现太常见（「之前说的工资」），必须与「来过/问过/面试」组合。
OLD_FRIEND_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"之前(?:来|去|到|在)?(?:过|你们|咱)"),
    re.compile(r"上次(?:来|面试|报名|问|说|干|做|在)"),
    re.compile(r"以前(?:来|在|面试|报名|干|做|问)过?"),
    re.compile(r"又来(?:问|找|看|了解)"),
    re.compile(r"再次(?:来|咨询|问)"),
    re.compile(r"(?:之前|以前)(?:跟|和|在)?(?:你们|咱)(?:聊|说|问|干|做)"),
    re.compile(r"我(?:之前|以前)?(?:在|跟)(?:你们|咱)"),
    re.compile(r"老客户|老员工|回头客"),
)


def detect_old_friend(text: str) -> str:
    """命中返回触发短语（用于审计与人工复核），否则返回空串。"""
    content = str(text or "").strip()
    if not content:
        return ""
    for pattern in OLD_FRIEND_PATTERNS:
        match = pattern.search(content)
        if match:
            return match.group(0)
    return ""


def old_friend_fields(text: str) -> dict[str, Any]:
    """给 profile 推送用的字段；没命中就不出现（4222 是「出现的键才覆盖」）。"""
    phrase = detect_old_friend(text)
    if not phrase:
        return {}
    return {"old_friend": True, "old_friend_reason": phrase}


__all__ = ["OLD_FRIEND_PATTERNS", "detect_old_friend", "old_friend_fields"]

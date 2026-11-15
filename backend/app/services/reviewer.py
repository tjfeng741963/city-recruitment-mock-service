"""审核智能体 B：逐条把关要发给客户的消息。

分工：A（flow_llm）负责聊，B 负责审。B 是**增强，不是闸门**：
- provider 不可用 / 超时 / 返回乱码 → 直接 pass，绝不拦住客户该收到的消息
- 打回不无限循环：flow_llm.review_loop 最多 2 轮，之后按兜底强制发送

审核规则（硬伤用代码查，判断题交给模型）：
① 数字必须来自事实卡（A 侧 _fact_guard 与渲染层 render_script 是主闸门，B 复核）
② 不得重复 transcript 最近 2 轮已说过的内容（代码近似判重 + 模型复核）
③ 不得答非所问（模型判断）
④ 不得出现占位符残留（{{x}} / {x}，代码查；【图片:x】媒体标记不受影响）
⑤ 语气合规：不承诺「保证进」、不收费用（模型判断）

运营话术（is_script=True）：B 无权改写文案，只能「过」或按占位符残留/数字
错误打回渲染层；渲染层 render_script 已保证数字与已知占位符，所以话术的
复核只跑代码级硬伤检查，不进模型。
"""

from __future__ import annotations

import json
import re
from typing import Any

from .agent_session import transcript_lines
from .llm_provider import ChatMessage, LLMProvider, build_provider

# 占位符残留：{{x}} 或单个 {x}（媒体标记【图片:x】是全角括号，不会误伤）
_PLACEHOLDER = re.compile(r"\{\{?\w+\}?\}")
# 判重前把空白与标点抹掉：只换标点/语气词不算新话
_NORMALIZE = re.compile(r"[\s\W_]+")

REVIEW_SYSTEM = """你是劳务中介对话的审核员。招聘顾问每条要发给客户的消息，你逐条把关。

# 审核规则（按顺序检查，命中任何一条就打回）
1. 数字违规：草稿里出现的工价/钱数不在事实卡里 → 打回
2. 占位符残留：出现 {{xxx}} 或 {xxx} 这类没替换掉的占位符 → 打回
3. 重复：草稿和最近对话里「你」已说过的内容雷同（只换标点/语气词不算新话）→ 打回
4. 答非所问：客户明确问了一件事，草稿完全没接 → 打回
5. 语气合规：承诺「保证进」「百分百上岸」或提到向客户收任何费用 → 打回

# 输出格式（必须是 JSON，不要代码块，不要多余文字）
{"verdict": "pass"}
或
{"verdict": "revise", "reason": "哪里不行", "suggestion": "怎么改"}

拿不准就 pass——审核是增强，不是闸门，不能让客户收不到消息。
"""


def _hard_checks(
    draft: list[str], fact_card: str, transcript: list[dict[str, str]]
) -> dict[str, str] | None:
    """代码级硬伤检查：④ 占位符残留 + ② 与最近 2 轮我方内容近似判重。"""
    text = "\n".join(draft)
    if _PLACEHOLDER.search(text):
        return {
            "verdict": "revise",
            "reason": "草稿里有没替换掉的占位符（{{x}} 或 {x}）",
            "suggestion": "占位符必须替换成真实内容，占位符本身绝不能发给客户",
        }
    key = _NORMALIZE.sub("", text)
    if key:
        recent = [
            item.get("content", "")
            for item in transcript
            if item.get("role") == "assistant"
        ][-2:]
        for prev in recent:
            if prev and key == _NORMALIZE.sub("", prev):
                return {
                    "verdict": "revise",
                    "reason": "和最近已经发给客户的内容重复",
                    "suggestion": "换个说法，不要把说过的话原样再发一遍",
                }
    return None


def _parse_verdict(raw: str) -> dict[str, str]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("审核没返回 JSON")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("审核返回的不是对象")
    if str(data.get("verdict") or "").strip().lower() == "revise":
        return {
            "verdict": "revise",
            "reason": str(data.get("reason") or ""),
            "suggestion": str(data.get("suggestion") or ""),
        }
    return {"verdict": "pass"}


class Reviewer:
    """B 的执行体。provider 为 None 时只跑代码级检查（①⑤ 不复核）。"""

    def __init__(self, provider: LLMProvider | None) -> None:
        self.provider = provider

    async def review(
        self,
        transcript: list[dict[str, str]],
        draft: list[str],
        fact_card: str,
        job_snapshot: dict[str, Any] | None = None,
        is_script: bool = False,
    ) -> dict[str, str]:
        del job_snapshot  # 事实卡的文字版 fact_card 已含全部数字，快照不再重复给
        hard = _hard_checks(draft, fact_card, transcript)
        if hard:
            return hard
        if self.provider is None or is_script:
            # 话术只查残留/重复（上面代码级已查完）：B 无权用模型意见改写运营文案
            return {"verdict": "pass"}
        try:
            raw = await self.provider.complete(
                self._messages(transcript, draft, fact_card, is_script),
                temperature=0.1,
                max_tokens=300,
            )
            return _parse_verdict(raw)
        except Exception:  # noqa: BLE001  超时/乱码：审核放行，不让客户等
            return {"verdict": "pass"}

    def _messages(
        self,
        transcript: list[dict[str, str]],
        draft: list[str],
        fact_card: str,
        is_script: bool,
    ) -> list[ChatMessage]:
        script_note = (
            "\n（注意：草稿是运营话术，无权改写文案——只能 pass，"
            "或按占位符残留/数字错误打回）" if is_script else ""
        )
        user = (
            f"# 最近对话\n{transcript_lines(transcript) or '（还没有）'}\n\n"
            f"# 事实卡（数字唯一合法来源）\n{fact_card or '（无）'}\n\n"
            f"# 待审草稿{script_note}\n" + "\n".join(f"- {part}" for part in draft)
        )
        return [
            ChatMessage(role="system", content=REVIEW_SYSTEM),
            ChatMessage(role="user", content=user),
        ]


def build_reviewer() -> Reviewer | None:
    """按环境变量组装 B。没配 LLM 就返回 None——审核直接缺席，流程照常。"""
    provider = build_provider()
    if provider is None:
        return None
    return Reviewer(provider)

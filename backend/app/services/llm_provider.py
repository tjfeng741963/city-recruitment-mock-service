"""LLM Provider 层：一个 OpenAI 兼容实现，接所有供应商。

为什么不给每家写适配器（docs/知识库与后端技术选型-决策文档.md 4.5 节）：
中转站本身就是 OpenAI 协议，换豆包/DeepSeek/其他只是改 base_url + model。
业务层只依赖 `LLMProvider` 协议，切模型、灰度对比都是改一行配置。

降级是硬要求：**绝不因为 LLM 不可用就不回复客户**。
主中转站超时 → 重试 1 次 → 仍失败 → 抛 `LLMUnavailable`，
调用方据此降级到模板回复并记 `llm_fallback` 日志。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx


class LLMUnavailable(Exception):
    """所有重试都失败。调用方必须降级，不要把异常抛给客户。"""


@dataclass(frozen=True)
class ChatMessage:
    role: str  # system / user / assistant
    content: str


class LLMProvider(Protocol):
    async def complete(self, messages: list[ChatMessage], **kwargs: object) -> str: ...


@dataclass
class OpenAICompatibleProvider:
    """所有 LLM 走同一个实现。换供应商只改这三个字段。"""

    base_url: str
    api_key: str
    model: str
    timeout: float = 30.0
    max_retries: int = 1

    async def complete(self, messages: list[ChatMessage], **kwargs: object) -> str:
        payload = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            **kwargs,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        url = self.base_url.rstrip("/") + "/chat/completions"

        last_error: Exception | None = None
        for _ in range(self.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.post(url, json=payload, headers=headers)
                    resp.raise_for_status()
                    data = resp.json()
                choices = data.get("choices") or []
                if not choices:
                    raise LLMUnavailable("上游返回空 choices")
                content = (choices[0].get("message") or {}).get("content")
                if not isinstance(content, str):
                    raise LLMUnavailable("上游回复缺少 content")
                return content
            except (httpx.HTTPError, LLMUnavailable, ValueError) as exc:
                last_error = exc

        raise LLMUnavailable(f"LLM 调用失败：{last_error}")


@dataclass
class MockProvider:
    """测试用。按预设返回，不碰网络。"""

    reply: str = "（模板回复）"

    async def complete(self, messages: list[ChatMessage], **kwargs: object) -> str:
        del messages, kwargs
        return self.reply

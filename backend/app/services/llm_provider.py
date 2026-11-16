"""LLM Provider 层：一个 OpenAI 兼容实现，接所有供应商。

为什么不给每家写适配器（docs/知识库与后端技术选型-决策文档.md 4.5 节）：
中转站本身就是 OpenAI 协议，换豆包/DeepSeek/其他只是改 base_url + model。
业务层只依赖 `LLMProvider` 协议，切模型、灰度对比都是改一行配置。

降级是硬要求：**绝不因为 LLM 不可用就不回复客户**。
主中转站超时 → 重试 1 次 → 仍失败 → 抛 `LLMUnavailable`，
调用方据此降级到模板回复并记 `llm_fallback` 日志。
"""

from __future__ import annotations

import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Protocol

import httpx


class LLMUnavailable(Exception):
    """所有重试都失败。调用方必须降级，不要把异常抛给客户。"""


@dataclass(frozen=True)
class ChatMessage:
    role: str  # system / user / assistant
    content: str


# ── 调用留痕（灰度诊断用）─────────────────────────────────────────────
# 目标：AI 没有黑盒。每条回复都能查到「调了几次模型、用的哪个模型、发了什么 prompt、
# 模型原样返回了什么、花了多久、用掉多少 token、有没有重试、失败原因是什么」。
#
# 为什么用 ContextVar 而不是给 complete() 加参数：它被 A 生成、B 审核、知识库改写
# 三处共用，逐层透传会把签名改得到处都是；ContextVar 在同一请求协程内自动共享，
# 调用点一行都不用动。
#
# 隐私：prompt 与返回里含客户原话。APP_LLM_TRACE_ENABLED 可以整体关掉，
# 关掉后只记元数据（模型/耗时/token/成败），不记正文。
_CALLS: ContextVar[list[dict[str, Any]] | None] = ContextVar("llm_calls", default=None)


def begin_llm_trace() -> None:
    """一轮对话开始前调用。已经有收集器就复用，不会覆盖。"""
    if _CALLS.get() is None:
        _CALLS.set([])


def collect_llm_trace() -> list[dict[str, Any]]:
    """取走本轮所有模型调用记录，并清空收集器。"""
    calls = _CALLS.get() or []
    _CALLS.set(None)
    return calls


def _trace_options() -> tuple[bool, int]:
    """(是否记录正文, 正文截断长度)。读配置失败时按「不记正文」处理——安全优先。"""
    try:
        from ..settings import settings

        return bool(settings.llm_trace_enabled), max(200, int(settings.llm_trace_max_chars))
    except Exception:  # noqa: BLE001
        return False, 2000


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    # 把「被截断」这个事实记下来，否则复盘时会把半截 prompt 当成完整输入。
    return f"{text[:limit]}…[截断，原长 {len(text)}]"


def _record(entry: dict[str, Any]) -> None:
    calls = _CALLS.get()
    if calls is None:
        return  # 没开收集（例如单测直接调 provider），不产生任何副作用
    calls.append(entry)


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

        keep_text, clip_limit = _trace_options()
        entry: dict[str, Any] = {
            "model": self.model,
            "temperature": kwargs.get("temperature"),
            "max_tokens": kwargs.get("max_tokens"),
            "ok": False,
            "attempts": 0,
            "ms": 0,
            "error": "",
        }
        if keep_text:
            # 只留 role+content 的拼接，不带 api_key（headers 绝不入库）。
            entry["prompt"] = _clip(
                "\n".join(f"[{m.role}] {m.content}" for m in messages), clip_limit
            )

        started = time.monotonic()
        last_error: Exception | None = None
        try:
            for attempt in range(self.max_retries + 1):
                entry["attempts"] = attempt + 1
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
                    entry["ok"] = True
                    usage = data.get("usage") or {}
                    if isinstance(usage, dict) and usage:
                        # token 用量是算成本的唯一依据，有就存，没有就不编。
                        entry["tokens"] = {
                            key: usage.get(key)
                            for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                            if usage.get(key) is not None
                        }
                    if keep_text:
                        entry["raw"] = _clip(content, clip_limit)
                    return content
                except (httpx.HTTPError, LLMUnavailable, ValueError) as exc:
                    last_error = exc
                    entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
            raise LLMUnavailable(f"LLM 调用失败：{last_error}")
        finally:
            entry["ms"] = int((time.monotonic() - started) * 1000)
            _record(entry)


@dataclass
class MockProvider:
    """测试用。按预设返回，不碰网络。"""

    reply: str = "（模板回复）"

    async def complete(self, messages: list[ChatMessage], **kwargs: object) -> str:
        del messages, kwargs
        return self.reply


def build_provider() -> OpenAICompatibleProvider | None:
    """按环境变量组装 LLM。没配就返回 None，调用方走确定性兜底。

    不返回"必然失败的地址"：否则每条消息都要白等一次超时。
    """
    from ..settings import settings

    if not settings.llm_api_key or settings.llm_api_key == "unset":
        return None
    if not settings.llm_base_url or settings.llm_base_url.startswith("http://127.0.0.1:1"):
        return None
    return OpenAICompatibleProvider(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        timeout=settings.llm_timeout,
    )

/**
 * Agent 会话用的模型调用（OpenAI 兼容，DeepSeek 直连）。
 *
 * 只用非思考模型：默认 deepseek-chat，payload 里只有 model + messages +
 * temperature + max_tokens，**不传任何 reasoning 开关**（项目铁律，见 AGENTS.md）。
 *
 * 没有配 key 时不抛到调用方上层崩掉：抛出一个带 code 的 Error，
 * 路由把它转成 {ok:false,error}，调试页能直接看见「没配模型」而不是 500。
 */

import { ModelProviderError, providerRequest } from "./agent-model-transport.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmResult = {
  content: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  latency_ms: number;
};

export type ModelConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number; managed?: boolean };

export function environmentModel(): ModelConfig {
  return {
    baseUrl: (process.env.AGENT_LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    apiKey: (process.env.AGENT_LLM_API_KEY || "").trim(),
    model: (process.env.AGENT_LLM_MODEL || "deepseek-chat").trim(),
    timeoutMs: Number(process.env.AGENT_LLM_TIMEOUT_MS || 45000),
  };
}

export async function complete(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
  config = environmentModel(),
): Promise<LlmResult> {
  if (!config.apiKey) {
    const error = new Error("未配置 AGENT_LLM_API_KEY，无法调用模型");
    (error as Error & { code?: string }).code = "no_api_key";
    throw error;
  }

  const started = Date.now();
  const payload = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 700,
  };
  if (config.managed) {
    const data = await providerRequest(config.baseUrl, config.apiKey, "chat/completions", config.timeoutMs, payload);
    return completionResult(data, config, started);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`模型返回 HTTP ${response.status}：${raw.slice(0, 200)}`);
    }
    return completionResult(JSON.parse(raw), config, started);
  } finally {
    clearTimeout(timer);
  }
}

function completionResult(value: unknown, config: ModelConfig, started: number): LlmResult {
  const data = value as {
    model?: string;
    choices?: Array<{ message?: { content?: string; reasoning_content?: unknown; reasoning?: unknown } }>;
    usage?: LlmResult["usage"] & {
      reasoning_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  } | null;
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (message?.reasoning_content || message?.reasoning || /<think(?:\s|>)/i.test(content ?? "") ||
      Number(data?.usage?.reasoning_tokens) > 0 ||
      Number(data?.usage?.completion_tokens_details?.reasoning_tokens) > 0) {
    throw new ModelProviderError("provider_reasoning", "模型返回了思考内容，请选择非思考模型");
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new ModelProviderError("provider_response", "模型返回空内容");
  }
  if (config.managed && content.includes(config.apiKey)) {
    throw new ModelProviderError("provider_response", "模型响应包含不应返回的内容");
  }
  const model = data?.model;
  return {
    content,
    model: typeof model === "string" && model && (!config.managed || !model.includes(config.apiKey)) ? model : config.model,
    usage: data?.usage ? {
      prompt_tokens: Number.isFinite(data.usage.prompt_tokens) ? data.usage.prompt_tokens : undefined,
      completion_tokens: Number.isFinite(data.usage.completion_tokens) ? data.usage.completion_tokens : undefined,
      total_tokens: Number.isFinite(data.usage.total_tokens) ? data.usage.total_tokens : undefined,
    } : null,
    latency_ms: Date.now() - started,
  };
}

/** 把 ```json 包裹、前后多余文字都剥掉，只留第一个 JSON 对象。 */
export function parseJsonObject(raw: string): Record<string, unknown> {
  let text = String(raw || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型返回的不是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

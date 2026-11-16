/**
 * Agent 会话用的模型调用（OpenAI 兼容，DeepSeek 直连）。
 *
 * 只用非思考模型：默认 deepseek-chat，payload 里只有 model + messages +
 * temperature + max_tokens，**不传任何 reasoning 开关**（项目铁律，见 AGENTS.md）。
 *
 * 没有配 key 时不抛到调用方上层崩掉：抛出一个带 code 的 Error，
 * 路由把它转成 {ok:false,error}，调试页能直接看见「没配模型」而不是 500。
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmResult = {
  content: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  latency_ms: number;
};

export function llmConfig() {
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
): Promise<LlmResult> {
  const config = llmConfig();
  if (!config.apiKey) {
    const error = new Error("未配置 AGENT_LLM_API_KEY，无法调用模型");
    (error as Error & { code?: string }).code = "no_api_key";
    throw error;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 700,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`模型返回 HTTP ${response.status}：${raw.slice(0, 200)}`);
    }
    const data = JSON.parse(raw) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: LlmResult["usage"];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) throw new Error("模型返回空内容");
    return {
      content,
      model: String(data.model || config.model),
      usage: data.usage ?? null,
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
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

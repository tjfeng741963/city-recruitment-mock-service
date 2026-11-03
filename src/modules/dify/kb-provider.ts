/**
 * 知识库 Provider：把回复生成交给 Python 后端（检索 + 事实/话术分离 + 数字校验）。
 *
 * 为什么走这条路而不是直连 Dify：
 *   Dify 那套是"整段塞 prompt"，12.5 KB 能塞，我们 70 KB 塞不进去（见
 *   docs/知识库与后端技术选型-决策文档.md 2.5 节）。Python 侧的检索漏斗
 *   先把范围缩到 3 条，再交给 LLM，数字还有后置校验。
 *
 * 接口与 DifyProvider 完全一致，所以 create-provider.ts 里换一行配置就能切。
 * 失败时返回 success:false，让上层走既有的 blocked/降级路径，不抛异常。
 */
import { readFileSync } from "node:fs";
import type {
  DifyHealthResult,
  DifyMessageInput,
  DifyMessageResult,
  DifyProvider,
} from "./dify-provider.js";

const DEFAULT_TIMEOUT_MS = 20_000;

interface KbAnswerResponse {
  reply?: unknown;
  source?: unknown;
  matched_entry_ids?: unknown;
  llm_fallback?: unknown;
  validation_passed?: unknown;
}

export class KnowledgeBaseDifyProvider implements DifyProvider {
  constructor(private readonly options: { baseUrl?: string; timeoutMs?: number } = {}) {}

  private baseUrl(): string {
    return (this.options.baseUrl ?? process.env.REA_KB_API_URL ?? "http://city-recruitment-api:8090").replace(
      /\/+$/,
      "",
    );
  }

  /**
   * 服务令牌：优先环境变量；否则读两个容器共享的卷。
   * Python 启动时生成并写入，这里只读——省掉手工在两处填同一个密钥。
   */
  private serviceToken(): string {
    if (process.env.REA_KB_API_TOKEN) return process.env.REA_KB_API_TOKEN;
    try {
      return readFileSync(
        process.env.REA_KB_SERVICE_TOKEN_FILE ?? "/run/kb/service-token",
        "utf8",
      ).trim();
    } catch {
      return "";
    }
  }

  async sendMessage(input: DifyMessageInput): Promise<DifyMessageResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const token = this.serviceToken();
    try {
      const response = await fetch(`${this.baseUrl()}/api/v1/kb/answer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Python 侧认 X-Service-Token（不是 Bearer），两边必须一致
          ...(token ? { "x-service-token": token } : {}),
        },
        body: JSON.stringify({
          text: input.query,
          city: input.inputs?.city ?? null,
          // 最近几条对话（新的在后）：客户可能上一句说了城市、这一句只问工价
          history: input.history ?? [],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { success: false, error: `KB API HTTP ${response.status}` };
      }
      const body = (await response.json()) as KbAnswerResponse;
      const reply = typeof body.reply === "string" ? body.reply : "";
      if (!reply) return { success: false, error: "KB API returned empty reply" };

      return {
        success: true,
        message: reply,
        message_id: `kb-${input.user}-${Date.now()}`,
        conversation_id: input.conversationId ?? `kb-conversation-${input.user}`,
        // 状态快照留给上层持久化：出问题时能查到当时依据了哪几条知识
        state_json: JSON.stringify({
          source: body.source ?? null,
          matched_entry_ids: body.matched_entry_ids ?? [],
          validation_passed: body.validation_passed ?? null,
          llm_fallback: body.llm_fallback ?? null,
        }),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return {
        success: false,
        error: name === "AbortError" ? "KB API timeout" : "KB API request failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<DifyHealthResult> {
    const started = Date.now();
    try {
      const response = await fetch(`${this.baseUrl()}/healthz`, { method: "GET" });
      return { healthy: response.ok, latency_ms: Date.now() - started };
    } catch {
      return { healthy: false, latency_ms: Date.now() - started, error: "KB API unreachable" };
    }
  }
}

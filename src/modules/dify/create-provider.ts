/**
 * DifyProvider 工厂。集中一处决定用哪个实现，避免三处路由各自内联判断后漂移。
 *
 * REA_DIFY_PROVIDER 取值：
 *   - "chatflow"：使用本地还原的 Chatflow 引擎，零外部依赖
 *   - "http"：真实调用 Dify 平台
 *   - "kb"：走 Python 知识库后端（检索 + 事实分离 + 数字校验）
 *   - 其他/未设置：Mock
 */
import { ChatflowDifyProvider } from "./chatflow-engine.js";
import { HttpDifyProvider, MockDifyProvider, type DifyProvider } from "./dify-provider.js";
import { KnowledgeBaseDifyProvider } from "./kb-provider.js";

export type DifyProviderMode = "chatflow" | "http" | "kb" | "mock";

/** 与 createDifyProvider 同一套取值规则，供需要知道“当前是不是 Mock”的调用方使用。 */
export function difyProviderMode(): DifyProviderMode {
  const value = process.env.REA_DIFY_PROVIDER;
  return value === "chatflow" || value === "http" || value === "kb" ? value : "mock";
}

export function createDifyProvider(): DifyProvider {
  switch (process.env.REA_DIFY_PROVIDER) {
    case "chatflow":
      return new ChatflowDifyProvider();
    case "http":
      return new HttpDifyProvider();
    case "kb":
      return new KnowledgeBaseDifyProvider();
    default:
      return new MockDifyProvider();
  }
}

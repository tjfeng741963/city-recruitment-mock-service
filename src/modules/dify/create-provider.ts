/**
 * DifyProvider 工厂。集中一处决定用哪个实现，避免三处路由各自内联判断后漂移。
 *
 * REA_DIFY_PROVIDER 取值：
 *   - "chatflow"：使用本地还原的 Chatflow 引擎，零外部依赖
 *   - "http"：真实调用 Dify 平台
 *   - 其他/未设置：Mock
 */
import { ChatflowDifyProvider } from "./chatflow-engine.js";
import { HttpDifyProvider, MockDifyProvider, type DifyProvider } from "./dify-provider.js";

export function createDifyProvider(): DifyProvider {
  switch (process.env.REA_DIFY_PROVIDER) {
    case "chatflow":
      return new ChatflowDifyProvider();
    case "http":
      return new HttpDifyProvider();
    default:
      return new MockDifyProvider();
  }
}

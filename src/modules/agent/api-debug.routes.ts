import type { FastifyInstance } from "fastify";

/**
 * 接口调试台的后端：只做一件事——把服务真实注册的路由吐出来。
 *
 * 为什么不在前端手写接口清单：手写的一定会过期。这里的数据来自 server.ts
 * 的 onRoute 钩子，新增/删除路由、改路径，调试台下次打开就是新的，不需要改前端。
 *
 * 只给管理员：这份清单等于把整套 API 摊开，不该让普通账号看见。
 * 数据里不含任何密钥或业务数据，只有 method + url。
 */

type RouteEntry = { method: string; url: string };

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;

/** 调试台自己的接口不列进去，否则列表里会循环出现。 */
const HIDDEN_PREFIX = "/api/v1/debug/";

export function registerApiDebugRoutes(app: FastifyInstance, routes: RouteEntry[]) {
  app.get("/api/v1/debug/routes", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send(ADMIN_REQUIRED);

    const seen = new Set<string>();
    const items: RouteEntry[] = [];
    for (const route of routes) {
      if (route.url.startsWith(HIDDEN_PREFIX)) continue;
      const key = `${route.method} ${route.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ method: route.method, url: route.url });
    }
    items.sort((a, b) => (a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url)));
    return { items, total: items.length };
  });
}

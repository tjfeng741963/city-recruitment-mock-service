import type { FastifyInstance } from "fastify";
import { API_CATALOG } from "./api-catalog.js";

/**
 * 接口调试台的后端（/dev 页面用）。
 *
 * 两个接口：
 *   GET /api/v1/debug/catalog  分类目录（人工写的说明 + 示例）
 *   GET /api/v1/debug/routes   服务真实注册的全部路由（onRoute 自动收集）
 *
 * 目录和真实路由会做一次差集：代码里有、目录里没写的接口放进 unclassified，
 * 页面底部单独列出。这样「加了接口忘了写说明」是看得见的，不会悄悄过期。
 *
 * 只给管理员：这份清单等于把整套 API 摊开。
 */

type RouteEntry = { method: string; url: string };

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;
const HIDDEN_PREFIX = "/api/v1/debug/";

export function registerApiDebugRoutes(app: FastifyInstance, routes: RouteEntry[]) {
  function realRoutes(): RouteEntry[] {
    const seen = new Set<string>();
    const items: RouteEntry[] = [];
    for (const route of routes) {
      if (route.url.startsWith(HIDDEN_PREFIX)) continue;
      const key = `${route.method} ${route.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ method: route.method, url: route.url });
    }
    return items.sort((a, b) =>
      a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url),
    );
  }

  app.get("/api/v1/debug/routes", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send(ADMIN_REQUIRED);
    const items = realRoutes();
    return { items, total: items.length };
  });

  app.get("/api/v1/debug/catalog", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send(ADMIN_REQUIRED);

    const documented = new Set<string>();
    for (const group of API_CATALOG) {
      for (const endpoint of group.endpoints) {
        documented.add(`${endpoint.method} ${endpoint.url}`);
      }
    }

    const all = realRoutes();
    const unclassified = all.filter((route) => !documented.has(`${route.method} ${route.url}`));

    return {
      groups: API_CATALOG,
      unclassified,
      stats: {
        documented: documented.size,
        routes: all.length,
        unclassified: unclassified.length,
      },
    };
  });
}

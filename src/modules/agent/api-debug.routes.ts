import type { FastifyInstance } from "fastify";
import { API_CATALOG, type CatalogEndpoint } from "./api-catalog.js";
import { ROUTE_NOTES } from "./route-notes.js";

/**
 * 接口调试台的后端（/dev 页面用）。
 *
 * 两个接口：
 *   GET /api/v1/debug/catalog  分类目录（人工详细说明 + 全量路由一句话说明）
 *   GET /api/v1/debug/routes   服务真实注册的全部路由（onRoute 自动收集）
 *
 * 覆盖顺序：api-catalog.ts 人工写的详细条目优先；没写到的路由按
 * route-notes.ts 的全量说明归类（含「旧链路·未接线」标记）；两条都没有的
 * 才进 unclassified。理想状态 unclassified 恒为 0——真出现了说明加了接口
 * 忘了写说明，页面上看得见。
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

    // 人工目录没写到的路由：按 route-notes 的全量说明归组
    const byGroup = new Map<string, CatalogEndpoint[]>();
    const unclassified: RouteEntry[] = [];
    for (const route of realRoutes()) {
      const key = `${route.method} ${route.url}`;
      if (documented.has(key)) continue;
      const note = ROUTE_NOTES.find((n) => n.method === route.method && n.url === route.url);
      if (!note) {
        unclassified.push(route);
        continue;
      }
      const list = byGroup.get(note.group) || [];
      list.push({
        method: note.method,
        url: note.url,
        purpose: note.purpose,
        auth: note.status === "客户端在用" ? "device" : "admin",
        notes: [note.status],
      });
      byGroup.set(note.group, list);
    }

    const merged = [...API_CATALOG];
    for (const [group, endpoints] of byGroup) {
      merged.push({ group, note: `${endpoints.length} 个接口（一句话说明，详情以调用为准）`, endpoints });
    }

    const total = merged.reduce((sum, g) => sum + g.endpoints.length, 0);
    return {
      groups: merged,
      unclassified,
      stats: {
        documented: documented.size,
        noted: byGroup.size > 0 ? [...byGroup.values()].reduce((sum, list) => sum + list.length, 0) : 0,
        routes: documented.size + [...byGroup.values()].reduce((sum, list) => sum + list.length, 0) + unclassified.length,
        unclassified: unclassified.length,
      },
    };
  });
}

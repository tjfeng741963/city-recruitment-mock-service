import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { migrateDatabase } from "./db/migrate.js";
import { seedDatabase } from "./db/seed.js";
import { AuthService } from "./auth/auth.service.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { AUTH_INVALID, AUTH_MISSING } from "./auth/rbac.js";
import { collectValidationErrors, matchContract } from "./shared/request-contracts.js";
import { registerCoreRoutes } from "./modules/core/core.routes.js";
import { registerGenericRoutes } from "./modules/generic/generic.routes.js";
import { registerResourceRoutes } from "./modules/resources/resource.routes.js";
import { registerFileRoutes } from "./modules/files/file.routes.js";
import { registerAgentRoutes } from "./modules/agent/agent.routes.js";
import { registerActivationRoutes } from "./modules/activation/activation.routes.js";
import { registerRelationRoutes } from "./modules/relations/relations.routes.js";
import { registerPermissionRoutes } from "./modules/permissions/permission.routes.js";
import { registerAdminRoutes } from "./modules/admin/admin.routes.js";
import { registerDeviceBridgeRoutes } from "./modules/messaging/device-bridge.routes.js";
import { registerStreamRoutes } from "./modules/agent/stream.routes.js";
import { registerProfileRoutes } from "./modules/agent/profile.routes.js";
import { registerJobRoutes } from "./modules/agent/profile.routes.js";
import { registerUnknownQuestionRoutes } from "./modules/agent/unknown-questions.routes.js";
import { registerFollowupRoutes } from "./modules/agent/followup.js";
import { EventBus, createStreamNotifier } from "./modules/messaging/stream-events.js";
import { registerWeComRoutes } from "./modules/wecom/wecom.routes.js";

declare module "fastify" {
  interface FastifyInstance { db: DatabaseSync; events: EventBus }
  interface FastifyRequest { authToken: string }
}

/**
 * Endpoints the target serves without authentication.
 * Verified 2026-10-21 against http://47.107.245.246:8080 — these returned 200
 * with real payloads while every other contract returned 403.
 */
const DEVICE_TOKEN_ROUTES = new Set(["heartbeat", "claim", "receipts", "inbound", "outbound"].map(action => `POST /api/v1/bridge/devices/:code/${action}`)
  .concat(["GET /api/v1/bridge/devices/:code/config"]));
const PUBLIC_ROUTES = new Set([
  "POST /api/v1/auth/login",
  "GET /api/v1/agent/reminder-config",
  "GET /api/v1/agent/followup-config",
  "GET /api/v1/agent/report/account-summary",
  // External message bridges authenticate callbacks with the HMAC header.
  "POST /api/v1/webhooks/dify",
  // 设备自注册：客户端首次启动没有 JWT，凭共享密钥换 token（方案 A）。
  // 路由自己校验 X-Register-Key，未配置 REA_REGISTER_KEY 时返回 503。
  "POST /api/v1/bridge/devices/:code/register",
  // 8090 服务间按城市查岗位（X-Profile-Token 自校验）。
  "GET /api/v1/agent/jobs",
  ...DEVICE_TOKEN_ROUTES,
  "GET /api/v1/channels/wecom-kf/callback",
  "POST /api/v1/channels/wecom-kf/callback",
  // Device-called endpoints: device_code is a required query parameter, not a
  // secret. The target answers 422 when it is absent and 404 for an unknown
  // conversation even when the value is fake, with or without a bearer token.
  "PUT /api/v1/agent/conversations/:id/restart",
  "PUT /api/v1/agent/conversations/:id/reset-disqualified",
  // 候选人档案：8090 服务间调用没有用户 JWT，改为路由内校验 X-Profile-Token
  // （与 REA_PROFILE_TOKEN 常数时间比较）；带合法 Bearer 时仍按用户 token 放行。
  "POST /api/v1/agent/profile",
  "GET /api/v1/agent/profile",
  // 8090 的知识库未命中记账：同样用 X-Profile-Token 鉴权（路由内校验）
  "POST /api/v1/agent/unknown-questions",
  // EventSource cannot set headers: the JWT is a query parameter and the route
  // authenticates itself (401/403 instead of the header preHandler's 403).
  "GET /api/v1/agent/stream",
]);

interface RoutePattern { method: string; regex: RegExp }

/** Convert a Fastify route pattern ("/api/v1/cities/:id") into a path matcher. */
function toRegex(routeUrl: string): RegExp {
  const body = routeUrl
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "[^/]+");
  return new RegExp(`^${body}/?$`);
}

export function buildServer() {
  const app = Fastify({ logger: false });
  const db = openDatabase(process.env.REA_DATABASE_PATH ?? config.databasePath);
  migrateDatabase(db);
  seedDatabase(db);
  // This deployment uses one app process per SQLite database. Keep bridge command
  // leases intact; retrying a recovered delivery reuses its durable command id.
  db.prepare("UPDATE message_deliveries SET status='failed',last_error='Application restarted before delivery was finalized' WHERE status='sending'").run();
  const auth = new AuthService(db, config.jwtSecret);
  // One bus per app instance so tests that build several servers stay isolated.
  const events = new EventBus();
  const notifier = createStreamNotifier(db, events);
  app.decorate("db", db);
  app.decorate("events", events);
  app.decorateRequest("authToken", "");

  // Collect every registered API route so the not-found handler can tell a
  // wrong method (405) apart from an unknown path (404), as the target does.
  const routePatterns: RoutePattern[] = [];
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routePatterns.push({ method, regex: toRegex(route.url) });
  });

  // Fastify validates route schemas with Ajv and reports 400. The target reports
  // 422 with Pydantic's {type, loc, msg} list, so remap validation failures here.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) return reply.code(422).send({ detail: pydanticErrors(error) });
    return reply.code(error.statusCode ?? 500).send({ detail: error.message });
  });

  app.register(fastifyStatic, { root: config.frontendDir(), wildcard: false });
  registerAuthRoutes(app, auth);
  registerCoreRoutes(app, db);
  registerResourceRoutes(app, db);
  registerFileRoutes(app, db);
  registerAgentRoutes(app, db, notifier);
  const bridgeStore = registerDeviceBridgeRoutes(app, db, notifier);
  // 掉线清扫（契约：掉线提醒）：每 30s 把 60s 无心跳的“在线”设备翻成 offline，
  // 扫到几台推几台（reason='heartbeat_timeout'）。推送节流在 notifier 里做，
  // 重复扫描 rowcount=0 时 sweepStale 返回空列表，天然不重推。
  const sweepTimer = setInterval(() => {
    for (const code of bridgeStore.sweepStale()) notifier.deviceUpdated(code, "offline", "heartbeat_timeout");
  }, 30_000);
  sweepTimer.unref();
  app.addHook("onClose", () => clearInterval(sweepTimer));
  registerStreamRoutes(app, db, events, auth);
  registerProfileRoutes(app, db);
  registerJobRoutes(app, db);
  registerUnknownQuestionRoutes(app, db);
  registerFollowupRoutes(app, db);
  registerWeComRoutes(app, db);
  registerActivationRoutes(app, db);
  registerRelationRoutes(app, db);
  registerPermissionRoutes(app);
  registerAdminRoutes(app, db);
  registerGenericRoutes(app);

  // preHandler runs only after routing and schema validation, matching the
  // target's order: unknown paths fall through to 404, wrong methods to 405,
  // malformed bodies to 422, and only then does authentication answer 403/401.
  // Match against registered route patterns because the public list carries
  // ":id" placeholders ("PUT /api/v1/agent/conversations/:id/restart").
  const publicPatterns = new Set<string>();
  for (const entry of PUBLIC_ROUTES) {
    const [method, routeUrl] = entry.split(" ");
    publicPatterns.add(`${method} ${toRegex(routeUrl).source}`);
  }
  const isPublic = (method: string, pathname: string) =>
    [...publicPatterns].some((entry) => {
      const [entryMethod, source] = entry.split(" ");
      return entryMethod === method && new RegExp(source).test(pathname);
    });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/api/")) return;
    const isMultipart = (request.headers["content-type"] ?? "").includes("multipart/form-data");
    const contract = matchContract(request.method, pathname);

    // Public routes still validate their body — the target answers 422 to an
    // anonymous POST /auth/login with `{}`, before any credential check.
    if (isPublic(request.method, pathname)) {
      if (contract) {
        const issues = collectValidationErrors(contract, request.body, request.query, isMultipart);
        if (issues.length) return reply.code(422).send({ detail: issues });
      }
      // These four routes authenticate their own per-device tokens, never user JWTs.
      if (DEVICE_TOKEN_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) return;
      // Device endpoints are callable anonymously, but a supplied bearer token
      // still identifies the operator and must participate in scope checks.
      // Keep the login endpoint credential-agnostic.
      const optionalHeader = request.headers.authorization;
      if (optionalHeader?.startsWith("Bearer ") && pathname !== "/api/v1/auth/login") {
        try {
          request.auth = auth.me(optionalHeader.slice("Bearer ".length));
          request.authToken = optionalHeader.slice("Bearer ".length);
        } catch {
          return reply.code(401).send(AUTH_INVALID);
        }
      }
      return;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return reply.code(403).send(AUTH_MISSING);
    try { request.auth = auth.me(header.slice("Bearer ".length)); }
    catch { return reply.code(401).send(AUTH_INVALID); }
    request.authToken = header.slice("Bearer ".length);

    // Authenticated routes validate after auth, matching the target's order.
    if (contract) {
      const issues = collectValidationErrors(contract, request.body, request.query, isMultipart);
      if (issues.length) return reply.code(422).send({ detail: issues });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0];
    if (pathname.startsWith("/api/")) {
      const pathExists = routePatterns.some((r) => r.regex.test(pathname));
      return pathExists
        ? reply.code(405).send({ detail: "Method Not Allowed" })
        : reply.code(404).send({ detail: "Not Found" });
    }
    return reply.sendFile("index.html");
  });

  // End open SSE responses before the HTTP server stops, otherwise shutdown
  // waits for every EventSource tab to hang up on its own. This must be
  // `preClose`: Fastify's own onClose hook calls server.close() (which waits
  // for live sockets) before user onClose hooks registered here would run.
  app.addHook("preClose", () => { events.closeAll(); });
  app.addHook("onClose", () => db.close());
  return app;
}

/** Pydantic's `loc` prefix per request part; Fastify calls them differently. */
const LOC_PREFIX: Record<string, string> = { querystring: "query", params: "path", body: "body" };

/** Map Ajv validation failures onto Pydantic's error list shape. */
function pydanticErrors(error: FastifyError) {
  const prefix = LOC_PREFIX[error.validationContext ?? "body"] ?? "body";
  return (error.validation ?? []).map((item) => {
    const loc = [prefix, ...item.instancePath.split("/").filter(Boolean)];
    if (item.keyword === "required") {
      const missing = item.params.missingProperty as string;
      return { type: "missing", loc: [...loc, missing], msg: "Field required", input: null };
    }
    if (item.keyword === "type") {
      const expected = item.params.type as string;
      return { type: `${expected}_type`, loc, msg: `Input should be a valid ${expected}` };
    }
    return { type: item.keyword, loc, msg: item.message ?? "Invalid value" };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer();
  app.listen({ host: config.host, port: config.port }).then(() => console.log(`local site listening on http://${config.host}:${config.port}`));
}

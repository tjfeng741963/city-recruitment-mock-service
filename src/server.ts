import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import { mkdirSync, readFileSync } from "node:fs";
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
import { registerPositionFactoryRoutes } from "./modules/core/position-factory.routes.js";
import { registerGenericRoutes } from "./modules/generic/generic.routes.js";
import { registerResourceRoutes } from "./modules/resources/resource.routes.js";
import { registerFileRoutes } from "./modules/files/file.routes.js";
import { registerAgentRoutes } from "./modules/agent/agent.routes.js";
import { registerRelationRoutes } from "./modules/relations/relations.routes.js";
import { registerPermissionRoutes } from "./modules/permissions/permission.routes.js";
import { registerDeviceBridgeRoutes } from "./modules/messaging/device-bridge.routes.js";
import { registerStreamRoutes } from "./modules/agent/stream.routes.js";
import { registerProfileRoutes } from "./modules/agent/profile.routes.js";
import { registerJobRoutes } from "./modules/agent/profile.routes.js";
import { registerKbV3Routes } from "./modules/agent/kb-v3.routes.js";
import { registerKbPublishRoutes } from "./modules/agent/kb-publish.routes.js";
import { registerPositionScriptRoutes } from "./modules/agent/position-scripts.routes.js";
import { registerAgentPersonaRoutes } from "./modules/agent/agent-persona.routes.js";
import { registerAgentChatRoutes } from "./modules/agent/agent-chat.routes.js";
import { registerReplyProviderRoutes } from "./modules/dify/dify-reply.js";
import { registerApiDebugRoutes } from "./modules/agent/api-debug.routes.js";
import { registerAgentFlowRoutes } from "./modules/agent/agent-flow.routes.js";
import { EventBus, createStreamNotifier } from "./modules/messaging/stream-events.js";

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
  .concat([
    "GET /api/v1/bridge/devices/:code/config",
    // 登录二维码：设备用自己的桥接令牌上传/清除，路由内 authenticate() 校验，
    // 不走用户 JWT（客户端没有登录态）。网页读取走用户鉴权的 /api/v1/agent/... 那侧。
    "POST /api/v1/bridge/devices/:code/login-qr",
    "DELETE /api/v1/bridge/devices/:code/login-qr",
    "POST /api/v1/bridge/devices/:code/groups",
    // 媒体下载由设备 token 或 X-Profile-Token 鉴权（路由内校验），
    // 因此这里的 Bearer 不能当用户 JWT 解析，否则设备 token 会被判 401。
    "GET /api/v1/agent/media/:name",
    "GET /api/v1/agent/flow",
    "GET /api/v1/agent/state",
    "POST /api/v1/agent/state",
    "POST /api/v1/agent/config-sync",
    // 开场清单与回执也是设备调的：设备令牌在路由内校验（与媒体下载同一套）。
    "GET /api/v1/agent/opening",
    "POST /api/v1/agent/opening/log",
    // Agent 对话：客户端（设备令牌）与调试台（管理员 JWT）都要能调。
    // 路由内校验「管理员或设备令牌二选一」。
    "POST /api/v1/agent/chat",
    // 登录验证码：设备轮询取走前端提交的短信码（路由内校验设备令牌或管理员）。
    "GET /api/v1/agent/devices/:code/verify-code",
  ]));
const PUBLIC_ROUTES = new Set([
  "POST /api/v1/auth/login",
  "GET /api/v1/agent/reminder-config",
  "GET /api/v1/agent/followup-config",
  "GET /api/v1/agent/report/account-summary",
  // 设备自注册：客户端首次启动没有 JWT，凭共享密钥换 token（方案 A）。
  // 路由自己校验 X-Register-Key，未配置 REA_REGISTER_KEY 时返回 503。
  "POST /api/v1/bridge/devices/:code/register",
  // 8090 服务间按城市查岗位（X-Profile-Token 自校验）。
  "GET /api/v1/agent/jobs",
  // 8090 服务间取城市清单，用于识别客户说的地名（X-Profile-Token 自校验）。
  "GET /api/v1/agent/cities",
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
  // 回填必须在种子之后：迁移在种子前跑，那时 cities/factories 还是空的。
  // 幂等（NOT EXISTS），每次启动重跑不会产生重复行。
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
  // 同一份收集结果也给接口调试台用：新增路由不用改前端，页面自动多一行。
  const routePatterns: RoutePattern[] = [];
  const routeCatalog: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routePatterns.push({ method, regex: toRegex(route.url) });
      if (method !== "HEAD" && method !== "OPTIONS") {
        routeCatalog.push({ method, url: route.url });
      }
    }
  });

  // Fastify validates route schemas with Ajv and reports 400. The target reports
  // 422 with Pydantic's {type, loc, msg} list, so remap validation failures here.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) return reply.code(422).send({ detail: pydanticErrors(error) });
    return reply.code(error.statusCode ?? 500).send({ detail: error.message });
  });

  app.register(fastifyStatic, { root: config.frontendDir(), wildcard: false });
  // 上传文件访问：/uploads/<文件>。与前端静态目录分开（前端在 frontendDir），
  // 因为上传目录在可写卷上（线上 /data/uploads），且需要跨重启保留。
  // @fastify/static 要求 root 必须已存在，否则启动即抛错，所以先建目录。
  mkdirSync(config.uploadsDir(), { recursive: true });
  app.register(fastifyStatic, {
    root: config.uploadsDir(),
    prefix: "/uploads/",
    decorateReply: false,
  });
  // 开发调试站：独立页面（自己的布局与路由），不挂在后台 Vue 里。
  // 直接读文件返回，不走 SPA fallback——它和后台是两套前端。
  app.get("/dev", async (_request, reply) => {
    const file = path.join(config.frontendDir(), "dev.html");
    return reply.type("text/html; charset=utf-8").send(readFileSync(file));
  });
  app.get<{ Querystring: { device_code?: string; position_id?: string } }>("/dify-connection", async (request, reply) => {
    const query = new URLSearchParams({ test_engine: "dify" });
    for (const field of ["device_code", "position_id"] as const) {
      const value = request.query[field];
      if (typeof value === "string" && value) query.set(field, value);
    }
    return reply.redirect("/recruitment-flow?" + query.toString());
  });

  registerAuthRoutes(app, auth);  registerCoreRoutes(app, db);
  // knowledge 的旧契约先由兼容层接管（读写 kb_faq，AI 实际回复用的表），
  // 这样 registerResourceRoutes 里的 knowledge 会跳过，不会重复注册。
  // 关掉兼容层（REA_KB_COMPAT=off）就回落到旧表 knowledge_items。
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
  // 知识库 v3 配置接口：品类 / 位置树 / 招工方 / 场景问答 / 模板包
  registerKbV3Routes(app, db);
  registerKbPublishRoutes(app, db);
  // 岗位话术 + 媒体资源库（迁移 030/031）：后台配置 + 设备端媒体下载
  registerPositionScriptRoutes(app, db);
  // 岗位人设 + 开场条目（迁移 038）：一个岗位一份人设、一组有序开场
  registerAgentPersonaRoutes(app, db);
  // Agent 会话 + 调试台：开场清单、开场回执、一轮对话（人设 + 事实 + 历史）
  registerAgentChatRoutes(app, db);
  registerReplyProviderRoutes(app, db);
  // 接口调试台的后端：把 onRoute 收集到的真实路由原样吐出来
  registerAgentFlowRoutes(app, db);
  registerApiDebugRoutes(app, routeCatalog);
  registerPositionFactoryRoutes(app, db);
  registerRelationRoutes(app, db);
  registerPermissionRoutes(app);
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
    if (DEVICE_TOKEN_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) {
      // 设备令牌不是用户 JWT，不能在这里 401 掉——路由内自校验。
      // 但管理员 JWT（调试台）也要解析出来给路由用：解析失败不拦。
      const deviceOptional = request.headers.authorization;
      if (deviceOptional?.startsWith("Bearer ")) {
        try {
          request.auth = auth.me(deviceOptional.slice("Bearer ".length));
          request.authToken = deviceOptional.slice("Bearer ".length);
        } catch {
          // 设备令牌或匿名：request.auth 留空，由路由内 isValidDeviceToken 校验
        }
      }
      return;
    }
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
  app.listen({ host: config.host, port: config.port }).then(() => {
    console.log(`local site listening on http://${config.host}:${config.port}`);
    // 通道模式一目了然：manual-reply 走 bridge（设备键鼠）还是 mock（simulated）
    // 取决于 REA_MESSAGE_CHANNEL_PROVIDER——线上排查「指令不动」先看这行。
    console.log(`[channel] REA_MESSAGE_CHANNEL_PROVIDER=${process.env.REA_MESSAGE_CHANNEL_PROVIDER ?? "mock（未设置）"}`);
  });
}

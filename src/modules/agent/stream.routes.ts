import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { AuthService } from "../../auth/auth.service.js";
import { AUTH_INVALID } from "../../auth/rbac.js";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import { EventBus, serializeEvent } from "../messaging/stream-events.js";

const PING_INTERVAL_MS = 15_000;

/**
 * `GET /api/v1/agent/stream?token=<jwt>&device_code=<code>`
 *
 * EventSource cannot send an Authorization header, so the JWT travels in the
 * query string and the route authenticates itself (it is listed in
 * PUBLIC_ROUTES and never reaches the header-based preHandler). The device
 * scope check is the same one every other agent route uses.
 */
export function registerStreamRoutes(app: FastifyInstance, db: DatabaseSync, bus: EventBus, auth: AuthService): void {
  app.get<{ Querystring: { token?: string; device_code?: string } }>("/api/v1/agent/stream", async (request, reply) => {
    const token = typeof request.query.token === "string" ? request.query.token.trim() : "";
    const deviceCode = typeof request.query.device_code === "string" ? request.query.device_code.trim() : "";
    if (!token) return reply.code(401).send({ detail: "Not authenticated" });

    let user;
    try { user = auth.me(token); }
    catch { return reply.code(401).send(AUTH_INVALID); }

    if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
    // device_code=all 是掉线提醒大盘的全局订阅：只放行 admin。普通用户仍按
    // 设备白名单订阅单台设备，行为不变。
    if (deviceCode === "all") {
      if (!getUserScope(db, user).isAdmin) return reply.code(403).send({ detail: "Device scope required" });
    } else if (!canAccessDevice(getUserScope(db, user), deviceCode)) {
      return reply.code(403).send({ detail: "Device scope required" });
    }

    // Take the socket away from Fastify: the response never ends on its own.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Nginx buffers proxied responses by default, which holds SSE frames
      // until the buffer fills. This header disables it per-response.
      "X-Accel-Buffering": "no",
    });
    raw.socket?.setNoDelay(true);
    raw.socket?.setTimeout(0);
    raw.write(serializeEvent({ type: "ready", data: { device_code: deviceCode } }));

    const connectionId = bus.subscribe(
      deviceCode,
      (chunk) => raw.write(chunk),
      () => raw.end(),
    );
    // Comment frames keep proxies from reaping an idle connection.
    const ping = setInterval(() => {
      try { raw.write(": ping\n\n"); }
      catch { /* socket already closed; close handler will clean up */ }
    }, PING_INTERVAL_MS);
    ping.unref();

    const cleanup = () => {
      clearInterval(ping);
      bus.unsubscribe(connectionId);
      // Close our side too: after a client abort the socket can stay
      // half-open, and Fastify's server.close() would wait on it at shutdown.
      try { raw.end(); } catch { /* already ended */ }
    };
    raw.on("close", cleanup);
    raw.on("error", cleanup);
    return reply;
  });
}

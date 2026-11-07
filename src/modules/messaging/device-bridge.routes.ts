import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import { DeviceBridgeStore } from "./device-bridge.js";
import { MessageAutomationService } from "./message-automation.js";
import { MessageEventService } from "./message-events.js";
import { createMessageChannelProvider } from "./message-channel-provider.js";
import { NOOP_NOTIFIER, type StreamNotifier } from "./stream-events.js";
import { createDifyProvider } from "../dify/create-provider.js";

type DeviceRequest = { Params: { code: string }; Body: Record<string, unknown> };
const field = (body: Record<string, unknown>, key: string, max = 1000) => typeof body[key] === "string" && String(body[key]).length <= max ? String(body[key]) : "";

// 自注册（方案 A）：客户端首次启动用共享密钥换 token，省掉管理员手工建码。
// 与 /pair 的区别是它不要求 admin JWT，因此密钥泄露=任何人都能往库里塞设备，
// 所以密码学比较、长度固定、未配置时直接 503（宁可不可用，也不能默认放开）。
const REGISTER_KEY_MIN_LENGTH = 16;
const DEVICE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function matchesRegisterKey(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerDeviceBridgeRoutes(app: FastifyInstance, db: DatabaseSync, notifier: StreamNotifier = NOOP_NOTIFIER): void {
  const store = new DeviceBridgeStore(db, Date.now, notifier);
  const events = new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? "local-webhook-secret" });
  const automation = new MessageAutomationService(db, events, createDifyProvider(), createMessageChannelProvider(undefined, db), notifier);

  // 免登录自注册：客户端首次启动时用共享密钥换 bridge_token。
  // 幂等：同一台机器重复注册只是换发 token（旧 token 立即失效），
  // 不会重复插入 agent_devices。已存在的设备保持原有 status，避免停用的设备
  // 被重新注册激活——停用是管理员的决定，不能由客户端自己推翻。
  app.post<DeviceRequest>("/api/v1/bridge/devices/:code/register", async (req, reply) => {
    const expected = (process.env.REA_REGISTER_KEY ?? "").trim();
    if (expected.length < REGISTER_KEY_MIN_LENGTH) {
      return reply.code(503).send({ detail: "Device self-registration is not configured" });
    }
    const supplied = String(req.headers["x-register-key"] ?? "");
    if (!supplied || !matchesRegisterKey(supplied, expected)) {
      return reply.code(401).send({ detail: "Invalid register key" });
    }
    const code = req.params.code;
    if (!DEVICE_CODE_PATTERN.test(code)) {
      return reply.code(422).send({ detail: "Invalid device_code" });
    }
    const existing = db.prepare("SELECT id,status FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as { id: number; status: string } | undefined;
    if (existing) {
      if (existing.status !== "enabled") {
        return reply.code(403).send({ detail: "Device disabled" });
      }
      return { device_code: code, device_token: store.pair(code), created: false };
    }
    // 观察模式：只记录会话与消息，不生成自动回复指令。自动回复只走 Python 知识库，
    // 两边同时开会让客户收到两条回复（见 docs/交接文档.md 第四节）。
    db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?, 'enabled', ?)")
      .run(field(req.body ?? {}, "name", 128) || code, JSON.stringify({ device_code: code, observe_only: true, registered_by: "self" }));
    return reply.code(201).send({ device_code: code, device_token: store.pair(code), created: true });
  });
  app.post<DeviceRequest>("/api/v1/bridge/devices/:code/pair", async (req, reply) => {
    if (req.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required" });
    return { device_code: req.params.code, device_token: store.pair(req.params.code) };
  });
  app.get<{ Params: { code: string } }>("/api/v1/bridge/devices/:code", async (req, reply) => {
    if (!canAccessDevice(getUserScope(db, req.auth!), req.params.code)) return reply.code(403).send({ detail: "Device scope required" });
    store.expireClaims(req.params.code);
    return { device: store.status(req.params.code), commands: db.prepare("SELECT id,status,message_id,simulated,created_at FROM bridge_commands WHERE device_code=? ORDER BY created_at DESC LIMIT 50").all(req.params.code) };
  });
  for (const action of ["heartbeat", "claim", "receipts", "inbound", "outbound"] as const) {
    app.post<DeviceRequest>(`/api/v1/bridge/devices/:code/${action}`, async (req, reply) => {
      const code = req.params.code;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
      if (!store.enabled(code)) return reply.code(403).send({ detail: "Device disabled" });
      const body = req.body ?? {};
      if (action === "heartbeat") {
        const state = field(body, "state");
        if (!["online", "offline", "scanning"].includes(state)) return reply.code(422).send({ detail: "Invalid device state" });
        // Only a *change* is worth a push: the client heartbeats every few
        // seconds and re-emitting "online" would flood every open tab.
        const before = store.status(code)?.state ?? "offline";
        store.heartbeat(code, state as "online" | "offline" | "scanning", field(body, "account_id"));
        const after = store.status(code);
        if (after && after.state !== before) notifier.deviceUpdated(code, after.state);
        return { device: after };
      }
      if (action === "claim") {
        const command = store.claim(code);
        if (command) notifier.commandUpdated(code, command);
        return { command };
      }
      if (action === "receipts") {
        const status = field(body, "status");
        if (!["succeeded", "failed", "unknown"].includes(status)) return reply.code(422).send({ detail: "Invalid receipt status" });
        store.receipt(code, field(body, "command_id"), field(body, "lease_token"), status as "succeeded" | "failed" | "unknown", field(body, "message_id"), body.simulated === true);
        const command = store.command(field(body, "command_id"));
        if (command) {
          notifier.commandUpdated(code, {
            id: command.id,
            customer_id: command.customer_id,
            status: command.status,
            error: command.status === "failed" ? "Device reported delivery failure"
              : command.status === "unknown" ? "Device did not confirm the send" : null,
          });
        }
        return { ok: true };
      }
      if (store.status(code)?.state !== "online") return reply.code(409).send({ detail: "Device must be online" });
      const eventId = field(body, "event_id"), contactId = field(body, "contact_id"), content = field(body, "content", 20000);
      if (!eventId || !contactId || !content.trim()) return reply.code(422).send({ detail: "event_id, contact_id and content required" });
      let sentAt: string | undefined;
      if (body.sent_at != null && body.sent_at !== "") {
        if (typeof body.sent_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(body.sent_at) || !Number.isFinite(Date.parse(body.sent_at))) {
          return reply.code(422).send({ detail: "sent_at must be an ISO timestamp with timezone" });
        }
        sentAt = new Date(body.sent_at).toISOString();
      }
      if (action === "outbound") {
        const result = store.observeOutbound(code, eventId, contactId, content, field(body, "nickname"), sentAt);
        if (result.created) notifier.messageCreated(code, result.customer_id, result.source_event_id);
        return { status: result.created ? "processed" : "duplicate", ...result };
      }
      const scopedId = store.inboundEvent(code, eventId, contactId, content);
      const customerId = store.contact(code, contactId, field(body, "nickname"));
      events.recordEvent({ eventId: scopedId, eventType: "message.created", direction: "inbound", deviceCode: code, customerId, payload: { content } });
      const result = await automation.handleInbound({ eventId: scopedId, deviceCode: code, customerId, content, sentAt });
      return reply.code(result.reply_status === "failed" ? 502 : 200).send({ ...result, customer_id: customerId });
    });
  }
}

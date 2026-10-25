import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import { DeviceBridgeStore } from "./device-bridge.js";
import { MessageAutomationService } from "./message-automation.js";
import { MessageEventService } from "./message-events.js";
import { createMessageChannelProvider } from "./message-channel-provider.js";
import { HttpDifyProvider, MockDifyProvider } from "../dify/dify-provider.js";

type DeviceRequest = { Params: { code: string }; Body: Record<string, unknown> };
const field = (body: Record<string, unknown>, key: string, max = 1000) => typeof body[key] === "string" && String(body[key]).length <= max ? String(body[key]) : "";

export function registerDeviceBridgeRoutes(app: FastifyInstance, db: DatabaseSync): void {
  const store = new DeviceBridgeStore(db);
  const events = new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? "local-webhook-secret" });
  const automation = new MessageAutomationService(db, events, process.env.REA_DIFY_PROVIDER === "http" ? new HttpDifyProvider() : new MockDifyProvider(), createMessageChannelProvider(undefined, db));

  app.post<DeviceRequest>("/api/v1/bridge/devices/:code/pair", async (req, reply) => {
    if (req.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required" });
    return { device_code: req.params.code, device_token: store.pair(req.params.code) };
  });
  app.get<{ Params: { code: string } }>("/api/v1/bridge/devices/:code", async (req, reply) => {
    if (!canAccessDevice(getUserScope(db, req.auth!), req.params.code)) return reply.code(403).send({ detail: "Device scope required" });
    return { device: store.status(req.params.code), commands: db.prepare("SELECT id,status,message_id,simulated,created_at FROM bridge_commands WHERE device_code=? ORDER BY created_at DESC LIMIT 50").all(req.params.code) };
  });
  for (const action of ["heartbeat", "claim", "receipts", "inbound"] as const) {
    app.post<DeviceRequest>(`/api/v1/bridge/devices/:code/${action}`, async (req, reply) => {
      const code = req.params.code;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
      if (!store.enabled(code)) return reply.code(403).send({ detail: "Device disabled" });
      const body = req.body ?? {};
      if (action === "heartbeat") {
        const state = field(body, "state");
        if (!["online", "offline", "scanning"].includes(state)) return reply.code(422).send({ detail: "Invalid device state" });
        store.heartbeat(code, state as "online" | "offline" | "scanning", field(body, "account_id"));
        return { device: store.status(code) };
      }
      if (action === "claim") return { command: store.claim(code) };
      if (action === "receipts") {
        const status = field(body, "status");
        if (!["succeeded", "failed", "unknown"].includes(status)) return reply.code(422).send({ detail: "Invalid receipt status" });
        store.receipt(code, field(body, "command_id"), field(body, "lease_token"), status as "succeeded" | "failed" | "unknown", field(body, "message_id"), body.simulated === true);
        return { ok: true };
      }
      if (store.status(code)?.state !== "online") return reply.code(409).send({ detail: "Device must be online" });
      const eventId = field(body, "event_id"), contactId = field(body, "contact_id"), content = field(body, "content", 20000);
      if (!eventId || !contactId || !content.trim()) return reply.code(422).send({ detail: "event_id, contact_id and content required" });
      const scopedId = store.inboundEvent(code, eventId, contactId, content);
      const customerId = store.contact(code, contactId, field(body, "nickname"));
      events.recordEvent({ eventId: scopedId, eventType: "message.created", direction: "inbound", deviceCode: code, customerId, payload: { content } });
      const result = await automation.handleInbound({ eventId: scopedId, deviceCode: code, customerId, content });
      return reply.code(result.reply_status === "failed" ? 502 : 200).send({ ...result, customer_id: customerId });
    });
  }
}

import { timingSafeEqual } from "node:crypto";
import { authorizeProfileRequest } from "../agent/profile.routes.js";
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
// 允许大写：后台「新增设备」弹窗的默认提示就是 AG-001，用户会照抄。
// device_code 在库里按原样存、按原样匹配，所以这里也不能擅自转小写。
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// 网页可远程切换的回复来源。fixed 表示不调后端、用本地固定文本。
// 只在 data_json.brain_mode 命中枚举时下发，避免脏值覆盖客户端本地配置。
const BRAIN_MODES = new Set(["kb", "flow", "fixed"]);

function matchesRegisterKey(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerDeviceBridgeRoutes(app: FastifyInstance, db: DatabaseSync, notifier: StreamNotifier = NOOP_NOTIFIER): DeviceBridgeStore {
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
  // 配置下发（契约 docs/对齐-配置分发与按设备话术.md §1）：运行参数来自
  // agent_devices.data_json，话术来自 device_scripts；version = 两者 updated_at
  // 取较新者，客户端只认字符串不等。缺省参数与「无数据给空 version」见验收。
  const stampOf = (value: string | null | undefined): number => {
    if (!value) return 0;
    // agent_devices.updated_at 是 SQLite CURRENT_TIMESTAMP（UTC 无时区标记），
    // device_scripts.updated_at 是 JS ISO；统一补 Z 再比，避免本地时区偏差。
    const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  app.get<{ Params: { code: string } }>("/api/v1/bridge/devices/:code/config", async (req, reply) => {
    const code = req.params.code;
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    // 8090 服务间调用走 X-Profile-Token（常熟比较），设备自身仍走 device token。
    if (!authorizeProfileRequest(req)) {
      if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
      if (!store.enabled(code)) return reply.code(403).send({ detail: "Device disabled" });
    }
    const device = db.prepare("SELECT data_json,updated_at FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?")
      .get(code) as { data_json: string; updated_at: string | null } | undefined;
    if (!device) return reply.code(404).send({ detail: "Device not found" });
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(device.data_json || "{}") as Record<string, unknown>; } catch { params = {}; }
    const scripts = db.prepare("SELECT stage,city,title,content FROM device_scripts WHERE device_code=? AND status='enabled' ORDER BY id")
      .all(code) as Array<{ stage: string; city: string; title: string; content: string }>;
    const scriptUpdated = (db.prepare("SELECT MAX(updated_at) AS at FROM device_scripts WHERE device_code=?").get(code) as { at: string | null }).at;
    const newer = stampOf(scriptUpdated) > stampOf(device.updated_at) ? (scriptUpdated ?? "") : (device.updated_at ?? "");
    return {
      version: newer,
      interval_seconds: positive(params.interval_seconds, 20),
      cooldown: positive(params.cooldown, 8),
      merge_delay_seconds: positive(params.merge_delay_seconds, 0),
      // brain.mode 允许网页远程切换（kb 知识库 / flow 流程编排 / fixed 固定文本）。
      // 客户端检测到变化后会重建 Brain 实例；缺省或非法值不下发，保留客户端本地配置。
      ...(BRAIN_MODES.has(String(params.brain_mode)) ? { brain_mode: String(params.brain_mode) } : {}),
      // 设备绑定的工厂/城市（契约 docs/对齐-设备工厂绑定与资料导入.md §1）：
      // 8090 拿去做知识库过滤，data_json 没绑就回空串 = 通用/不限。
      factory_name: typeof params.factory_name === "string" ? params.factory_name : "",
      city: typeof params.city === "string" ? params.city : "",
      scripts,
    };
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
        // 状态变化的 device_events 落表与推送都收敛在 store.heartbeat 里：
        // 只有真正变化才落一条 reason='reported' 的事件并推 device.updated。
        store.heartbeat(code, state as "online" | "offline" | "scanning", field(body, "account_id"));
        return { device: store.status(code) };
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
  // 返回 store 供 server.ts 挂 30s 掉线清扫定时器。
  return store;
}

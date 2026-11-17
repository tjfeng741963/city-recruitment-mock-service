import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { serializeAgentDevice, serializeStatusDashboard } from "../../shared/response-serializers.js";
import { canAccessDevice, deviceConstraint, getUserScope } from "../../auth/user-scopes.js";
import { createHash, randomUUID } from "node:crypto";
import { MessageEventService } from "../messaging/message-events.js";
import { createMessageChannelProvider } from "../messaging/message-channel-provider.js";
import { BridgeError, DeviceBridgeStore } from "../messaging/device-bridge.js";
import { NOOP_NOTIFIER, type StreamNotifier } from "../messaging/stream-events.js";
import { readWeComConfig } from "../wecom/wecom-config.js";
import { listReminderTasks } from "./followup.js";
import { isValidDeviceToken } from "./position-scripts.routes.js";
import { loadFactories, parseDeviceData, readDeviceFactoryIds } from "../../shared/device-factories.js";

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;

/**
 * 待输入的企微验证码（内存态，不必落库）。
 *
 * 首次登录企微可能在扫码后要求短信验证码：前端提交 → 设备轮询取走 →
 * 在 Console 会话里模拟键盘敲进登录窗。one-shot：设备 GET 一次即清除，
 * 超时/失败由用户重新提交（验证码本身只有几分钟时效，不需要复杂重试）。
 */
const pendingVerifyCodes = new Map<string, { code: string; at: string }>();

export async function registerAgentRoutes(app: FastifyInstance, db: DatabaseSync, notifier: StreamNotifier = NOOP_NOTIFIER) {
  const messageChannel = createMessageChannelProvider(undefined, db);
  const messageEvents = new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? "local-webhook-secret" });
  const bridgeStore = new DeviceBridgeStore(db, Date.now, notifier);
  // 生产配置 REA_MESSAGE_CHANNEL_PROVIDER=bridge 时，人工回复不能再走
  // DeviceBridgeChannelProvider 的「入队后同步等 30 秒回执」——键鼠客户端不是
  // 常驻 claim 的，等待必然超时并回 502，消息看着像失败。改成入队即返回
  // 202，由客户端 claim → 键鼠发送 → receipts 回执把状态推进到 sent。
  // 配了微信客服（WeCom）时保持原通道，不能把客服消息塞进设备队列。
  const queueBridge = (() => {
    if ((process.env.REA_MESSAGE_CHANNEL_PROVIDER ?? "mock") !== "bridge") return null;
    try { return readWeComConfig() ? null : bridgeStore; } catch { return null; }
  })();
  // 人工作为 Outbound 入队：写 message_events/message_deliveries/bridge_commands，
  // 同时先把 agent_messages(status=queued) 与会话 last_msg 落库，界面立刻可见。
  // 设备回执成功后再由 DeviceBridgeStore.receipt 推进为 sent。
  const enqueueManualMessage = (deviceCode: string, customerId: number, content: string, suppliedKey: string) => {
    const idempotencyKey = suppliedKey.trim() || randomUUID();
    const eventId = `manual-reply:${createHash("sha256").update(`${deviceCode}\0${customerId}\0${idempotencyKey}`).digest("hex")}`;
    const sourceEventId = `${eventId}:outbound`;
    messageEvents.recordEvent({ eventId, eventType: "agent.manual_reply", direction: "outbound", deviceCode, customerId, payload: { device_code: deviceCode, customer_id: customerId, content } });

    let delivery = db.prepare("SELECT id,status,content FROM message_deliveries WHERE event_id=? AND customer_id=? ORDER BY id LIMIT 1").get(eventId, customerId) as { id: number; status: string; content: string } | undefined;
    if (delivery && delivery.content !== content) throw new BridgeError("Idempotency key was already used with different content", 409);
    if (!delivery) {
      const created = messageEvents.createDelivery({ eventId, deviceCode, customerId, content });
      delivery = db.prepare("SELECT id,status,content FROM message_deliveries WHERE id=?").get(created.delivery_id) as { id: number; status: string; content: string };
    }

    let command = bridgeStore.enqueue({ deviceCode, customerId, content, idempotencyKey: eventId });
    // 上一次设备回执 failed（没发出去）时，同一个幂等键应允许重新入队，
    // 否则界面重试会永远停在失败状态。unknown 表示可能已经发出，不自动重发。
    const retrying = command.status === "failed";
    if (retrying) {
      db.prepare("UPDATE bridge_commands SET status='queued',lease_token='',lease_until=0,message_id='',receipt_at=NULL WHERE id=?").run(command.id);
      command = bridgeStore.command(command.id)!;
    }

    const now = new Date().toISOString();
    const inserted = db.prepare("INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?,'outbound',?,?,?,?)")
      .run(deviceCode, customerId, content, "queued", now, sourceEventId);
    if (command.status === "queued") db.prepare("UPDATE agent_messages SET status='queued' WHERE source_event_id=?").run(sourceEventId);
    const message = db.prepare("SELECT id,device_code,customer_id,direction,content,status,created_at FROM agent_messages WHERE source_event_id=? AND direction='outbound'").get(sourceEventId);
    if (Number(inserted.changes) === 1 || retrying) db.prepare("UPDATE agent_conversations SET last_msg=?,last_msg_at=?,updated_at=? WHERE device_code=? AND customer_id=? AND (last_msg_at IS NULL OR julianday(last_msg_at)<=julianday(?))")
      .run(content, now, now, deviceCode, customerId, now);
    // Push the queued command so the sender's other tabs (and the injected
    // client's UI) see "sending" immediately instead of on the next poll. A
    // retried idempotency key re-uses the message row, so only a fresh insert
    // produces message.created — no duplicated bubbles on replay.
    notifier.commandUpdated(deviceCode, { id: command.id, customer_id: customerId, status: command.status, error: null });
    if (Number(inserted.changes) === 1) notifier.messageCreated(deviceCode, customerId, sourceEventId);
    return { command, message: message as Record<string, unknown> };
  };
  const canAccessDeviceForRequest = (request: import("fastify").FastifyRequest, deviceCode: string) =>
    !request.auth || canAccessDevice(getUserScope(db, request.auth), deviceCode);
  // Target envelope has no `total`; each item carries the Dify config fields:
  // id, device_code, name, dify_url, dify_key, recruiter_id, status, online,
  // mode, config, last_online, created_at, last_offline, queue_depth, queue_stale
  app.get<{ Querystring: { my?: string } }>("/api/v1/agent/devices", async (request) => {
    const rows = db.prepare("SELECT * FROM agent_devices ORDER BY id DESC").all() as Array<Record<string, unknown>>;
    const scope = getUserScope(db, request.auth!);
    return {
      // 过滤必须放在 serializeAgentDevice() 之后：表里没有 device_code 列，
      // 它是 serialize 时从 data_json 里提出来的。直接过滤原始 row 会拿到
      // undefined，把受限用户的设备列表整片滤空（CI 实测 expected [] 即此因）。
      // serialize 的声明类型不含 device_code，故显式放宽为字典以通过 typecheck。
      items: rows
        .map((row) => {
          // 设备 → 工厂多选绑定：每行带上 factory_ids 与厂名/城市，
          // 后台设备列表直接回显多选结果，不用前端再逐台去拉 /factories。
          const factoryIds = readDeviceFactoryIds(db, parseDeviceData(row.data_json).factory_ids);
          const serialized = serializeAgentDevice(row) as Record<string, unknown>;
          return { ...serialized, factory_ids: factoryIds, factories: loadFactories(db, factoryIds) };
        })
        // 过滤参数用显式断言：展开后的对象类型不带索引签名，
        // 直接取 device_code 会报 TS2339（与运行时无关，纯粹是类型推断的坑）。
        .filter((row) => canAccessDevice(scope, String((row as Record<string, unknown>).device_code ?? ""))),
    };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/devices", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required to create devices" });
    const deviceName = String(request.body?.device_name ?? request.body?.name ?? "").trim() || `device-${Date.now()}`;
    // observe_only 默认 true：服务端 automation 只负责「记录 + 可选生成指令」，
    // 真正能把消息发出去的是客户端键鼠。两者同时开 = 客户收到两条回复
    // （同一会话状态被推进两次，左边一句右边一句），11-13 实机踩过。
    // 与 /bridge/devices/:code/register 的自注册路径保持一致：那里也写 true。
    // 只有调用方明确传 observe_only:false 时（企微官方客服 API 通道）才放行。
    const data = { observe_only: true, ...(request.body ?? {}) } as Record<string, unknown>;
    return db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?) RETURNING *")
      .get(deviceName, String(request.body?.status ?? "enabled"), JSON.stringify(data));
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/agent/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined;
    const data = row ? (JSON.parse(row.data_json || "{}") as Record<string, unknown>) : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) {
      return reply.code(404).send({ detail: "设备不存在" });
    }
    const merged = { ...data, ...(request.body ?? {}) } as Record<string, unknown>;
    // Dify 已全链路下线（2026-11-17）：本次提交与历史遗留的 dify 字段一律不落库
    for (const key of ["dify_url", "dify_key", "dify_key_env"]) delete merged[key];
    // 设备 → 工厂多选绑定：本次提交了 factory_ids 就规范化后落库——
    // 去重、丢掉非整数与库里不存在的 id（忽略而不是整单 422），空数组 = 不绑任何厂。
    // 没提交这个键时保持原值，老客户端不受影响（与 vertical_id 的按需校验同一思路）。
    if ("factory_ids" in (request.body ?? {})) {
      merged.factory_ids = readDeviceFactoryIds(db, (request.body as Record<string, unknown>).factory_ids);
    }
    // 品类必填（2026-11-13 与 HR 对齐）：一个微信号只做一个板块，没有综合号。
    // 只在本次请求显式提交了 vertical_id 时校验，避免老客户端改别的字段被挡。
    if ("vertical_id" in (request.body ?? {})) {
      const verticalId = Number(merged.vertical_id);
      if (!Number.isInteger(verticalId) || verticalId <= 0) {
        return reply.code(422).send({ detail: "vertical_id is required: 一个微信号只能属于一个板块" });
      }
      const exists = db.prepare("SELECT 1 AS ok FROM vertical WHERE id=? AND status<>'deleted'").get(verticalId);
      if (!exists) return reply.code(422).send({ detail: "Unknown vertical_id" });
    }
    const result = db.prepare("UPDATE agent_devices SET device_name=COALESCE(?,device_name),status=COALESCE(?,status),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(typeof request.body?.device_name === "string" ? request.body.device_name : null, typeof request.body?.status === "string" ? request.body.status : null, JSON.stringify(merged), id);
    return result.changes ? db.prepare("SELECT * FROM agent_devices WHERE id=?").get(id) : reply.code(404).send({ detail: "设备不存在" });
  });
  // The target 404s on a missing row; returning {success:false} with 200 is a
  // parity bug (verified: DELETE /agent/devices/999999 -> 404 "Device not found").
  app.delete<{ Params: { id: string } }>("/api/v1/agent/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined;
    const data = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    const result = db.prepare("DELETE FROM agent_devices WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Device not found" });
  });
  // 后台运营总览（监控看板页注入卡片的数据源，admin-enhancements.js 调用）。
  // 原 admin-overview 模块在接口精简时删除，这里按卡片需要的 11 个计数重建，
  // 口径：jobs.queued=待重试 / jobs.failed=失败 / webhook_logs.rejected=拒绝回调。
  app.get("/api/v1/admin/overview", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      total_users: one("SELECT COUNT(*) AS n FROM users"),
      active_users: one("SELECT COUNT(*) AS n FROM users WHERE is_active=1"),
      recruiters: one("SELECT COUNT(*) AS n FROM recruiters"),
      cities: one("SELECT COUNT(*) AS n FROM cities"),
      positions: one("SELECT COUNT(*) AS n FROM service_positions"),
      devices: one("SELECT COUNT(*) AS n FROM agent_devices"),
      conversations: one("SELECT COUNT(*) AS n FROM agent_conversations"),
      pending_activations: one("SELECT COUNT(*) AS n FROM activation_devices WHERE status='pending'"),
      retry_jobs: one("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'"),
      dead_jobs: one("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'"),
      rejected_webhooks: one("SELECT COUNT(*) AS n FROM webhook_logs WHERE status='rejected'"),
    };
  });
  // 管理端读取设备上报的企微群聊清单（面试登记面板下拉自选绑定群聊）。
  app.get<{ Params: { code: string } }>("/api/v1/agent/devices/:code/groups", async (request, reply) => {
    const code = String(request.params.code);
    if (!canAccessDevice(getUserScope(db, request.auth!), code)) {
      return reply.code(403).send({ detail: "Device scope required" });
    }
    return { items: bridgeStore.listGroups(code) };
  });
  // 登录二维码的网页读取口。设备用自己的桥接令牌 POST 上传（见 device-bridge.routes.ts），
  // 网页这一侧用用户 JWT 读——二维码等同于登录凭证，拿到就能顶替这个号登录，不能公开。
  app.get<{ Params: { code: string } }>("/api/v1/agent/devices/:code/login-qr", async (request, reply) => {
    const code = String(request.params.code);
    if (!canAccessDevice(getUserScope(db, request.auth!), code)) {
      return reply.code(403).send({ detail: "Device scope required" });
    }
    const row = bridgeStore.loginQr(code);
    if (!row) return { available: false };
    return {
      available: true,
      // 直接给 data URL，前端 <img src> 拿来即用，不用再拼前缀
      image: row.image_b64.startsWith("data:") ? row.image_b64 : `data:image/png;base64,${row.image_b64}`,
      width: row.width,
      height: row.height,
      captured_at: row.captured_at,
    };
  });

  // ── 企微登录验证码通道（扫码后企微可能要求短信验证码）──────────────
  // 前端提交（管理员），设备轮询取走（设备令牌，one-shot）。
  app.post<{ Params: { code: string }; Body: Record<string, unknown> }>(
    "/api/v1/agent/devices/:code/verify-code",
    async (request, reply) => {
      const code = String(request.params.code);
      if (!canAccessDevice(getUserScope(db, request.auth!), code)) {
        return reply.code(403).send({ detail: "Device scope required" });
      }
      const verify = String((request.body ?? {}).code ?? "").trim();
      if (!/^\d{4,8}$/.test(verify)) {
        return reply.code(422).send({ detail: "验证码必须是 4-8 位数字" });
      }
      pendingVerifyCodes.set(code, { code: verify, at: new Date().toISOString() });
      return { ok: true };
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/v1/agent/devices/:code/verify-code",
    async (request, reply) => {
      const code = String(request.params.code);
      if (request.auth?.role !== "admin" && !isValidDeviceToken(db, request)) {
        return reply.code(403).send(ADMIN_REQUIRED);
      }
      const pending = pendingVerifyCodes.get(code);
      if (!pending) return { available: false };
      pendingVerifyCodes.delete(code);
      return { available: true, code: pending.code, at: pending.at };
    },
  );
  // 本地新增，目标站契约里没有这条（7 轮 parity 快照均未抓到同类端点）——
  // 纯运维工具：管理员在后台填完某设备自己的 dify_url/dify_key 后，一键验证能否连上，
  // 不用等真实客户发消息才发现配置错了。调用既有的 DifyProvider.healthCheck()，不新建逻辑。
  app.get<{ Querystring: { device_code?: string } }>("/api/v1/agent/conversations", async (request, reply) => { const deviceCode = request.query.device_code ?? ""; if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); bridgeStore.expireClaims(deviceCode); const rows = db.prepare("SELECT * FROM agent_conversations WHERE device_code=? ORDER BY updated_at DESC").all(deviceCode); return { items: rows, total_unread: (rows as Array<Record<string, unknown>>).reduce((sum, row) => sum + Number(row.unread ?? 0), 0) }; });
  app.get<{ Querystring: { device_code?: string; customer_id?: string; after_id?: string } }>("/api/v1/agent/messages", async (request, reply) => {
    const deviceCode = request.query.device_code ?? "";
    if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" });
    bridgeStore.expireClaims(deviceCode);
    const customerId = Number(request.query.customer_id ?? 0);
    const rows = db.prepare("SELECT * FROM agent_messages WHERE device_code=? AND customer_id=? AND id>? ORDER BY created_at, id").all(deviceCode, customerId, Number(request.query.after_id ?? 0)) as Array<Record<string, unknown>>;
    // 会话级已读：能拉到消息就说明运营正看着这个会话，未读必须落库清零。
    //
    // 之前只有整台设备的 clear-unread，没有会话级入口；前端点开会话时只把数组里的
    // unread 改成 0，从不发请求，于是 15s 轮询 listConversations 又把库里的原值读回来，
    // 红点灭而复现。这里挂在唯一必然发生的「打开会话」路径上，刷新和轮询都不会复活。
    // 不动 updated_at：那列决定列表排序，清未读不该把会话顶到最前。
    if (Number.isSafeInteger(customerId) && customerId > 0) {
      db.prepare("UPDATE agent_conversations SET unread=0 WHERE device_code=? AND customer_id=? AND unread<>0").run(deviceCode, customerId);
    }
    // 会话页按 role 决定气泡左右；agent_messages 只有 direction，这里补一层映射。
    return { items: rows.map((row) => ({ ...row, role: row.direction === "inbound" ? "customer" : "agent" })), takeover: false };
  });
  app.post<{ Body: { device_code?: string; customer_id?: number; takeover?: boolean } }>("/api/v1/agent/takeover", async (request, reply) => { const deviceCode = request.body?.device_code ?? ""; if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const result = db.prepare("UPDATE agent_conversations SET takeover=? WHERE device_code=? AND customer_id=?").run(request.body?.takeover ? 1 : 0, deviceCode, request.body?.customer_id ?? 0); return result.changes ? { success: true } : reply.code(404).send({ detail: "Conversation not found" }); });
  app.post<{ Body: { device_code?: string; customer_id?: number; content?: string } }>("/api/v1/agent/manual-reply", async (request, reply) => {
    const deviceCode = request.body?.device_code ?? "";
    if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" });
    const customerId = request.body?.customer_id ?? 0;
    const content = request.body?.content ?? "";
    if (!db.prepare("SELECT id FROM agent_conversations WHERE device_code=? AND customer_id=?").get(deviceCode, customerId)) return reply.code(404).send({ detail: "Conversation not found" });
    if (!content.trim()) return reply.code(422).send({ detail: "content is required" });

    const suppliedKey = request.headers["idempotency-key"];
    const idempotencyKey = typeof suppliedKey === "string" && suppliedKey.trim() ? suppliedKey.trim() : randomUUID();

    // bridge 通道：入队即返回，状态由设备回执推进（会话页的发送按钮走这里）。
    if (queueBridge) {
      try {
        const { command, message } = enqueueManualMessage(deviceCode, customerId, content, idempotencyKey);
        return reply.code(command.status === "succeeded" ? 200 : 202).send({ ...message, command_id: command.id, command_status: command.status });
      } catch (error) {
        if (error instanceof BridgeError) return reply.code(error.statusCode).send({ detail: error.message });
        throw error;
      }
    }

    const eventId = `manual-reply:${createHash("sha256").update(`${deviceCode}\0${customerId}\0${idempotencyKey}`).digest("hex")}`;
    messageEvents.recordEvent({ eventId, eventType: "agent.manual_reply", direction: "outbound", deviceCode, customerId, payload: { device_code: deviceCode, customer_id: customerId, content } });

    let delivery = db.prepare("SELECT id,status,content FROM message_deliveries WHERE event_id=? AND customer_id=? ORDER BY id LIMIT 1").get(eventId, customerId) as { id: number; status: string; content: string } | undefined;
    if (delivery && delivery.content !== content) return reply.code(409).send({ detail: "Idempotency key was already used with different content" });
    if (!delivery) {
      const created = messageEvents.createDelivery({ eventId, deviceCode, customerId, content });
      delivery = db.prepare("SELECT id,status,content FROM message_deliveries WHERE id=?").get(created.delivery_id) as { id: number; status: string; content: string };
    }
    const sourceEventId = `${eventId}:outbound`;
    if (delivery.status === "sending") return reply.code(409).send({ detail: "Delivery is pending; retry with the same idempotency key" });
    if (delivery.status === "succeeded") {
      const existing = db.prepare("SELECT id,device_code,customer_id,direction,content,status,created_at FROM agent_messages WHERE source_event_id=? AND direction='outbound'").get(sourceEventId);
      if (existing) return existing;
    }

    messageEvents.markDeliverySending(delivery.id);
    const sent = await messageChannel.sendMessage({ deviceCode, customerId, content, idempotencyKey: eventId });
    const status = sent.success ? sent.simulated ? "simulated" : sent.accepted ? 'api_accepted' : "sent" : "failed";
    db.prepare(`INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,source_event_id)
      VALUES (?,?,'outbound',?,?,?)`).run(deviceCode, customerId, content, status, sourceEventId);
    db.prepare("UPDATE agent_messages SET content=?,status=? WHERE source_event_id=? AND direction='outbound'").run(content, status, sourceEventId);

    if (!sent.success) {
      messageEvents.markDeliveryFailed(delivery.id, sent.error ?? "Message channel send failed");
      return reply.code(502).send({ detail: "Message channel delivery failed", error: sent.error ?? "Message channel send failed" });
    }

    const sentAt = new Date().toISOString();
    db.prepare("UPDATE agent_conversations SET last_msg=?,last_msg_at=?,updated_at=? WHERE device_code=? AND customer_id=?")
      .run(content, sentAt, sentAt, deviceCode, customerId);
    messageEvents.markDeliverySucceeded(delivery.id, sent.message_id);
    return db.prepare("SELECT id,device_code,customer_id,direction,content,status,created_at FROM agent_messages WHERE source_event_id=? AND direction='outbound'").get(sourceEventId);
  });
  // 控制台主动发消息（人工回复/接管）：人工指令只入队，不受设备 observe_only
  // 影响——observe_only 仅抑制服务端自动生成的回复，人工发送必须照常下发。
  // :id 是会话的 customer_id（会话由 device_code + customer_id 唯一确定）。
  app.post<{ Params: { id: string }; Querystring: { device_code?: string }; Body: { device_code?: string; content?: string } }>("/api/v1/agent/conversations/:id/send", async (request, reply) => {
    const body = request.body ?? {};
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return reply.code(422).send({ detail: "content is required" });
    if (content.length > 20000) return reply.code(422).send({ detail: "content is too long" });
    const customerId = Number(request.params.id);
    if (!Number.isSafeInteger(customerId) || customerId <= 0) return reply.code(422).send({ detail: "Invalid conversation id" });

    let deviceCode = String(body.device_code ?? request.query.device_code ?? "").trim();
    if (!deviceCode) {
      const rows = db.prepare("SELECT device_code FROM agent_conversations WHERE customer_id=?").all(customerId) as Array<{ device_code: string }>;
      if (rows.length !== 1) return reply.code(422).send({ detail: "device_code is required" });
      deviceCode = rows[0].device_code;
    }
    if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" });
    if (!db.prepare("SELECT id FROM agent_conversations WHERE device_code=? AND customer_id=?").get(deviceCode, customerId)) return reply.code(404).send({ detail: "Conversation not found" });

    const suppliedKey = request.headers["idempotency-key"];
    try {
      const { command, message } = enqueueManualMessage(deviceCode, customerId, content, typeof suppliedKey === "string" ? suppliedKey : "");
      return reply.code(command.status === "succeeded" ? 200 : 202).send({
        command_id: command.id,
        status: command.status,
        message_id: message.id,
        device_code: deviceCode,
        customer_id: customerId,
      });
    } catch (error) {
      if (error instanceof BridgeError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
  });
  /**
   * 内部邀约群配置（R1）。
   *
   * 客户给的格式是 `深11/9 谢子鑫 18077352958`，城市简写映射表还没给全，
   * 所以做成可配置：运营在页面上填群名和映射，没配的城市取首字兜底。
   */
  // 群机器人 Webhook 里带 key，等同发送凭据：读回来时打码，只让运营知道「配过了」。
  const maskWebhook = (url: string) => {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      const key = parsed.searchParams.get("key") ?? "";
      if (!key) return `${parsed.origin}${parsed.pathname}`;
      parsed.searchParams.set("key", `${key.slice(0, 8)}****${key.slice(-4)}`);
      return parsed.toString();
    } catch { return "****"; }
  };
  // 发送记录：运营要能查「这条名单到底发出去了没有」
  // Target item shape: id, account, customer_id, nickname, device_code, status,
  // created_at — updated_at is not exposed.
  // Target rejects a mark without both identifiers as 400, not 500/200.
  app.get("/api/v1/agent/status/dashboard", async (request) => {
    const scope = getUserScope(db, request.auth!);
    const deviceFilter = (column: string) => deviceConstraint(scope, column);
    const agentDeviceFilter = scope.isAdmin ? { sql: "", values: [] as string[] } : scope.deviceCodes.length
      ? { sql: ` AND json_extract(data_json,'$.device_code') IN (${scope.deviceCodes.map(() => "?").join(",")})`, values: scope.deviceCodes }
      : { sql: " AND 1=0", values: [] as string[] };
    const devices = (db.prepare(`SELECT COUNT(*) AS total FROM agent_devices WHERE 1=1${agentDeviceFilter.sql}`).get(...agentDeviceFilter.values) as { total: number }).total;
    const messagesScope = deviceFilter("device_code");
    const messages = (db.prepare(`SELECT COUNT(*) AS total FROM agent_messages WHERE 1=1${messagesScope.sql}`).get(...messagesScope.values) as { total: number }).total;
    const pendingScope = deviceFilter("device_code");
    const pending = (db.prepare(`SELECT COUNT(*) AS total FROM agent_conversations WHERE state='pending_invite'${pendingScope.sql}`).get(...pendingScope.values) as { total: number }).total;
    const failedScope = deviceFilter("device_code");
    const failed = (db.prepare(`SELECT COUNT(*) AS total FROM agent_messages WHERE status='failed'${failedScope.sql}`).get(...failedScope.values) as { total: number }).total;
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    return serializeStatusDashboard({ devices: { total: devices, active_today: 0 }, messages: { total: messages, hourly }, queue: { pending }, errors: { failed_today: failed, ai_abnormal: 0 }, state_distribution: {}, device_ranking: [], dify_health: [], degraded: [], daily_trend: [] });
  });
  // device_code is a required query parameter on the target (422 when absent),
  // but its value is not authenticated: any string reaches the DB lookup.
  const deviceQuerySchema = { querystring: { type: "object", required: ["device_code"], properties: { device_code: { type: "string" } } } } as const;
  app.put<{ Params: { id: string }; Querystring: { device_code: string } }>("/api/v1/agent/conversations/:id/restart", { schema: deviceQuerySchema }, async (request, reply) => { const deviceCode = request.query.device_code; if (!canAccessDeviceForRequest(request, deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const result = db.prepare("UPDATE agent_conversations SET state='active',recruit_status='none',updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND device_code=?").run(Number(request.params.id), deviceCode); return result.changes ? { success: true } : reply.code(404).send({ detail: "Conversation not found" }); });
  app.put<{ Params: { id: string }; Querystring: { device_code: string } }>("/api/v1/agent/conversations/:id/reset-disqualified", { schema: deviceQuerySchema }, async (request, reply) => { const deviceCode = request.query.device_code; if (!canAccessDeviceForRequest(request, deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const result = db.prepare("UPDATE agent_conversations SET state='active',recruit_status='none',updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND device_code=?").run(Number(request.params.id), deviceCode); return result.changes ? { success: true } : reply.code(404).send({ detail: "Conversation not found" }); });
  // Target 404s "Device not found" when the device row is missing.
  app.post<{ Params: { id: string } }>("/api/v1/agent/device/:id/clear-unread", async (request, reply) => {
    const deviceId = Number(request.params.id);
    const device = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(deviceId) as { data_json: string } | undefined;
    if (!device) return reply.code(404).send({ detail: "Device not found" });
    const deviceData = JSON.parse(device.data_json || "{}") as Record<string, unknown>;
    if (!canAccessDevice(getUserScope(db, request.auth!), String(deviceData.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    db.prepare("UPDATE agent_conversations SET unread=0,updated_at=CURRENT_TIMESTAMP WHERE device_code=(SELECT device_code FROM agent_devices WHERE id=?)").run(deviceId);
    return { success: true };
  });
  // 之前恒返回空数组（还没接跟进逻辑）。现在返回真实待跟进候选：
}

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { serializeAgentDevice, serializeCandidate, serializeMetrics, serializeStatusDashboard } from "../../shared/response-serializers.js";
import { canAccessDevice, deviceConstraint, getUserScope } from "../../auth/user-scopes.js";
import { createHash, randomUUID } from "node:crypto";
import { MessageEventService } from "../messaging/message-events.js";
import { createMessageChannelProvider } from "../messaging/message-channel-provider.js";
import { BridgeError, DeviceBridgeStore } from "../messaging/device-bridge.js";
import { NOOP_NOTIFIER, type StreamNotifier } from "../messaging/stream-events.js";
import { readWeComConfig } from "../wecom/wecom-config.js";
import { deviceDifyConfig, HttpDifyProvider } from "../dify/dify-provider.js";
import { listReminderTasks } from "./followup.js";
import { loadFactories, parseDeviceData, readDeviceFactoryIds } from "../../shared/device-factories.js";
import { isAllowedWebhookUrl, readInviteGroupConfig } from "../../shared/invite-group.js";

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
  // 本地新增，目标站契约里没有这条（7 轮 parity 快照均未抓到同类端点）——
  // 纯运维工具：管理员在后台填完某设备自己的 dify_url/dify_key 后，一键验证能否连上，
  // 不用等真实客户发消息才发现配置错了。调用既有的 DifyProvider.healthCheck()，不新建逻辑。
  app.post<{ Params: { id: string } }>("/api/v1/agent/devices/:id/test-dify", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined;
    const data = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    const { baseUrl, apiKey } = deviceDifyConfig(data);
    if (baseUrl.startsWith("mock://")) return reply.code(422).send({ detail: "Device has no dify_url configured" });
    // 刻意不走 createDifyProvider()：那个工厂按 REA_DIFY_PROVIDER 选对话引擎
    // (chatflow/mock 模式下 healthCheck 永远返回 healthy:true，不发真实请求)。
    // 这里的"测试连接"要验证管理员填的地址本身能不能通，必须真打一次 HTTP 请求。
    const result = await new HttpDifyProvider().healthCheck({ baseUrl, apiKey });
    return { device_id: id, base_url: baseUrl, healthy: result.healthy, latency_ms: result.latency_ms, error: result.error };
  });
  app.get<{ Querystring: { device_code?: string } }>("/api/v1/agent/conversations", async (request, reply) => {
    const deviceCode = request.query.device_code ?? "";
    if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" });
    bridgeStore.expireClaims(deviceCode);
    // is_old_friend 必须由服务端算：对话页的「转为老友」按钮过去只改前端内存，
    // 刷新/轮询就被列表覆盖回去，运营以为标了其实没标。
    const rows = db.prepare(`SELECT c.*,
        EXISTS(SELECT 1 FROM old_friend_records f
                WHERE f.device_code=c.device_code AND CAST(f.customer_id AS TEXT)=CAST(c.customer_id AS TEXT)) AS is_old_friend
      FROM agent_conversations c WHERE c.device_code=? ORDER BY c.updated_at DESC`).all(deviceCode) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({ ...row, is_old_friend: Boolean(row.is_old_friend) })),
      total_unread: rows.reduce((sum, row) => sum + Number(row.unread ?? 0), 0),
    };
  });
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
  app.get<{ Querystring: { event_type?: string; page?: string; page_size?: string } }>("/api/v1/agent/candidates", async (request) => {
    const page = Math.max(1, Number(request.query.page) || 1), pageSize = Math.min(1000, Math.max(1, Number(request.query.page_size) || 50));
    // 带 JOIN 时条件必须显式前缀：candidate_events 与 bridge_devices 都有
    // device_code，不加 c. 会报 ambiguous column name（scoped 用户直接 500）。
    const scopeFilter = deviceConstraint(getUserScope(db, request.auth!), "c.device_code");
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (request.query.event_type) { conditions.push("c.event_type=?"); params.push(request.query.event_type); }
    if (scopeFilter.sql) conditions.push(scopeFilter.sql.replace(/^ AND /, ""));
    params.push(...scopeFilter.values);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    // Target item has no data_json/updated_at, and does carry wechat_id
    // (stored inside data_json locally since the column doesn't exist).
    const COLUMNS = "id,device_code,customer_id,nickname,event_type,event_at,name,phone,interview_date,interview_time,factory_name,province,city,district,status,remind_count,disqualified_reason,created_at,data_json";
    // 归属账号 = 该设备登录的企微账号（bridge_devices.account_id）。
    // 候选人表里没有这个字段，页面又必须显示「这条名单是从哪个账号发的」，
    // 所以在查询里 join 出来；设备没上报过账号时回空串。
    const rows = db.prepare(`SELECT c.${COLUMNS.split(",").join(",c.")},
        COALESCE(b.account_id,'') AS account
       FROM candidate_events c
       LEFT JOIN bridge_devices b ON b.device_code = c.device_code
       ${where}
       ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    const items = rows.map(serializeCandidate);
    const total = (db.prepare(`SELECT COUNT(*) count FROM candidate_events c${where}`).get(...params) as { count: number }).count;
    return { items, total };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/candidates", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.customer_id !== "string") return reply.code(422).send({ detail: "customer_id 必填" });
    if (!canAccessDevice(getUserScope(db, request.auth!), String(body.device_code ?? ""))) return reply.code(403).send({ detail: "Device scope required" });
    const result = db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,name,city,status,data_json) VALUES (?,?,?,?,?,?,?,?)").run(String(body.device_code ?? ""), body.customer_id, String(body.nickname ?? ""), String(body.event_type ?? "invited"), String(body.name ?? ""), String(body.city ?? ""), String(body.status ?? body.event_type ?? "invited"), JSON.stringify(body));
    return db.prepare("SELECT * FROM candidate_events WHERE id=?").get(Number(result.lastInsertRowid));
  });
  app.post<{ Params: { id: string }; Body: { status?: string } }>("/api/v1/agent/candidates/:id/mark", async (request, reply) => {
    const candidate = db.prepare("SELECT device_code FROM candidate_events WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!candidate || !canAccessDevice(getUserScope(db, request.auth!), candidate.device_code)) return reply.code(404).send({ detail: "候选人不存在" });
    const result = db.prepare("UPDATE candidate_events SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(request.body?.status ?? "marked", Number(request.params.id));
    return result.changes ? db.prepare("SELECT * FROM candidate_events WHERE id=?").get(Number(request.params.id)) : reply.code(404).send({ detail: "候选人不存在" });
  });
  /**
   * 候选人列表的「提醒到场」按钮。
   *
   * 过去页面只有 remind_count 的展示，没有任何点击入口；「回复规则 → 面试提醒」
   * 里配的话术也没有读取方。这里用配置话术发一条，成功才累加 remind_count。
   */
  app.post<{ Params: { id: string } }>("/api/v1/agent/candidates/:id/remind", async (request, reply) => {
    const id = Number(request.params.id);
    const candidate = db.prepare(
      "SELECT id, device_code, customer_id, interview_date, remind_count FROM candidate_events WHERE id=?",
    ).get(id) as { id: number; device_code: string; customer_id: string; interview_date: string; remind_count: number } | undefined;
    if (!candidate) return reply.code(404).send({ detail: "候选人不存在" });
    if (!canAccessDevice(getUserScope(db, request.auth!), candidate.device_code)) return reply.code(403).send({ detail: "Device scope required" });

    const customerId = Number(candidate.customer_id);
    if (!Number.isSafeInteger(customerId)) return reply.code(422).send({ detail: "customer_id 无效" });

    let script = "";
    try {
      const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string } | undefined;
      const parsed = row ? JSON.parse(row.value_json || "{}") as Record<string, unknown> : {};
      script = String(parsed.script ?? "").trim();
    } catch { script = ""; }
    const content = script || "明天面试记得准时到哈，到了给我发个消息";
    const remindCount = Number(candidate.remind_count ?? 0);

    try {
      const sent = await messageChannel.sendMessage({
        deviceCode: candidate.device_code,
        customerId,
        content,
        idempotencyKey: `remind:${candidate.device_code}:${candidate.customer_id}:${remindCount + 1}`,
      });
      if (!sent.success) return reply.code(502).send({ detail: sent.error ?? "发送失败" });
      db.prepare("UPDATE candidate_events SET remind_count=remind_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      return { success: true, remind_count: remindCount + 1, content };
    } catch (error) {
      return reply.code(502).send({ detail: error instanceof Error ? error.message : "发送失败" });
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
  app.get("/api/v1/agent/invite-group", async () => {
    const config = readInviteGroupConfig(db);
    return { ...config, webhookUrl: "", webhookConfigured: Boolean(config.webhookUrl), webhookPreview: maskWebhook(config.webhookUrl) };
  });
  app.put<{ Body: Record<string, unknown> }>("/api/v1/agent/invite-group", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const body = request.body ?? {};
    const current = readInviteGroupConfig(db);
    // webhook_url 不传 = 保留原值（读回来是打码的，前端不能拿打码值覆盖真值）；
    // 传空串 = 明确清除。地址必须先过白名单校验，否则后台会变成 SSRF 跳板。
    const rawWebhook = body.webhook_url;
    let webhookUrl = current.webhookUrl;
    if (typeof rawWebhook === "string") {
      const trimmed = rawWebhook.trim();
      if (trimmed === "") webhookUrl = "";
      else if (!isAllowedWebhookUrl(trimmed)) {
        return reply.code(422).send({ detail: "Webhook 地址无效：只接受 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." });
      } else webhookUrl = trimmed;
    }
    const payload = {
      enabled: body.enabled === true,
      group_name: String(body.group_name ?? "").trim(),
      device_code: String(body.device_code ?? "").trim(),
      city_abbr: body.city_abbr && typeof body.city_abbr === "object" && !Array.isArray(body.city_abbr) ? body.city_abbr : {},
      webhook_url: webhookUrl,
    };
    db.prepare(`INSERT INTO agent_configs(kind,recruiter_id,value_json,updated_at) VALUES ('invite_group','global',?,CURRENT_TIMESTAMP)
      ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`)
      .run(JSON.stringify(payload));
    const saved = readInviteGroupConfig(db);
    return { ...saved, webhookUrl: "", webhookConfigured: Boolean(saved.webhookUrl), webhookPreview: maskWebhook(saved.webhookUrl) };
  });
  // 发送记录：运营要能查「这条名单到底发出去了没有」
  app.get<{ Querystring: { limit?: string } }>("/api/v1/agent/invite-group/sends", async (request) => {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    const rows = db.prepare("SELECT * FROM invite_group_sends ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return { items: rows, total: rows.length };
  });

  // Target item shape: id, account, customer_id, nickname, device_code, status,
  // created_at — updated_at is not exposed.
  app.get("/api/v1/agent/old-friends", async (request) => {
    const scopeFilter = deviceConstraint(getUserScope(db, request.auth!), "device_code");
    const rows = db.prepare(`SELECT id,account,customer_id,nickname,device_code,status,created_at FROM old_friend_records WHERE 1=1${scopeFilter.sql} ORDER BY id DESC`).all(...scopeFilter.values);
    return { items: rows, total: rows.length };
  });
  app.get("/api/v1/agent/old-friends/accounts", async (request) => { const scopeFilter = deviceConstraint(db ? getUserScope(db, request.auth!) : { isAdmin: true, deviceCodes: [], recruiterIds: [], recruiterDbIds: [], cityIds: [], userId: 0 }, "device_code"); return { items: [...new Set((db.prepare(`SELECT account FROM old_friend_records WHERE account<>''${scopeFilter.sql} ORDER BY account`).all(...scopeFilter.values) as Array<{ account: string }>).map((row) => row.account))] }; });
  // Target rejects a mark without both identifiers as 400, not 500/200.
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/old-friends/mark", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.device_code || body.customer_id === undefined || body.customer_id === null) {
      return reply.code(400).send({ detail: "device_code and customer_id are required" });
    }
    if (!canAccessDevice(getUserScope(db, request.auth!), String(body.device_code))) return reply.code(403).send({ detail: "Device scope required" });
    // 幂等：同一台设备同一个客户只保留一条老友记录。
    // 过去每点一次「转为老友」就 INSERT 一行，重复点会堆出一串重复记录，
    // 页面上看起来像同一个人被标了多次。
    const deviceCode = String(body.device_code);
    const customerId = String(body.customer_id);
    const status = body.status === "released" ? "released" : "unreleased";
    const existing = db.prepare(
      "SELECT id FROM old_friend_records WHERE device_code=? AND CAST(customer_id AS TEXT)=? ORDER BY id DESC LIMIT 1",
    ).get(deviceCode, customerId) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE old_friend_records SET nickname=COALESCE(NULLIF(?, ''), nickname), status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(String(body.nickname ?? ""), status, existing.id);
      return db.prepare("SELECT * FROM old_friend_records WHERE id=?").get(existing.id);
    }
    const result = db.prepare("INSERT INTO old_friend_records(account,customer_id,nickname,device_code,status) VALUES (?,?,?,?,?)")
      .run(String(body.account ?? ""), customerId, String(body.nickname ?? ""), deviceCode, status);
    return db.prepare("SELECT * FROM old_friend_records WHERE id=?").get(Number(result.lastInsertRowid));
  });
  app.put<{ Params: { id: string } }>("/api/v1/agent/old-friends/:id/release", async (request, reply) => {
    const friend = db.prepare("SELECT device_code FROM old_friend_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!friend || !canAccessDevice(getUserScope(db, request.auth!), friend.device_code)) return reply.code(404).send({ detail: "Old friend not found" });
    const result = db.prepare("UPDATE old_friend_records SET status='released',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Old friend not found" });
  });
  app.put<{ Params: { id: string } }>("/api/v1/agent/old-friends/:id/unrelease", async (request, reply) => {
    const friend = db.prepare("SELECT device_code FROM old_friend_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!friend || !canAccessDevice(getUserScope(db, request.auth!), friend.device_code)) return reply.code(404).send({ detail: "Old friend not found" });
    // 前端词表只有 released / unreleased（可聊 / 不可聊），写 'active' 会让行内
    // 徽标与三个计数卡都对不上，所以这里必须用 unreleased。
    const result = db.prepare("UPDATE old_friend_records SET status='unreleased',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Old friend not found" });
  });
  app.delete<{ Params: { id: string } }>("/api/v1/agent/old-friends/:id", async (request, reply) => {
    const friend = db.prepare("SELECT device_code FROM old_friend_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!friend || !canAccessDevice(getUserScope(db, request.auth!), friend.device_code)) return reply.code(404).send({ detail: "Old friend not found" });
    const result = db.prepare("DELETE FROM old_friend_records WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Old friend not found" });
  });
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
  // status='invited' + interview_date 已到 + remind_count 未超 max_count，并带上设备范围过滤。
  app.get("/api/v1/agent/reminder-tasks", async (request) => {
    const scopeFilter = deviceConstraint(getUserScope(db, request.auth!), "device_code");
    return { items: listReminderTasks(db, { filter: { sql: scopeFilter.sql, values: scopeFilter.values } }) };
  });
  // Target shape: {ok: boolean, message: string} — a status envelope, not the
  // stored workflow blob itself.
  app.get<{ Params: { id: string } }>("/api/v1/agent/device/:id/workflow", async (request) => {
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(Number(request.params.id)) as { data_json: string } | undefined;
    const data = row && typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return { ok: false, message: "设备不存在" };
    const uploaded = Boolean(data.workflow_file || data.workflow);
    return { ok: uploaded, message: uploaded ? "" : "暂未上传工作流文件" };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/agent/device/:id/workflow", async (request, reply) => { const id = Number(request.params.id); const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined; const existing = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {}; if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(existing.device_code ?? ""))) return reply.code(404).send({ detail: "设备不存在" }); const result = db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify({ ...existing, ...(request.body ?? {}) }), id); return result.changes ? request.body ?? {} : reply.code(404).send({ detail: "设备不存在" }); });
  app.delete<{ Params: { id: string } }>("/api/v1/agent/device/:id/workflow", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined;
    const data = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    const result = db.prepare("UPDATE agent_devices SET data_json='{}',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Device not found" });
  });
  // Target shape: {start_date, end_date, items} — a date window, not counters.
  app.get("/api/v1/agent/report/metrics", async () => {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    return serializeMetrics({ start_date: start, end_date: end, items: [] });
  });

  // 设备话术（契约 docs/对齐-配置分发与按设备话术.md §2）：管理端维护，
  // 经 GET /bridge/devices/:code/config 下发给客户端。POST 按
  // (device_code, stage, city) upsert——库上有 UNIQUE 约束兜底。
  const deviceScriptsRoutes = "/api/v1/agent/device-scripts";
  const scriptField = (body: Record<string, unknown>, key: string, max: number) =>
    typeof body[key] === "string" && String(body[key]).length <= max ? String(body[key]) : "";
  app.get<{ Querystring: Record<string, string> }>(deviceScriptsRoutes, async (request) => {
    const filters: string[] = [];
    const args: string[] = [];
    for (const key of ["device_code", "stage", "city"] as const) {
      const value = (request.query?.[key] ?? "").trim();
      if (value) { filters.push(`${key}=?`); args.push(value); }
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return { items: db.prepare(`SELECT * FROM device_scripts ${where} ORDER BY id DESC`).all(...args) };
  });
  app.post<{ Body: Record<string, unknown> }>(deviceScriptsRoutes, async (request, reply) => {
    const body = request.body ?? {};
    const deviceCode = scriptField(body, "device_code", 64);
    if (!deviceCode) return reply.code(422).send({ detail: "device_code required" });
    const stage = scriptField(body, "stage", 64) || "send_info";
    if (!["ask_city", "send_info", "ask_interview", "collect", "done"].includes(stage)) {
      return reply.code(422).send({ detail: "Invalid stage" });
    }
    const city = scriptField(body, "city", 64);
    const title = scriptField(body, "title", 200);
    const content = scriptField(body, "content", 20000);
    const status = body.status === "disabled" ? "disabled" : "enabled";
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO device_scripts(device_code,city,stage,title,content,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(device_code,stage,city) DO UPDATE SET
        title=excluded.title, content=excluded.content, status=excluded.status, updated_at=excluded.updated_at`)
      .run(deviceCode, city, stage, title, content, status, now, now);
    return db.prepare("SELECT * FROM device_scripts WHERE device_code=? AND stage=? AND city=?").get(deviceCode, stage, city);
  });
  app.delete<{ Params: { id: string } }>(`${deviceScriptsRoutes}/:id`, async (request, reply) => {
    const result = db.prepare("DELETE FROM device_scripts WHERE id=?").run(Number(request.params.id));
    return result.changes ? { ok: true } : reply.code(404).send({ detail: "Not Found" });
  });
}

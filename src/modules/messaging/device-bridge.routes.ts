import { timingSafeEqual } from "node:crypto";
import { authorizeProfileRequest } from "../agent/profile.routes.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import { DeviceBridgeStore } from "./device-bridge.js";
import { isDirectRecipient, recipientBindings, reportRecipientBinding } from "./recipient-binding.js";
import { cloudAgentRuntime, hasPendingCloudAssignment, isAssignedCloudAgent, protectedMachineConnection, recordCloudAgentHeartbeat } from "../agent/cloud-agent-assignment.js";
import { queuePendingDifyGroupNotifications } from "../dify/dify-group-notification.js";
import { MessageEventService } from "./message-events.js";
import { createMessageChannelProvider } from "./message-channel-provider.js";
import type { StreamNotifier } from "./stream-events.js";
import { recordInboundMessage } from "./inbound-store.js";
import { loadFactories, receptionFactoryIds, resolveDevicePosition } from "../../shared/device-factories.js";
import { latestPositionScriptStamp, loadPositionScripts } from "../../shared/media-assets.js";
import { loadPositionLocationCards } from "../../shared/location-card.js";

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

// 岗位口径：subway 只推地铁/安检岗（2026-11-12 运营「暂时按地铁的来」），
// all 不过滤。只在枚举内时下发，脏值不下发 → 客户端用空串跟随本地默认。
const JOB_SCOPES = new Set(["subway", "all"]);

function matchesRegisterKey(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerDeviceBridgeRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  notifier: StreamNotifier,
  clearLoginVerification: (code: string) => void,
): DeviceBridgeStore {
  const store = new DeviceBridgeStore(db, Date.now, notifier);
  const events = new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? "local-webhook-secret" });
  // Dify 用不上时宁可不回也不能把 Mock 文案发给真实客户（2026-11-16 整合）：
  // 部署没配 REA_DIFY_PROVIDER → 服务端只记录不生成，执行权归客户端 drain()。
  // AI 自动回复已由新 Agent 链路（autopilot + /agent/chat）负责，入站只做存储与事件


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
    if (hasPendingCloudAssignment(db, code)) return reply.code(409).send({ detail: "云电脑正在配对，暂不能重新生成配对凭据" });
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
    if (hasPendingCloudAssignment(db, req.params.code)) return reply.code(409).send({ detail: "云电脑正在配对，暂不能重新生成配对凭据" });
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
    const profileRequest = authorizeProfileRequest(req);
    if (!profileRequest) {
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
    // 人工接管名单：客户端回复前查这里，命中就跳过（网页上点「接管」= 让 AI 别回）。
    // 用 external_conversation_id 而不是 customer_id —— 客户端的会话标识是企微
    // 会话 ID，落到库里就是这一列（见 DeviceBridgeStore.contact）。
    const takeoverRows = db.prepare(
      "SELECT external_conversation_id,updated_at FROM agent_conversations WHERE device_code=? AND takeover=1 AND external_conversation_id IS NOT NULL AND external_conversation_id<>''",
    ).all(code) as Array<{ external_conversation_id: string; updated_at: string | null }>;
    const takeoverSessions = takeoverRows.map((row) => row.external_conversation_id);
    const takeoverUpdated = takeoverRows.reduce<string | null>(
      (latest, row) => (stampOf(row.updated_at) > stampOf(latest) ? row.updated_at : latest),
      null,
    );
    // 已流失名单：客户说「我不去了」后由 8090 标记（stage=gave_up →
    // recruit_status=disqualified）。客户端命中就整轮不碰——不再发任何消息。
    // 与接管名单分开下发：语义不同（接管可交还，流失要人工恢复）。
    const abandonedRows = db.prepare(
      "SELECT external_conversation_id,updated_at FROM agent_conversations WHERE device_code=? AND recruit_status='disqualified' AND external_conversation_id IS NOT NULL AND external_conversation_id<>''",
    ).all(code) as Array<{ external_conversation_id: string; updated_at: string | null }>;
    const abandonedSessions = abandonedRows.map((row) => row.external_conversation_id);
    const abandonedUpdated = abandonedRows.reduce<string | null>(
      (latest, row) => (stampOf(row.updated_at) > stampOf(latest) ? row.updated_at : latest),
      null,
    );
    const scriptUpdated = (db.prepare("SELECT MAX(updated_at) AS at FROM device_scripts WHERE device_code=?").get(code) as { at: string | null }).at;
    // 岗位话术也参与版本号：运营改了岗位话术，客户端必须重新拉配置才会换词。
    const positionScriptUpdated = latestPositionScriptStamp(db);
    const newer = [scriptUpdated, positionScriptUpdated, device.updated_at, takeoverUpdated, abandonedUpdated]
      .reduce<string | null>((latest, value) => (stampOf(value) > stampOf(latest) ? (value ?? null) : latest), null) ?? "";
    /**
     * 招工方 id 兜底解析：设备只绑了厂名、没绑 employer_id 时，按厂名/别名反查。
     *
     * 为什么要兜底：客户真实资料里最有价值的问答（华荻要查纹身、利口福要健康证、
     * 松下不查纹身）全部挂在 employer 作用域。设备没绑 employer_id，8090 的
     * kb_faq.lookup 就直接跳过这一层落到 global，只能拿到 {welfare} 这类占位符——
     * 而岗位数据里没有这些字段，渲染出来是空串，客户问了等于没答。
     *
     * 只读、只补值：data_json 里显式写了 employer_id 就以它为准，绝不覆盖。
     */
    const factoryName = typeof params.factory_name === "string" ? params.factory_name : "";
    const resolveEmployerId = (): number => {
      if (Number.isInteger(params.employer_id)) return Number(params.employer_id);
      const name = factoryName.trim();
      if (!name) return 0;
      const byAlias = db.prepare(
        `SELECT e.id AS id FROM employer_alias a JOIN employer e ON e.id = a.employer_id
         WHERE a.alias = ? ORDER BY a.weight DESC, e.id LIMIT 1`,
      ).get(name) as { id: number } | undefined;
      if (byAlias) return Number(byAlias.id);
      const byName = db.prepare(
        "SELECT id FROM employer WHERE display_name = ? OR short_name = ? ORDER BY id LIMIT 1",
      ).get(name, name) as { id: number } | undefined;
      return byName ? Number(byName.id) : 0;
    };
    /**
     * 设备 → 工厂「多选」绑定（契约 §6）：一个号可以同时接几个厂的单。
     * 下发 id 列表给 8090 做 `sp.factory_id IN (...)` 过滤，厂名给客户端展示。
     * 脏数据（非整数 / 重复 / 库里没有）在 readDeviceFactoryIds 里已经过滤干净。
     */
    const boundFactoryIds = receptionFactoryIds(db, params);
    const boundFactories = loadFactories(db, boundFactoryIds).map((factory) => ({ id: factory.id, name: factory.name }));
    /**
     * 岗位话术（契约 §5）：只下发本设备已绑定工厂的岗位话术；没绑厂 = 通用设备，
     * 下发全部 enabled 话术（否则新设备刚上线会一条话术都没有）。
     * 每条 media 已按 media_assets 补齐 sha256，查不到的资源被丢弃。
     */
    const agentPosition = params.reply_provider === "dify" ? undefined : resolveDevicePosition(db, params, "agent");
    const positionScripts = loadPositionScripts(db, boundFactoryIds, agentPosition);
    /**
     * employer_id 多厂口径：显式配了就以它为准；没配且绑了多个厂就回 0。
     *
     * 为什么要回 0：纹身/健康证/体检这类口径全挂在 employer 作用域，多厂设备如果
     * 拿第一个厂的 employer_id 去查 KB，第二个厂的客户会被按第一个厂的规矩回答——
     * 答错比不答更糟。回 0 让 8090 退回 global，至少不会串厂。
     */
    const employerIdForConfig = (): number => {
      if (Number.isInteger(params.employer_id)) return Number(params.employer_id);
      if (boundFactoryIds.length > 1) return 0;
      return resolveEmployerId();
    };
    // 启动前只读核对人工队列：覆盖全部任务，不领取、不回收过期租约。
    // 队列变化不推动配置 version；运维应读取每次响应中的实时计数。
    const commandQueue = { queued: 0, claimed: 0, unknown: 0 };
    const commandCounts = db.prepare(
      "SELECT status,COUNT(*) AS count FROM bridge_commands WHERE device_code=? AND status IN ('queued','claimed','unknown') GROUP BY status",
    ).all(code) as Array<{ status: keyof typeof commandQueue; count: number }>;
    for (const row of commandCounts) commandQueue[row.status] = row.count;
    const account = profileRequest ? "" : store.status(code)?.account_id ?? "";
    return {
      version: newer,
      ...(account ? { recipient_bindings_account_id: account, recipient_bindings: recipientBindings(db, code, account) } : {}),
      command_queue: commandQueue,
      interval_seconds: positive(params.interval_seconds, 20),
      cooldown: positive(params.cooldown, 8),
      merge_delay_seconds: positive(params.merge_delay_seconds, 0),
      // brain.mode 允许网页远程切换（kb 知识库 / flow 流程编排 / fixed 固定文本）。
      // 客户端检测到变化后会重建 Brain 实例；缺省或非法值不下发，保留客户端本地配置。
      ...(BRAIN_MODES.has(String(params.brain_mode)) ? { brain_mode: String(params.brain_mode) } : {}),
      // 人工接管中的会话：客户端 drain 时跳过，避免人工和 AI 同时往一个客户发消息。
      takeover_sessions: takeoverSessions,
      // 已流失的会话：客户说「我不去了」，客户端整轮不碰，不再发任何消息。
      abandoned_sessions: abandonedSessions,
      // 设备绑定的工厂/城市（契约 docs/对齐-设备工厂绑定与资料导入.md §1）：
      // 8090 拿去做知识库过滤，data_json 没绑就回空串 = 通用/不限。
      factory_name: factoryName,
      // 多厂绑定：factory_ids 供 8090 做岗位/知识库过滤，factories 供客户端展示。
      // 没绑 = 两个都空，消费方按「不限」处理（与老字段 factory_name 空串同义）。
      factory_ids: boundFactoryIds,
      factories: boundFactories,
      ...(agentPosition ? { position_id: agentPosition } : {}),
      city: typeof params.city === "string" ? params.city : "",
      // 知识库 v3：品类与招工方 id（docs/知识库方案-流程驱动-20261113.md §3.7）。
      // 绑了 id 就走 kb_faq 硬过滤（别家厂的问答不进候选集）；
      // 没绑回 0，8090 退回按 factory_name 匹配的旧路径。
      vertical_id: Number.isInteger(params.vertical_id) ? Number(params.vertical_id) : 0,
      // 显式值优先；单厂且只绑了厂名时按厂名/别名反查；多厂未显式配置回 0（见上）
      employer_id: employerIdForConfig(),
      // 岗位口径（2026-11-13）：subway = 只推地铁/安检岗，all = 不过滤，
      // 空串 = 跟随 8090 的环境变量默认（FLOW_ONLY_SUBWAY，当前默认 1）。
      // 放 data_json 里让运营在网页改，不必登服务器改环境变量重启。
      ...(JOB_SCOPES.has(String(params.job_scope)) ? { job_scope: String(params.job_scope) } : {}),
      scripts,
      // 岗位话术：按岗位配置一次、所有接这个岗位的设备共用（迁移 030）。
      // 与 scripts（按设备+stage+城市）并存，客户端优先用岗位话术。
      position_scripts: positionScripts,
      // 企微原生位置卡（迁移 061）：面试点绑定了采集到的卡才下发。
      // 客户端把它写进剪贴板再 Ctrl+V，粘出来就是能点开导航的原生卡。
      location_cards: loadPositionLocationCards(
        db,
        agentPosition ?? 0,
        String((db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(code) as { account_id?: string } | undefined)?.account_id ?? ""),
      ),
    };
  });
  app.post<DeviceRequest>("/api/v1/bridge/devices/:code/recipient-binding", async (req, reply) => {
    const { code } = req.params;
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
    if (!store.enabled(code)) return reply.code(403).send({ detail: "Device disabled" });
    const body = req.body ?? {};
    const account_id = field(body, "account_id", 128);
    const conversation_id = field(body, "conversation_id");
    const status = field(body, "status", 32);
    const remark = field(body, "remark", 32);
    if (!account_id || store.status(code)?.account_id !== account_id) {
      return reply.code(409).send({ detail: "设备当前登录账号未确认" });
    }
    if (!isDirectRecipient(account_id, conversation_id) ||
      (status !== "conflict" && status !== "verified" && status !== "needs_confirmation")) {
      return reply.code(422).send({ detail: "会话或核验结果无效" });
    }
    if (!db.prepare("SELECT 1 FROM bridge_contacts WHERE device_code=? AND contact_id=?").get(code, conversation_id)) {
      return reply.code(404).send({ detail: "会话尚未同步" });
    }
    const binding = reportRecipientBinding(db, code, { account_id, conversation_id, status, remark });
    return binding ?? reply.code(409).send({ detail: "核验结果已过期，请刷新会话绑定" });
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
        const cloudAssigned = isAssignedCloudAgent(db, code);
        const runtime = cloudAssigned ? cloudAgentRuntime(body.runtime, state) : body.runtime;
        if (cloudAssigned && !protectedMachineConnection(req)) return reply.code(403).send({ detail: "云电脑心跳需要可信 HTTPS" });
        if (cloudAssigned && !runtime) return reply.code(422).send({ detail: "缺少有效的 Windows 运行状态" });
        // 状态变化的 device_events 落表与推送都收敛在 store.heartbeat 里：
        // 只有真正变化才落一条 reason='reported' 的事件并推 device.updated。
        store.heartbeat(code, state as "online" | "offline" | "scanning", field(body, "account_id"));
        if (runtime === undefined) store.clearRuntimeHealth(code);
        else store.updateRuntimeHealth(code, runtime);
        if (cloudAssigned) recordCloudAgentHeartbeat(db, code, token, state);
        return { device: store.status(code) };
      }
      if (action === "claim") {
        const device = store.status(code);
        if (device?.state === "online") queuePendingDifyGroupNotifications(db, code, device.account_id);
        // only=refresh_login_qr：登录态下只领刷新指令，不碰消息队列。
        const query = (req.query ?? {}) as Record<string, unknown>;
        const only = typeof query.only === "string" ? query.only : "";
        const command = store.claim(code, only);
        if (command) notifier.commandUpdated(code, command);
        return { command };
      }
      if (action === "receipts") {
        const status = field(body, "status");
        if (!["succeeded", "failed", "unknown"].includes(status)) return reply.code(422).send({ detail: "Invalid receipt status" });
        store.receipt(code, field(body, "command_id"), field(body, "lease_token"), status as "succeeded" | "failed" | "unknown", field(body, "message_id"), body.simulated === true, field(body, "error", 500));
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
      // 落库（agent_messages + 会话摘要）——原 automation 的存储半段
      recordInboundMessage(db, { deviceCode: code, customerId, content, sentAt, eventId: scopedId });
      events.recordEvent({ eventId: scopedId, eventType: "message.created", direction: "inbound", deviceCode: code, customerId, payload: { content } });
      // SSE 推送（原由 automation 内部触发，摘除 dify 后改为路由内直发）
      notifier.messageCreated(code, customerId, scopedId);
      return { status: "stored", customer_id: customerId };
    });
  }
  /**
   * 登录二维码：云端机器上的企微掉登录后，把扫码窗截图送到网页，让用户用手机扫。
   *
   * 为什么必须服务端中转：机器在云端（134.175.40.31 这类专用机），扫码的人和
   * 运营都看不到那块屏幕。没有这条路，每次风控掉线只能等现场有人去看屏幕。
   *
   * 鉴权：设备用桥接令牌（Bearer），网页用用户 JWT —— 两条独立的读写路径。
   * 为什么不开成公开接口：二维码等同于登录凭证，拿到它就能顶替这个号登录。
   */
  app.post<{ Params: { code: string }; Body: Record<string, unknown> }>(
    "/api/v1/bridge/devices/:code/login-qr",
    async (req, reply) => {
      const code = req.params.code;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
      if (!store.enabled(code)) return reply.code(403).send({ detail: "Device disabled" });
      const body = req.body ?? {};
      const image = typeof body.image_b64 === "string" ? body.image_b64 : "";
      // 一张 400x560 的二维码 PNG base64 约 20-60KB；超过 2MB 说明客户端传的是
      // 原始位图或整屏截图，直接拒绝，免得把 SQLite 撑爆。
      if (!image || image.length > 2_000_000) {
        return reply.code(422).send({ detail: "image_b64 required (max 2000000 chars)" });
      }
      const capturedAt = typeof body.captured_at === "string" && body.captured_at
        ? body.captured_at
        : new Date().toISOString();
      store.saveLoginQr(
        code,
        image,
        Number(body.width ?? 0) || 0,
        Number(body.height ?? 0) || 0,
        capturedAt,
      );
      return { ok: true };
    },
  );
  app.delete<{ Params: { code: string } }>(
    "/api/v1/bridge/devices/:code/login-qr",
    async (req, reply) => {
      const code = req.params.code;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
      store.clearLoginQr(code);
      clearLoginVerification(code);
      return { ok: true };
    },
  );
  // 设备群聊清单上报：autopilot 每 N 分钟从企微本地库（sessions type='群聊'）
  // 读取群聊列表推上来，管理端「面试登记」面板下拉自选绑定群聊。
  // 鉴权与 login-qr 同一套：设备桥接令牌。
  app.post<{ Params: { code: string }; Body: Record<string, unknown> }>(
    "/api/v1/bridge/devices/:code/groups",
    async (req, reply) => {
      const code = req.params.code;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!store.authenticate(code, token)) return reply.code(401).send({ detail: "Invalid device token" });
      if (!store.enabled(code)) return reply.code(403).send({ detail: "Device disabled" });
      const body = req.body ?? {};
      const raw = Array.isArray(body.groups) ? body.groups : [];
      const groups = raw
        .map((g) => (typeof g === "object" && g !== null ? (g as Record<string, unknown>) : {}))
        .map((g) => ({ conv_id: String(g.conv_id ?? "").trim(), name: String(g.name ?? "").trim() }))
        .filter((g) => g.conv_id && g.name)
        .slice(0, 300);
      const saved = store.saveGroups(code, groups);
      return { ok: true, count: saved };
    },
  );

  // 返回 store 供 server.ts 挂 30s 掉线清扫定时器。
  return store;
}

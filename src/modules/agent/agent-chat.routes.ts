import { replyModePending } from "../dify/reply-mode-transition.js";
import { archiveCandidates } from './archive-candidates.js';
import { buildArchiveNoticeLine } from './archive-notify.js';
import { followupChatLines, followupModels, generateFollowupSummary } from "./archive-followup-summary.js";
import { recruitmentCandidates, candidateConversation } from './recruitment-candidates.js';
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { authorizeProfileRequest } from "./profile.routes.js";
import { isValidDeviceToken } from "./position-scripts.routes.js";
import { firstFlowSegment, readFlow } from "./agent-flow.routes.js";
import { complete, environmentModel, parseJsonObject } from "./agent-llm.js";
import { activeAgentModel, agentModelStatus } from "./agent-model-settings.js";
import { deviceReplyProvider, generateDifyReply, hasDifyDeviceToken, ownsReplyDevice } from "../dify/dify-reply.js";
import { difyGroupNotificationState } from "../dify/dify-group-notification.js";
import { difyContext } from "../dify/dify-context.js";
import { recruitmentPositionAvailable } from "../dify/dify-recruitment.js";
import { normalizeInterviewPoints, normalizePositionFacts } from "../../shared/position-facts.js";
import { previewFavoriteLocation } from "../../shared/favorite-location.js";
import { positionKnowledge } from './position-knowledge.js';
import { faqMediaForQuestion, normalizeFaqUtterance } from "./faq-media.js";
import { difySendDelays } from "../dify/dify-invitation.js";
import { listExecutionTraces, newExecutionTraceId, readExecutionTrace, writeExecutionTrace } from "./execution-trace.js";
import { updateExecutionTraceDelivery } from "./execution-trace.js";
import {
  buildOrchestration,
  guessCustomerName,
  mergeArchive,
  parseScripts,
  type ArchiveRecord,
  type DialogueItem,
  type OpeningItem,
} from "./agent-orchestrator.js";
import { devicePositionId } from "../../shared/device-factories.js";
import { openingVersion } from "../../shared/opening-version.js";
import { parseOpeningLocation } from "../../shared/opening-location.js";

/**
 * Agent 会话接口 + 调试台的后端（迁移 038 的消费侧）。
 *
 * 四个接口分两类：
 *   客户端用
 *     GET  /api/v1/agent/opening?device_code=   取这个设备的开场清单 + 人设
 *     POST /api/v1/agent/opening/log            开场逐条回执（失败也记）
 *     POST /api/v1/agent/chat                   一轮对话：人设 + 事实 + 全量历史 → JSON
 *   调试台用
 *     GET  /api/v1/agent/context?position_id=   人设 / 事实 / 开场 / 拼好的 messages
 *
 * 约定：
 *   - 输入是标准多轮 messages（system 放人设 + 事实），输出是 JSON 字符串；
 *   - 金额必须能在事实里找到，找不到整条判失败（防编工价）；
 *   - 没配模型 key 时返回 ok:false + error，不抛 500，调试台能直接看见原因。
 */

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;

type PositionRow = {
  id: number;
  position_name: string;
  status: string;
  data_json: string;
  factory_name: string | null;
  city_name: string | null;
};

type OpeningRow = {
  id: number;
  position_id: number;
  seq: number;
  kind: string;
  content: string;
  media_name: string;
  delay_ms: number;
  status: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 客户明确要定位/导航时，挑出要发的那个面试点。
 *
 * 坐标来自企微位置消息（content_type=6）里读出来的真实经纬度；面试点只在
 * 岗位原始 data_json 里，facts 不输出 interview_points。
 */
/**
 * 这句话是不是在问「怎么去 / 在哪」。
 *
 * 单独抽出来是为了可以脱离 LLM 单测：这条判断决定了客户问地址时能不能
 * 收到能点开导航的原生位置卡，回归一次就多一次「只回文字没有定位」的投诉。
 */
export function asksForLocation(question: string): boolean {
  const q = question.normalize("NFC").trim();
  // 客户只要问到「怎么去 / 在哪 / 地址 / 面试地点」就补一张能点开导航的原生卡。
  // 2026-11-26：「面试地点」这类最常问的说法原先没命中，只有「定位/地址」才发卡。
  if (!/定位|导航|地图|怎么走|怎么去|怎么到|怎么过去|在哪|哪里|地址|面试地点|面试点|路线|坐地铁|坐车/.test(q)) return false;
  // 问宿舍/工资时顺带提了「在哪」不算问路，别把面试卡糊上去。
  return !/宿舍|住宿|食堂|餐厅|工资|薪资|待遇/.test(q);
}

function pickInterviewPoint(question: string, facts: Record<string, unknown>): Record<string, unknown> | null {
  const q = question.normalize("NFC").trim();
  if (!asksForLocation(q)) return null;
  const points = Array.isArray(facts.interview_points)
    ? (facts.interview_points as Array<Record<string, unknown>>)
    : [];
  const withCoord = points.filter(p => Number(p.lng) && Number(p.lat));
  if (!withCoord.length) return null;
  const mentioned = withCoord.filter(p => q.includes(String(p.name ?? "")));
  return withCoord.length === 1 ? withCoord[0] : mentioned[0] ?? null;
}

/**
 * 原生位置卡（2026-11-25）：坐标 + 地址 + 名称，客户端据此生成企微位置消息。
 *
 * 以前只能拼高德链接；现在客户端能直接发原生卡（见 agent/location_card.py），
 * 所以有卡就不再加链接——两条一起发既啰嗦又容易让客户以为发重了。
 */
function buildLocationCard(question: string, facts: Record<string, unknown>):
  { lng: number; lat: number; address: string; name: string } | null {
  const point = pickInterviewPoint(question, facts);
  if (!point) return null;
  return {
    lng: Number(point.lng),
    lat: Number(point.lat),
    address: String(point.address ?? ""),
    name: String(point.name ?? "面试地点"),
  };
}

/**
 * 兜底链接：只有拿不到位置卡（没坐标）时才用。
 * 不带 name 参数——中文名 percent-encode 后是一串 %E5%86%A0… 乱码。
 */
function buildMapLink(question: string, facts: Record<string, unknown>): string {
  const point = pickInterviewPoint(question, facts);
  if (!point) return "";
  return `导航：https://uri.amap.com/marker?position=${point.lng},${point.lat}`;
}

function positionRow(db: DatabaseSync, positionId: number): PositionRow | undefined {
  return db
    .prepare(
      `SELECT p.id, p.position_name, p.status, p.data_json,
              f.factory_name AS factory_name, c.city_name AS city_name
         FROM service_positions p
         LEFT JOIN factories f ON f.id = p.factory_id
         LEFT JOIN cities c ON c.id = COALESCE(p.city_id, f.city_id)
        WHERE p.id = ?`,
    )
    .get(positionId) as PositionRow | undefined;
}

/** 设备 → 岗位。绑定工厂变化后自动淘汰不属于该工厂的旧岗位。 */
function positionOfDevice(db: DatabaseSync, deviceCode: string): number {
  return devicePositionId(db, deviceCode);
}

function buildFacts(db: DatabaseSync, row: PositionRow | undefined): Record<string, string> {
  if (!row) return {};
  const data = normalizePositionFacts(safeJson(row.data_json));
  const merged: Record<string, string> = {
    city: text(data.city) || String(row.city_name || ""),
    factory_name: text(data.factory_name) || String(row.factory_name || ""),
    job_title: text(data.job_title) || String(row.position_name || ""),
    wage_text: text(data.wage_text),
    hours_text: text(data.hours_text),
    age_text: text(data.age_text),
    welfare_text: text(data.welfare_text),
    place: text(data.place),
    interview_time: text(data.interview_time),
    // 面试时间说明与地址（2026-11-17 新岗位）：进 prompt 让 Agent 自然应答
    // 「几点面试 / 怎么走」，不硬提取、不硬编码。
    interview_time_text: text(data.interview_time_text),
    interview_address: text(data.interview_address),
    interview_points: normalizeInterviewPoints(data.interview_points)
      .map(point => [
        point.address && point.address !== point.name ? `${point.name}（${point.address}）` : point.name,
        point.interview_time && `面试时间：${point.interview_time}`,
        point.checkin_guide && `到场指引：${point.checkin_guide}`,
      ].filter(Boolean).join("，"))
      .join("；"),
    interview_material: text(data.interview_material),
    basic_requirements: text(data.basic_requirements),
    onboarding_notes: text(data.onboarding_notes),
    height_text: text(data.height_text),
    tattoo_policy: text(data.tattoo_policy),
    cert_text: text(data.cert_text),
    job_content: text(data.job_content),
    additional_info: text(data.additional_info),
  };
  // 岗位专属媒体（2026-11-17 媒体分层）：通用素材（工作内容/安检视频/宿舍）
  // 全岗位共用、模型按媒体库清单随取；面试地点图各城市地址不同，绑定到岗位
  // （media_assets.position_id），这里把名字注入事实卡——模型只知道本岗位
  // 的地点图，不会把广州的图发给佛山的客户。
  const boundMedia = db
    .prepare(
      "SELECT name, kind FROM media_assets WHERE position_id=? AND status='enabled' ORDER BY id",
    )
    .all(row.id) as Array<{ name: string; kind: string }>;
  for (const media of boundMedia) {
    if (media.kind === "image" && !merged.interview_address_image) {
      merged.interview_address_image = String(media.name);
    } else if (media.kind === "video" && !merged.interview_video) {
      merged.interview_video = String(media.name);
    }
  }
  // 通用媒体清单（2026-11-18 线上实测）：客户要图/视频/说没收到时，模型
  // 需要知道通用池里有哪些素材名（工作内容/安检视频/宿舍）——之前只有
  // 岗位专属的 interview_address_image，通用素材名模型完全不可见，
  // 导致「重新发一下图片」只能文字道歉。逗号分隔的名字清单。
  const catalog = (
    db.prepare(
      "SELECT name FROM media_assets WHERE status='enabled' AND position_id=0 ORDER BY id",
    ).all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .join("、");
  if (catalog) merged.media_catalog = catalog;
  // 空值不出现：prompt 里「工价：」后面空着比不写更容易让模型以为「没有限制」
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => String(value || "").trim()),
  );
}

/**
 * 与 facts 同一套字段的来源说明。这里不猜测 Dify 的内部覆盖规则；
 * Agent 当前只显示岗位 JSON、城市和厂区这几类招聘系统实际能证明的来源。
 */
function buildFactSources(row: PositionRow | undefined, facts: Record<string, string>): Record<string, Record<string, unknown>> {
  if (!row) return {};
  const data = safeJson(row.data_json);
  const source: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(facts)) {
    if (String(data[key] ?? "").trim()) {
      source[key] = { kind: "position", label: "岗位资料", position_id: Number(row.id) };
    } else if (key === "city" && row.city_name) {
      source[key] = { kind: "city", label: "城市资料", city: String(row.city_name) };
    } else if (key === "factory_name" && row.factory_name) {
      source[key] = { kind: "factory", label: "厂区资料", factory: String(row.factory_name) };
    } else {
      source[key] = { kind: "derived", label: "系统整理" };
    }
  }
  return source;
}

function openingOf(db: DatabaseSync, positionId: number) {
  return db
    .prepare(
      `SELECT * FROM position_opening
        WHERE position_id=? AND status='enabled'
        ORDER BY seq, id`,
    )
    .all(positionId) as OpeningRow[];
}

function personaOf(db: DatabaseSync, positionId: number): string {
  const row = db
    .prepare("SELECT content FROM agent_persona WHERE position_id=? AND status='enabled'")
    .get(positionId) as { content: string } | undefined;
  return String(row?.content ?? "");
}

/** 今天的日期文本（供模型换算「明天/后天」写进 interview.date）。 */
function todayLabel(): string {
  const now = new Date();
  const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()];
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${week}`;
}

/** 输出结构校验：messages 必须是非空数组，每条 type 合法。 */
function normalizeReply(parsed: Record<string, unknown>) {
  const rawMessages = parsed.messages;
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    throw new Error("模型输出缺少 messages 数组");
  }
  const messages = rawMessages.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const type = text(row.type) || "text";
    if (!["text", "image", "video"].includes(type)) {
      throw new Error(`第 ${index + 1} 条消息的 type 不合法：${type}`);
    }
    if (type === "text") {
      const content = text(row.content).trim();
      if (!content) throw new Error(`第 ${index + 1} 条文本消息为空`);
      return { type, content };
    }
    const name = text(row.name).trim();
    if (!name) throw new Error(`第 ${index + 1} 条 ${type} 缺少素材名`);
    return { type, name };
  });

  const capture = parsed.capture && typeof parsed.capture === "object"
    ? (parsed.capture as Record<string, unknown>)
    : {};
  const phone = text(capture.phone).replace(/\D/g, "");
  return {
    messages,
    capture: {
      name: text(capture.name).trim(),
      phone: /^1[3-9]\d{9}$/.test(phone) ? phone : "",
      city: text(capture.city).trim(),
    },
    interview: (parsed.interview && typeof parsed.interview === "object"
      ? (parsed.interview as Record<string, unknown>)
      : {}) as { date?: string; time?: string; confirmed?: boolean },
    handoff: Boolean(parsed.handoff),
    done: Boolean(parsed.done),
  };
}

export async function registerAgentChatRoutes(app: FastifyInstance, db: DatabaseSync) {
  const isAdmin = (request: FastifyRequest) => request.auth?.role === "admin";

  // ── 调试台上下文：人设 / 事实 / 开场 / 拼好的 messages ──────────
  app.get<{ Querystring: { position_id?: string; device_code?: string } }>(
    "/api/v1/agent/context",
    async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const deviceCode = text(request.query.device_code).trim();
      const positionId = int(request.query.position_id) || (deviceCode ? positionOfDevice(db, deviceCode) : 0);
      if (positionId <= 0) return reply.code(422).send({ detail: "position_id or device_code is required" });

      const row = positionRow(db, positionId);
      if (!row) return reply.code(404).send({ detail: "position not found" });
      const facts = buildFacts(db, row);
      const factSources = buildFactSources(row, facts);
      const flow = readFlow(db, positionId);
      const persona = personaOf(db, positionId);
      const opening = openingOf(db, positionId).map((item) => ({
        id: Number(item.id),
        seq: Number(item.seq),
        kind: String(item.kind),
        content: String(item.content ?? ""),
        media_name: String(item.media_name ?? ""),
        delay_ms: Number(item.delay_ms ?? 2000),
      }));

      return {
        position: {
          id: Number(row.id),
          name: String(row.position_name ?? ""),
          factory: String(row.factory_name || ""),
          city: String(row.city_name || ""),
        },
        persona,
        facts,
        knowledge: positionKnowledge(db, positionId, facts),
         fact_sources: factSources,
         flow: {
           status: flow.status,
           version: flow.version,
           entry_key: flow.entry_key,
         },
        opening,
        scripts: parseScripts(persona).map((script) => ({
          id: script.id,
          title: script.title,
          lines: script.content.split(/\n+/).filter(Boolean).length,
        })),
        llm: (() => {
          const { model, key_configured } = agentModelStatus(db);
          return { model, configured: key_configured };
        })(),
      };
    },
  );

  // ── 执行证据：试答/正式会话都从这里回查 ─────────────────────────
  app.get<{
    Querystring: {
      trace_id?: string;
      session_key?: string;
      device_code?: string;
      position_id?: string;
      limit?: string;
    };
  }>("/api/v1/agent/execution-traces", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const items = listExecutionTraces(db, {
      traceId: text(request.query.trace_id).trim(),
      sessionKey: text(request.query.session_key).trim(),
      deviceCode: text(request.query.device_code).trim(),
      positionId: int(request.query.position_id),
      limit: int(request.query.limit) || 50,
    });
    return { items, total: items.length };
  });

  app.post<{ Params: { trace_id: string }; Body: Record<string, unknown> }>(
    "/api/v1/agent/execution-traces/:trace_id/delivery",
    async (request, reply) => {
      if (!isAdmin(request) && !isValidDeviceToken(db, request)) return reply.code(403).send(ADMIN_REQUIRED);
      const traceId = text(request.params.trace_id).trim().slice(0, 120);
      const status = text(request.body?.status).trim();
      if (!traceId || !["sent", "failed", "unknown", "skipped"].includes(status)) {
        return reply.code(422).send({ detail: "trace_id and status(sent/failed/unknown/skipped) are required" });
      }
      const updated = updateExecutionTraceDelivery(db, traceId, {
        status: status as "sent" | "failed" | "unknown" | "skipped",
        messageId: text(request.body?.message_id),
        detail: text(request.body?.detail || request.body?.error),
        deviceCode: text(request.body?.device_code),
        sessionKey: text(request.body?.session_key),
        nodeKey: text(request.body?.node_key),
      });
      if (!updated) return reply.code(404).send({ detail: "Execution trace not found" });
      return { ok: true, trace_id: traceId, delivery_status: status };
    },
  );

  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/execution-traces", async (request, reply) => {
    if (!isAdmin(request) && !isValidDeviceToken(db, request)) return reply.code(403).send(ADMIN_REQUIRED);
    const positionId = int(request.body?.position_id);
    const requestText = text(request.body?.request_text || request.body?.text);
    if (positionId <= 0 || !requestText.trim()) return reply.code(422).send({ detail: "position_id and request_text are required" });
    const row = positionRow(db, positionId);
    if (!row) return reply.code(404).send({ detail: "position not found" });
    const facts = buildFacts(db, row);
    const traceId = writeExecutionTrace(db, {
      traceId: text(request.body?.trace_id).trim() || undefined,
      sessionKey: text(request.body?.session_key),
      deviceCode: text(request.body?.device_code),
      positionId,
      engine: text(request.body?.engine) === "dify" ? "dify" : "agent",
      flowVersion: int(request.body?.flow_version),
      flowStatus: text(request.body?.flow_status),
      stage: text(request.body?.stage),
      nodeKey: text(request.body?.node_key),
      requestText,
      facts,
      factSources: buildFactSources(row, facts),
      status: "received",
    });
    return { ok: true, trace_id: traceId };
  });

  // ── 客户端：开场清单 + 人设 ────────────────────────────────────
  // 鉴权与媒体下载同一套：X-Profile-Token（服务间）或设备 Bearer token。
  app.get<{ Querystring: { device_code?: string; mode?: string } }>(
    "/api/v1/agent/opening",
    async (request, reply) => {
      if (!authorizeProfileRequest(request) && !isValidDeviceToken(db, request)) {
        return reply.code(403).send({ detail: "Not authenticated" });
      }
      const deviceCode = text(request.query.device_code).trim();
      if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
      if (deviceReplyProvider(db, deviceCode) === "dify") {
        if (!ownsReplyDevice(db, request, deviceCode)) return reply.code(403).send(ADMIN_REQUIRED);
        const positionId = positionOfDevice(db, deviceCode);
        return { position_id: positionId, persona: "", items: [], opening_version: openingVersion(positionId, []), provider: "dify", detail: "开场与对话由 Dify 管理" };
      }
      const positionId = positionOfDevice(db, deviceCode);
      if (positionId <= 0) {
        return { position_id: 0, persona: "", items: [], opening_version: openingVersion(0, []), detail: "设备未绑定岗位" };
      }
      const position = positionRow(db, positionId);
      if (position && position.status !== "enabled") {
        return { position_id: positionId, persona: "", items: [], opening_version: openingVersion(positionId, []), detail: "岗位已停用" };
      }
      const items = request.query.mode === "flow" ? firstFlowSegment(db, positionId) : openingOf(db, positionId).map((item) => {
        const kind = String(item.kind);
        const base = {
          seq: Number(item.seq), kind, content: String(item.content ?? ""),
          media_name: String(item.media_name ?? ""), delay_ms: Number(item.delay_ms ?? 2000),
        };
        // 位置卡必须把坐标一起下发，否则客户端只会看到一段 JSON 文本，
        // 生成卡片时判「缺坐标」直接跳过（2026-11-25 实测踩过）。
        return kind === "location" ? { ...base, location: parseOpeningLocation(item.content) } : base;
      });
      return {
        position_id: positionId,
        persona: personaOf(db, positionId),
        items,
        opening_version: openingVersion(positionId, items),
      };
    },
  );

  // ── 客户端：开场逐条回执（失败也记，不驱动流程）──────────────────
  app.post<{ Body: Record<string, unknown> }>(
    "/api/v1/agent/opening/log",
    async (request, reply) => {
      if (!authorizeProfileRequest(request) && !isValidDeviceToken(db, request)) {
        return reply.code(403).send({ detail: "Not authenticated" });
      }
      const body = request.body ?? {};
      const sessionKey = text(body.session_key).trim();
      if (!sessionKey) return reply.code(422).send({ detail: "session_key is required" });
      const status = text(body.status).trim() || "pending";
      if (!["pending", "sent", "failed", "skipped"].includes(status)) {
        return reply.code(422).send({ detail: "status 不合法" });
      }
      db.prepare(
        `INSERT INTO opening_log(session_key, device_code, position_id, seq, kind, status, error, created_at)
         VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      ).run(
        sessionKey.slice(0, 64),
        text(body.device_code).slice(0, 64),
        int(body.position_id),
        int(body.seq),
        text(body.kind).slice(0, 16),
        status,
        text(body.error).slice(0, 500),
      );
      const traceId = writeExecutionTrace(db, {
        sessionKey,
        deviceCode: text(body.device_code).trim(),
        positionId: int(body.position_id),
        engine: "agent",
        stage: `固定开场第 ${int(body.seq)} 条`,
        nodeKey: text(body.node_key).trim(),
        requestText: "",
        status: status === "sent" ? "succeeded" : status === "failed" ? "failed" : "received",
        errorMessage: text(body.error).slice(0, 1000),
        reply: { kind: text(body.kind), seq: int(body.seq), status },
      });
      return { ok: true, trace_id: traceId };
    },
  );

  // ── 面试档案：由模型 JSON 判断结果累积，运营/调试台可查 ──────────
  app.get<{ Querystring: { session_key?: string } }>(
    "/api/v1/agent/archive",
    async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const sessionKey = text(request.query.session_key).trim().slice(0, 120);
      if (!sessionKey) return reply.code(422).send({ detail: "session_key is required" });
      const row = db
        .prepare("SELECT * FROM agent_archive WHERE session_key=?")
        .get(sessionKey) as Record<string, unknown> | undefined;
      if (!row) return { ok: true, archive: null };
      return {
        ok: true,
        archive: {
          session_key: sessionKey,
          position_id: Number(row.position_id),
          name: String(row.name ?? ""),
          phone: String(row.phone ?? ""),
          remark: String(row.remark ?? ""),
          city: String(row.city ?? ""),
          interview_date: String(row.interview_date ?? ""),
          interview_time: String(row.interview_time ?? ""),
          interview_point: String(row.interview_point ?? ""),
          interview_address: String(row.interview_address ?? ""),
          interview_confirmed: Number(row.interview_confirmed) === 1,
          arrival_status: String(row.arrival_status ?? ""),
          updated_at: String(row.updated_at ?? ""),
        },
      };
    },
  );

  // 面试登记清单：运营侧看「时间 / 姓名 / 电话 / 面试时间 / 设备 / 通知状态」。
  // 通知状态从 bridge_commands 实时 join（sent=已推送群聊；queued=待设备发送；
  // failed=推送失败需人工在群里补一句；incomplete/no-group=条件未齐或群聊未配）。
  app.get("/api/v1/agent/archive/list", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const rows = db.prepare(
      `SELECT a.session_key, a.name, a.phone, a.city, a.remark,
              a.interview_date, a.interview_time, a.interview_confirmed,
              a.group_notified, a.arrival_status, a.updated_at,
              c.nickname AS customer_nickname, c.device_code
         FROM agent_archive a
         LEFT JOIN agent_conversations c
           ON c.id=(SELECT cc.id FROM agent_conversations cc WHERE cc.external_conversation_id=a.session_key
             AND (SELECT COUNT(*) FROM agent_conversations same WHERE same.external_conversation_id=a.session_key)=1
             ORDER BY cc.updated_at DESC,cc.id DESC LIMIT 1)
        WHERE a.name != '' OR a.phone != '' OR a.interview_date != ''
        ORDER BY a.updated_at DESC`,
    ).all() as Array<Record<string, unknown>>;
    const notifyStmt = db.prepare(
      "SELECT status FROM bridge_commands WHERE device_code=? AND substr(idempotency_key,1,?)=? ORDER BY created_at DESC LIMIT 1",
    );
    const items: Array<Record<string, unknown>> = [];
    const candidateBySession = new Map(archiveCandidates(db).map(item => [item.session_key,item]));
    for (const row of rows) {
      const sessionKey = String(row.session_key ?? "");
      const shared = candidateBySession.get(sessionKey);
      const deviceCode = shared?.device_code || String(row.device_code ?? "");
      // agent_devices 没有 device_code 列（在 data_json 里），按 JSON 提取匹配
      const devRow = db.prepare(
        "SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?",
      ).get(deviceCode) as { data_json: string } | undefined;
      let groupChat = "";
      try {
        groupChat = String((JSON.parse(devRow?.data_json || "{}") as Record<string, unknown>).group_chat ?? "");
      } catch {
        groupChat = "";
      }
      // 与推送判定保持一致：电话 + 面试时间齐全即算「可推送」，姓名缺失不再阻断。
      const complete = Boolean(row.phone && (row.interview_date || row.interview_time));
      let notifyStatus = !complete ? "incomplete" : !groupChat ? "no-group" : "pending";
      if (sessionKey.startsWith("dify:")) {
        const notice = difyGroupNotificationState(db, deviceCode, sessionKey, groupChat);
        notifyStatus = notice.status;
        groupChat = notice.target;
      } else if (complete && groupChat) {
        // 按前缀取最新一条群通知指令：入队键带毫秒时间戳，而 updated_at 会被
        // 「改备注」这类操作刷新——用完整键匹配会突然查不到，状态退回「待推送」。
        const prefix = `group-notify:${sessionKey}:`;
        const cmd = notifyStmt.get(deviceCode, prefix.length, prefix) as { status: string } | undefined;
        if (cmd) {
          // 指令状态是 sending 语义（succeeded），网页用的是展示语义（sent）：
          // 不归一化时前端映射表没有 succeeded，会显示成「待推送」。
          const raw = String(cmd.status);
          notifyStatus = raw === "succeeded" ? "sent" : raw;
        }
        if (notifyStatus === "pending" && Number(row.group_notified ?? 0)) notifyStatus = "sent";
      }
      items.push({
        session_key: sessionKey,
        customer_nickname: shared?.nickname || String(row.customer_nickname ?? ""),
        device_code: deviceCode,
        group_chat: groupChat,
        name: shared?.name || String(row.name ?? ""),
        phone: shared?.phone || String(row.phone ?? ""),
        remark: String(shared?.remark ?? row.remark ?? ""),
        city: shared?.city || String(row.city ?? ""),
        interview_date: String(row.interview_date ?? ""),
        interview_time: String(row.interview_time ?? ""),
        interview_confirmed: Boolean(row.interview_confirmed),
        interview_point: shared?.interview_point || "",
        interview_address: shared?.interview_address || "",
        arrival_status: String(row.arrival_status ?? ""),
        notify_status: notifyStatus,
        updated_at: String(row.updated_at ?? ""),
        has_conversation: shared?.has_conversation === true,
      });
    }
    return { items };
  });
  // 候选人员管理（2026-11-20）：把面试登记聚合成前端 CandidateView 需要的行。
  // 之前前端明确写着「后端 /api/v1/agent/candidates 返回 404」，页面一直是空壳、
  // 不发起任何请求，所以登记数据和候选页是两套完全不通的东西。
  app.get<{ Querystring: Record<string, string> }>(
    "/api/v1/agent/candidates",
    async (request, reply) => {
      if (request.auth?.role !== "admin") {
        return reply.code(403).send({ detail: "Admin access required" });
      }
      const q = request.query ?? {};
      const status = String(q.status ?? "invited");
      const recruiterFilter = String(q.recruiter_id ?? "").trim();
      const eventDate = String(q.event_date ?? "").trim();
      const interviewDate = String(q.interview_date ?? "").trim();
      const page = Math.max(1, Number(q.page ?? 1) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(q.page_size ?? 50) || 50));

      const all = recruitmentCandidates(db);
      const stats = {
        total: all.length,
        invited: all.filter((item) => item.status === "invited").length,
        disqualified: all.filter((item) => item.status === "disqualified").length,
        checked_in: all.filter((item) => item.status === "checked_in").length,
        communicating: all.filter((item) => item.status === 'communicating').length,
        pending_information: all.filter((item) => item.status === 'pending_information').length,
      };

      const filtered = all.filter((item) => {
        if (status !== 'all' && item.status !== status) return false;
        if (recruiterFilter && item.recruiter_id !== recruiterFilter) return false;
        if (eventDate && !String(item.event_at || '').startsWith(eventDate)) return false;
        if (interviewDate && item.interview_date !== interviewDate) return false;
        return true;
      });

      const start = (page - 1) * pageSize;
      return {
        items: filtered.slice(start, start + pageSize),
        total: filtered.length,
        stats,
      };
    },
  );

  app.get<{Params:{key:string};Querystring:{before_id?:string}}>("/api/v1/agent/candidates/:key/messages",async(request,reply)=>{
    if(request.auth?.role!=='admin') return reply.code(403).send({detail:'Admin access required'});
    const direct = candidateConversation(db,request.params.key);
    if (request.params.key.startsWith('dify:') && !direct) return reply.code(404).send({detail:'这条登记没有关联对话'});
    const archive=db.prepare('SELECT session_key FROM agent_archive WHERE session_key=?').get(request.params.key);
    if(!archive && !direct) return reply.code(404).send({detail:'记录不存在或没有关联对话'});
    const matches=(db.prepare('SELECT COUNT(*) n FROM agent_conversations WHERE external_conversation_id=?').get(request.params.key) as {n:number}).n;
    if(!direct && matches>1) return reply.code(409).send({detail:'此旧登记关联多个设备，需先核对会话，不能自动选择对话记录'});
    const conversation=direct || db.prepare(`SELECT device_code,customer_id,nickname FROM agent_conversations
      WHERE external_conversation_id=? ORDER BY updated_at DESC,id DESC LIMIT 1`).get(request.params.key) as {device_code:string;customer_id:string;nickname:string}|undefined;
    if(!conversation) return reply.code(404).send({detail:'这条登记没有关联对话'});
    const before=Number(request.query.before_id)||Number.MAX_SAFE_INTEGER;
    const items=db.prepare(`SELECT id,direction,content,status,created_at FROM agent_messages
      WHERE device_code=? AND customer_id=? AND id<? ORDER BY id DESC LIMIT 201`).all(conversation.device_code,conversation.customer_id,before);
    return {conversation,items:items.slice(0,200).reverse(),has_more:items.length>200};
  });

  app.post<{ Params: { key: string } }>("/api/v1/agent/archive/:key/followup-summary", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const [record] = archiveCandidates(db, request.params.key);
    if (!record) return reply.code(404).send({ detail: "面试登记不存在" });
    if (!record.has_conversation) {
      return reply.code(409).send({ code: "no_conversation", detail: "暂无可分析的对话" });
    }
    const privateValues = [record.name, record.nickname, record.phone].map(value => value.trim()).filter(value => value.length >= 2);
    const lines = followupChatLines(db, record.device_code, record.customer_id, privateValues);
    if (!lines.some(line => line.direction === "inbound")) {
      return reply.code(409).send({ code: "no_candidate_messages", detail: "还没有可分析的候选人文字消息" });
    }
    const config = environmentModel();
    if (!config.apiKey || !followupModels.has(config.model)) {
      return reply.code(503).send({ detail: "AI 摘要需要配置受支持的非思考模型，请联系管理员" });
    }
    try {
      return await generateFollowupSummary(lines, privateValues);
    } catch {
      return reply.code(502).send({ detail: "AI 摘要生成失败，请重试" });
    }
  });

  // 面试到达状态：运营在面试登记面板把约定时间到了的客户标记「已到达/爽约」。
  app.put<{ Params: { key: string }; Body: Record<string, unknown> }>(
    "/api/v1/agent/archive/:key/arrival",
    async (request, reply) => {
      if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
      const key = request.params.key;
      const status = String((request.body ?? {}).arrival_status ?? "");
      if (!["", "arrived", "noshow"].includes(status)) {
        return reply.code(422).send({ detail: "arrival_status 只能是空 / arrived / noshow" });
      }
      const result = db.prepare(
        "UPDATE agent_archive SET arrival_status=?, updated_at=CURRENT_TIMESTAMP WHERE session_key=?",
      ).run(status, key);
      return result.changes ? { ok: true } : reply.code(404).send({ detail: "登记不存在" });
    },
  );

  // 面试登记备注：群里认人用的那一段（微信名称/介绍人）。
  // 只改文案来源，不重发已经推过的群消息——运营要的是「下次发对」，
  // 反复重发一条已经到群里的登记只会刷屏。
  app.put<{ Params: { key: string }; Body: Record<string, unknown> }>(
    "/api/v1/agent/archive/:key/remark",
    async (request, reply) => {
      if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
      const remark = String((request.body ?? {}).remark ?? "").trim().slice(0, 64);
      const result = db.prepare(
        "UPDATE agent_archive SET remark=?, updated_at=CURRENT_TIMESTAMP WHERE session_key=?",
      ).run(remark, request.params.key);
      return result.changes ? { ok: true, remark } : reply.code(404).send({ detail: "登记不存在" });
    },
  );

  // 手动新建约面试：运营自己约好的客户（没走 Agent 对话）也进登记清单，
  // 同样享受群聊通知。session_key 用 manual: 前缀避免和真实会话混淆。
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/archive/manual", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const body = request.body ?? {};
    const text = (key: string) => String(body[key] ?? "").trim();
    const name = text("name");
    const phone = text("phone");
    const interviewDate = text("interview_date");
    const interviewTime = text("interview_time");
    if (!name || !phone) return reply.code(422).send({ detail: "姓名和电话必填" });
    if (!interviewDate && !interviewTime) return reply.code(422).send({ detail: "面试日期与时间至少填一项" });
    const deviceCode = text("device_code");
    const sessionKey = `manual:${randomUUID()}`;
    const positionId = Number(body.position_id ?? 0) || 0;
    // 备注 = 群里认人用的微信名称；不填就留空，群消息里那一段自动省略。
    const remark = text("remark").slice(0, 64);
    db.prepare(
      `INSERT INTO agent_archive(session_key, position_id, name, phone, city,
         interview_date, interview_time, remark, interview_confirmed, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)`,
    ).run(sessionKey, positionId, name, phone, text("city"), interviewDate, interviewTime, remark);
    if (deviceCode) {
      db.prepare(
        `UPDATE agent_archive SET session_key=? WHERE session_key=?`,
      ).run(`manual:${deviceCode}:${sessionKey}`, sessionKey);
      const groupChat = (() => {
        const devRow = db.prepare(
        "SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?",
      )
          .get(deviceCode) as { data_json: string } | undefined;
        try {
          return String((JSON.parse(devRow?.data_json || "{}") as Record<string, unknown>).group_chat ?? "");
        } catch {
          return "";
        }
      })();
      if (groupChat) {
        const groupExists = db.prepare(
          "SELECT id FROM agent_conversations WHERE device_code=? AND customer_id=? LIMIT 1",
        ).get(deviceCode, groupChat);
        if (!groupExists) {
          db.prepare(
            `INSERT INTO agent_conversations(device_code,customer_id,nickname,state,unread,external_conversation_id,updated_at)
             VALUES (?,?,?,'active',0,?,CURRENT_TIMESTAMP)`,
          ).run(deviceCode, groupChat, groupChat, `group:${groupChat}`);
        } else {
          db.prepare(
            "UPDATE agent_conversations SET nickname=? WHERE device_code=? AND customer_id=? AND nickname<>?",
          ).run(groupChat, deviceCode, groupChat, groupChat);
        }
        const finalKey = `manual:${deviceCode}:${sessionKey}`;
        // 和 Agent 链路同一套一行文案：姓名 微信名称 手机 工厂 岗位 日期 时间 面试点
        const notifyText = buildArchiveNoticeLine(db, {
          name,
          remark,
          nickname: text("customer_nickname"),
          phone,
          positionId,
          interviewDate,
          interviewTime,
          place: text("interview_address"),
        });
        db.prepare(
          `INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,created_at)
           VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
        ).run(randomUUID(), deviceCode, groupChat, groupChat, notifyText, `group-notify:${finalKey}`);
        db.prepare("UPDATE agent_archive SET group_notified=1 WHERE session_key=?").run(finalKey);
      }
    }
    return { ok: true, session_key: deviceCode ? `manual:${deviceCode}:${sessionKey}` : sessionKey };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/faq-media/validate", async (request, reply) => {
    const { device_code, trace_id, session_key, name } = request.body ?? {};
    const deviceCode = text(device_code).trim();
    if (!hasDifyDeviceToken(db, request, deviceCode)) return reply.code(403).send(ADMIN_REQUIRED);
    const trace = readExecutionTrace(db, text(trace_id));
    const stale = () => reply.code(409).send({ detail: "问答素材计划已失效" });
    if (!trace || trace.device_code !== deviceCode || trace.session_key !== session_key || trace.status !== "succeeded" ||
        trace.engine !== deviceReplyProvider(db, deviceCode) || replyModePending(db, deviceCode) ||
        !text(session_key).startsWith("S:") || typeof name !== "string") return stale();
    const blocked = db.prepare("SELECT 1 FROM agent_conversations WHERE device_code=? AND external_conversation_id=? AND (takeover=1 OR recruit_status='disqualified')")
      .get(deviceCode, text(session_key));
    if (blocked) return stale();
    const positionId = Number(trace.position_id);
    const position = positionRow(db, positionId);
    const initial = positionOfDevice(db, deviceCode);
    if (!position || position.status !== "enabled" || (trace.engine === "agent" ? initial !== positionId :
      !recruitmentPositionAvailable(db, deviceCode, initial, positionId, false))) return stale();
    const planned = trace.reply as { faq?: { id?: number }; messages?: Array<{ type?: string; content?: string; name?: string }> };
    if (!planned?.faq?.id || !Array.isArray(planned.messages) ||
        !planned.messages.some(item => item.name === name && (item.type === "image" || item.type === "video"))) return stale();
    const knowledge = trace.engine === "dify" ? difyContext(db, positionId)?.knowledge ?? [] :
      positionKnowledge(db, positionId, buildFacts(db, position));
    const current = faqMediaForQuestion(db, positionId, text(trace.request_text), knowledge);
    if (!current || current.faq_id !== planned.faq.id ||
        normalizeFaqUtterance(current.answer) !== normalizeFaqUtterance(text(planned.messages[0]?.content)) ||
        !current.messages.some(item => "name" in item && item.name === name)) return stale();
    return { ok: true };
  });

  // ── 一轮对话 ──────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/chat", async (request, reply) => {
    // 客户端（设备令牌）与调试台（管理员 JWT）都可调：对话链路的两个调用方
    const body = request.body ?? {};
    const deviceCode = text(body.device_code).trim();
    if (!isAdmin(request) && (!deviceCode || !hasDifyDeviceToken(db, request, deviceCode))) {
      return reply.code(403).send(ADMIN_REQUIRED);
    }
    if (deviceCode && replyModePending(db, deviceCode)) {
      return { ok: false, code: "reply_mode_pending", error: "回复来源正在切换" };
    }
    if (deviceCode && deviceReplyProvider(db, deviceCode) === "dify") {
      const input = text(body.text).trim();
      if (!input || input.length > 2000) return reply.code(422).send({ detail: "text is required (max 2000)" });
      const admin = isAdmin(request);
      return generateDifyReply(db, { deviceCode, positionId: positionOfDevice(db, deviceCode),
        sessionKey: admin && body.dry !== true ? `admin:${request.auth?.id}:${text(body.session_key).trim().slice(0,100)}` : text(body.session_key).trim().slice(0,120),
        text: input, dry: body.dry === true, ordered: body.ordered_reply === true, faqMedia: body.faq_media === true && body.ordered_reply === true,
        turnId: !admin && /^[A-Za-z0-9_-]{1,80}$/.test(text(body.turn_id)) ? text(body.turn_id) : undefined,
        canWriteRegistration: hasDifyDeviceToken(db,request,deviceCode) });
    }
    const requestedPosition = int(body.position_id);
    const positionId = deviceCode ? positionOfDevice(db, deviceCode) : requestedPosition;
    if (deviceCode && requestedPosition && requestedPosition !== positionId) {
      return reply.code(409).send({ detail: "系统 Agent 只能使用该设备绑定的岗位" });
    }
    if (body.preview === true) {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      if (body.session_key || deviceCode) return reply.code(422).send({ detail: '模拟回答不能绑定真实会话或设备' });
    }
    if (positionId <= 0) return reply.code(422).send({ detail: "position_id or device_code is required" });

    const input = text(body.text).trim();
    if (!input) return reply.code(422).send({ detail: "text is required" });
    const sentSummary = Array.isArray(body.sent_summary)
      ? body.sent_summary.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 50)
      : undefined;

    const row = positionRow(db, positionId);
    if (!row) return reply.code(404).send({ detail: "position not found" });
    if (row.status !== "enabled" && body.dry !== true && body.preview !== true) {
      return reply.code(409).send({ detail: "该岗位已停用，不能生成真实回复" });
    }
    const favoriteLocation = isAdmin(request) && (body.dry === true || body.preview === true)
      ? previewFavoriteLocation(input, safeJson(row.data_json).interview_points, row.status === "enabled") : undefined;

    // ── 会话记忆在服务端（2026-11-17）──────────────────────────
    // 传 session_key 时，全量上下文存 agent_session 表，客户端只报
    // 「这个会话来了这句话」，不传历史；不传 session_key 走旧的无状态
    // history 参数（/dev 调试台兼容）。开场序列是岗位配置，每轮现读注入。
    const sessionKey = text(body.session_key).trim().slice(0, 120);
    let sessionEntries: DialogueItem[] = [];
    let sessionReset = false;
    if (sessionKey) {
      const sessionRow = db
        .prepare("SELECT position_id, context_json FROM agent_session WHERE session_key=?")
        .get(sessionKey) as { position_id: number; context_json: string } | undefined;
      if (sessionRow && Number(sessionRow.position_id) !== positionId) {
        // 会话绑到了别的岗位：视为换了业务，上下文清空重来
        sessionReset = true;
      } else if (sessionRow) {
        try {
          const parsed = JSON.parse(sessionRow.context_json) as unknown;
          if (Array.isArray(parsed)) sessionEntries = parsed as DialogueItem[];
        } catch {
          sessionEntries = [];
        }
      }
    }

    const history: DialogueItem[] = sessionKey
      ? sessionEntries
      : Array.isArray(body.history)
        ? (body.history as Array<Record<string, unknown>>)
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              // 无状态模式兼容两种形状：纯文本 {role,text} 或带完整上一轮输出
              // {role, reply:{messages,capture,interview,...}}（/dev 调试台用前者）。
              const reply = (item.reply && typeof item.reply === "object" ? item.reply : null) as
                | DialogueItem["reply"]
                | null;
              return {
                role: text(item.role),
                text: text(item.text),
                reply: reply ?? null,
              };
            })
        : [];

    const persona = personaOf(db, positionId);
    const facts = buildFacts(db, row);
    const factSources = buildFactSources(row, facts);
    const flow = readFlow(db, positionId);
    // 今天的日期给模型：interview.date 的「明天/后天」由它换算成具体几月几号
    const nowLabel = todayLabel();
    const opening: OpeningItem[] = openingOf(db, positionId).map((item) => ({
      kind: String(item.kind ?? "text"),
      content: String(item.content ?? ""),
      media_name: String(item.media_name ?? ""),
    }));
    // 编排：system(人设+今天日期+事实+话术库+规则) + 开场序列 + 全量历史 + 当前这句
    // （DeepSeek 无状态多轮拼接；上下文归服务端持有）
    const knowledge = positionKnowledge(db, positionId, facts);
    const faqMatch = (body.faq_media === true && body.ordered_reply === true) || body.preview === true || body.dry === true
      ? faqMediaForQuestion(db, positionId, input, knowledge) : undefined;
    const { messages, scripts } = buildOrchestration({ persona, facts, opening, now: nowLabel, history, input, sentSummary, knowledge, mediaFaqAnswer: faqMatch?.answer });
    const traceId = newExecutionTraceId();
    const traceBase = {
      traceId, sessionKey, deviceCode, positionId, engine: "agent" as const,
      flowVersion: Number(flow.version || 0), flowStatus: String(flow.status || ""),
      stage: flow.status === "enabled" ? "等待客户端上报实际节点" : "旧开场/人设对话",
      requestText: input, facts, factSources,
      scripts: scripts.map((script) => ({ id: script.id, title: script.title })),
    };
    const evidence = {
      trace_id: traceId, engine: "agent", position_id: positionId, session_key: sessionKey || null,
      flow: { status: flow.status, version: flow.version, entry_key: flow.entry_key, stage: traceBase.stage },
      facts, fact_sources: factSources,
      scripts: scripts.map((script) => ({ id: script.id, title: script.title })),
    };
    const saveTrace = (status: "received" | "dry_run" | "succeeded" | "failed", extra: Record<string, unknown> = {}) =>
      writeExecutionTrace(db, {
        ...traceBase, status,
        errorCode: typeof extra.code === "string" ? extra.code : "",
        errorMessage: typeof extra.error === "string" ? extra.error : "",
        model: typeof extra.model === "string" ? extra.model : "",
        usage: extra.usage && typeof extra.usage === "object" ? extra.usage as Record<string, unknown> : {},
        latencyMs: Number(extra.latency_ms || 0),
        reply: extra.reply && typeof extra.reply === "object" ? extra.reply as Record<string, unknown> : {},
      });

    // dry：只回拼好的 prompt，不调模型、不写会话。调试台用它确认
    // 「人设 + 事实 + 话术库 + 开场 + 历史」有没有喂对。
    if (body.dry === true) {
      saveTrace("dry_run");
      return {
        ok: true,
        dry: true,
        knowledge,
        trace_id: traceId,
        evidence,
        session_key: sessionKey || null,
        messages,
        facts,
        persona,
        position_id: positionId,
        ...(faqMatch && { faq_media_candidate: { id: faqMatch.faq_id, question: faqMatch.question } }),
        ...(favoriteLocation && { favorite_location_preview: favoriteLocation }),
        scripts: scripts.map((script) => ({ id: script.id, title: script.title })),
      };
    }

    try {
      const result = await complete(messages, {}, activeAgentModel(db));
      if (deviceCode && (replyModePending(db, deviceCode) || deviceReplyProvider(db, deviceCode) !== "agent"
        || positionOfDevice(db, deviceCode) !== positionId || positionRow(db, positionId)?.status !== "enabled")) {
        const error = "接待岗位或回复来源已变化，请重新生成回复";
        saveTrace("failed", { code: "agent_binding_changed", error });
        return { ok: false, code: "agent_binding_changed", error, trace_id: traceId, evidence };
      }
      // JSON 解析失败单独一档：带着耗时与 token 返回，调试台能看到
      // 「模型花了多少毫秒、烧了多少 token 才吐出这段不合格的输出」。
      let parsed: Record<string, unknown>;
      try {
        parsed = parseJsonObject(result.content);
      } catch (error) {
        saveTrace("failed", {
          code: "bad_json",
          error: (error as Error).message,
          model: result.model,
          usage: result.usage,
          latency_ms: result.latency_ms,
        });
        return {
          ok: false,
          trace_id: traceId,
          evidence,
          error: (error as Error).message,
          code: "bad_json",
          raw: result.content,
          model: result.model,
          usage: result.usage,
          latency_ms: result.latency_ms,
        };
      }
      let replyPayload: ReturnType<typeof normalizeReply>;
      try {
        replyPayload = normalizeReply(parsed);
      } catch (error) {
        saveTrace("failed", {
          code: "invalid_reply",
          error: (error as Error).message,
          model: result.model,
          latency_ms: result.latency_ms,
        });
        return {
          ok: false,
          trace_id: traceId,
          evidence,
          error: (error as Error).message,
          raw: result.content,
          model: result.model,
          latency_ms: result.latency_ms,
        };
      }

      // 媒体名兜底 + 串岗防线（2026-11-17 模拟实测抓到两类问题）：
      // ① 模型偶尔会把事实卡字段名「interview_address_image」本身当成
      //    图片文件名输出——命中事实卡媒体字段 → 替换成字段值（真实文件名）
      // ② 模型可能输出不属于本岗位的媒体名（通用池之外的）——直接剥掉，
      //    绝不把广州的地点图发给深圳的客户。可发集合 = 通用池 ∪ 本岗位绑定
      {
        const allowed = new Set(
          (
            db
              .prepare(
                "SELECT name FROM media_assets WHERE status='enabled' AND (position_id=0 OR position_id=?)",
              )
              .all(positionId) as Array<{ name: string }>
          ).map((row) => row.name),
        );
        const resolved: typeof replyPayload.messages = [];
        for (const message of replyPayload.messages) {
          if (message.type !== "image" && message.type !== "video") {
            resolved.push(message);
            continue;
          }
          const key = String(message.name ?? "").trim();
          if (!key) continue;
          const value = facts[key];
          const name = value && value !== key ? value : key;
          if (!allowed.has(name)) continue;
          message.name = name;
          resolved.push(message);
        }
        replyPayload.messages = resolved;
      }

      // 客户问定位/导航且有面试点坐标 → 交给客户端发原生位置卡（能点开导航）。
      // 只有拿不到卡（面试点没坐标）才退回高德链接。
      const locationCard = buildLocationCard(input, safeJson(row.data_json));
      if (!locationCard) {
        const mapLink = buildMapLink(input, safeJson(row.data_json));
        if (mapLink) {
          const firstText = replyPayload.messages.find(
            (m): m is { type: string; content: string } =>
              !!m && typeof m === "object" && (m as Record<string, unknown>).type === "text"
              && typeof (m as Record<string, unknown>).content === "string",
          );
          if (firstText) firstText.content = `${firstText.content}\n${mapLink}`;
        }
      }

      const currentFaq = faqMatch && faqMediaForQuestion(db, positionId, input,
        positionKnowledge(db, positionId, buildFacts(db, positionRow(db, positionId))));
      const faqEvidence = faqMatch && currentFaq && JSON.stringify(currentFaq) === JSON.stringify(faqMatch)
        && !locationCard && !replyPayload.handoff && !replyPayload.done
        && !Object.values(replyPayload.capture).some(Boolean) && !Object.values(replyPayload.interview).some(Boolean)
        && replyPayload.messages.filter(item => item.type === "text").length === 1
        && replyPayload.messages[0]?.type === "text"
        && normalizeFaqUtterance(replyPayload.messages[0].content || "") === normalizeFaqUtterance(faqMatch.answer)
        ? { id: faqMatch.faq_id, question: faqMatch.question } : undefined;
      const planned = faqEvidence && faqMatch
        ? { messages: [...replyPayload.messages.flatMap(item => item.type === "text" ? [{ type: "text" as const, content: item.content || "" }] : []), ...faqMatch.messages.slice(1)],
            faq: faqEvidence }
        : undefined;
      const orderedReply = planned && { ...replyPayload, ...planned, delays_before_ms: difySendDelays(planned.messages) };

      if (body.preview === true) return {
        ok: true, preview: true, reply: orderedReply || replyPayload, facts, knowledge,
        model: result.model, usage: result.usage, latency_ms: result.latency_ms,
        ...(locationCard && { location_card: locationCard }),
        ...(favoriteLocation && { favorite_location_preview: favoriteLocation }),
      };

      // 信任模式：不做代码级护栏，模型按 prompt 约束引用话术原文（2026-11-17）。
      // 会话成功才有记忆：客户这句 + 模型完整 JSON 输出（messages/capture/
      // interview）落进 agent_session——历史信封要装完整结构，模型才不会把
      // capture/interview 字段丢掉。失败不写：客户端重试不会造成上下文重复。
      if (sessionKey) {
        const nextEntries: DialogueItem[] = sessionReset ? [] : [...sessionEntries];
        nextEntries.push({ role: "customer", text: input });
        nextEntries.push({
          role: "agent",
          reply: {
            messages: replyPayload.messages,
            capture: replyPayload.capture,
            interview: replyPayload.interview,
            handoff: replyPayload.handoff,
            done: replyPayload.done,
          },
        });
        db.prepare(
          `INSERT INTO agent_session(session_key, position_id, context_json, updated_at)
           VALUES (?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(session_key) DO UPDATE SET
             context_json=excluded.context_json, updated_at=CURRENT_TIMESTAMP`,
        ).run(sessionKey, positionId, JSON.stringify(nextEntries));
      }
      // 档案：模型 JSON（capture + interview）判断结果合并写入，
      // 系统不做任何硬提取；改时间/改资料时新值覆盖旧值。
      const archiveRow = sessionKey
        ? (db
            .prepare("SELECT * FROM agent_archive WHERE session_key=?")
            .get(sessionKey) as (ArchiveRecord & { position_id: number; remark?: string; interview_point?: string; interview_address?: string }) | undefined)
        : undefined;
      const archive = sessionKey
        ? mergeArchive(archiveRow ?? null, replyPayload.capture, replyPayload.interview)
        : null;
      // 模型漏填姓名时按客户原话兜底一次：姓名是推群的硬条件之一，
      // 一直空着就永远卡在「信息未齐」（2026-11-20 线上 3 条登记全卡在这里）。
      if (archive && !archive.name) {
        archive.name = guessCustomerName(input);
      }
      if (sessionKey && archive) {
        db.prepare(
          `INSERT INTO agent_archive(session_key, position_id, name, phone, city,
             interview_date, interview_time, interview_confirmed, updated_at)
           VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(session_key) DO UPDATE SET
             name=excluded.name, phone=excluded.phone, city=excluded.city,
             interview_date=excluded.interview_date, interview_time=excluded.interview_time,
             interview_confirmed=excluded.interview_confirmed, updated_at=CURRENT_TIMESTAMP`,
        ).run(
          sessionKey,
          positionId,
          archive.name,
          archive.phone,
          archive.city,
          archive.interview_date,
          archive.interview_time,
          archive.interview_confirmed ? 1 : 0,
        );
        // 群聊通知：档案里姓名/电话/面试时间齐全且尚未通知时，把「时间+姓名+电话」
        // 推送到设备绑定的群聊（agent_devices.data_json.group_chat，设备页可配）。
        // 群聊名没配就保留 group_notified=0——配好群聊后下一轮对话自动补推。
        // 设备端按 agent_conversations.nickname 搜索会话发送，群聊也占一行记录。
        // 姓名缺失不再阻断推群：电话 + 面试时间是硬条件，姓名用「（待补）」占位。
        // 之前要求 name 非空，模型漏填一次就永久卡住（2026-11-20 实测 3 条姓名全空）。
        const archiveComplete = Boolean(
          archive.phone && (archive.interview_date || archive.interview_time),
        );
        const notifiedRow = db
          .prepare("SELECT group_notified FROM agent_archive WHERE session_key=?")
          .get(sessionKey) as { group_notified: number } | undefined;
        if (archiveComplete && notifiedRow && !notifiedRow.group_notified) {
          const convRow = db
            .prepare(
              "SELECT device_code, nickname FROM agent_conversations WHERE external_conversation_id=? ORDER BY updated_at DESC LIMIT 1",
            )
            .get(sessionKey) as { device_code: string; nickname: string } | undefined;
          if (convRow) {
            const devRow = db
              .prepare(
          "SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?",
        )
              .get(convRow.device_code) as { data_json: string } | undefined;
            let devData: Record<string, unknown> = {};
            try {
              devData = JSON.parse(devRow?.data_json || "{}") as Record<string, unknown>;
            } catch {
              devData = {};
            }
            const groupChat = String(devData.group_chat ?? "").trim();
            if (groupChat) {
              const groupExists = db
                .prepare(
                  "SELECT id FROM agent_conversations WHERE device_code=? AND customer_id=? LIMIT 1",
                )
                .get(convRow.device_code, groupChat);
              if (!groupExists) {
                // nickname 必须是真实群名：客户端是拿 nickname 去企微搜索框里找会话的，
                // 早先写死成「群聊」会搜不到，发送被「不在企微会话列表」拦掉
                // （2026-11-25 实测：面试信息采集成功，群通知发不出去）。
                db.prepare(
                  `INSERT INTO agent_conversations(device_code,customer_id,nickname,state,unread,external_conversation_id,updated_at)
                   VALUES (?,?,?,'active',0,?,CURRENT_TIMESTAMP)`,
                ).run(convRow.device_code, groupChat, groupChat, `group:${groupChat}`);
              } else {
                // 历史行 nickname 是「群聊」，顺手纠正过来
                db.prepare(
                  "UPDATE agent_conversations SET nickname=? WHERE device_code=? AND customer_id=? AND nickname<>?",
                ).run(groupChat, convRow.device_code, groupChat, groupChat);
              }
              // 群通知：一条消息、一行字。姓名后面紧跟微信名称（备注优先，
              // 其次是客户企微昵称），再是手机、工厂、岗位、日期、时间、面试点。
              const notifyText = buildArchiveNoticeLine(db, {
                name: archive.name,
                remark: String(archiveRow?.remark ?? ""),
                nickname: convRow.nickname,
                phone: archive.phone,
                positionId,
                interviewDate: archive.interview_date,
                interviewTime: archive.interview_time,
                place: String(archiveRow?.interview_address || archiveRow?.interview_point || ""),
              });
              db.prepare(
                `INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,created_at)
                 VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
              ).run(
                randomUUID(),
                convRow.device_code,
                groupChat,
                groupChat,
                notifyText,
                `group-notify:${sessionKey}:${new Date().toISOString()}`,
              );
              db.prepare("UPDATE agent_archive SET group_notified=1 WHERE session_key=?").run(sessionKey);
            }
          }
        }
      }

      saveTrace("succeeded", {
        model: result.model,
        usage: result.usage,
        latency_ms: result.latency_ms,
        reply: orderedReply || replyPayload,
      });
      return {
        ok: true,
        trace_id: traceId,
        evidence,
        session_key: sessionKey || null,
        reply: orderedReply || replyPayload,
        archive: archive,
        raw: result.content,
        model: result.model,
        usage: result.usage,
        latency_ms: result.latency_ms,
        scripts: scripts.map((script) => script.id + " " + script.title),
        messages,
        ...(locationCard && { location_card: locationCard }),
      };
    } catch (error) {
      const failure = error as Error & { code?: string };
      saveTrace("failed", { code: failure.code || "agent_error", error: failure.message });
      return {
        ok: false,
        trace_id: traceId,
        evidence,
        error: failure.message,
        code: failure.code || "",
        messages,
        scripts: scripts.map((script) => script.id + " " + script.title),
      };
    }
  });
}

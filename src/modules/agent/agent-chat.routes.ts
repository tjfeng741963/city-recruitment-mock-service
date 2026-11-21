import { archiveCandidates } from './archive-candidates.js';
import { recruitmentCandidates, candidateConversation } from './recruitment-candidates.js';
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { authorizeProfileRequest } from "./profile.routes.js";
import { isValidDeviceToken } from "./position-scripts.routes.js";
import { firstFlowSegment } from "./agent-flow.routes.js";
import { complete, llmConfig, parseJsonObject } from "./agent-llm.js";
import { deviceReplyProvider, generateDifyReply, ownsReplyDevice } from "../dify/dify-reply.js";
import { normalizePositionFacts } from "../../shared/position-facts.js";
import { positionKnowledge } from './position-knowledge.js';
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
        opening,
        scripts: parseScripts(persona).map((script) => ({
          id: script.id,
          title: script.title,
          lines: script.content.split(/\n+/).filter(Boolean).length,
        })),
        llm: { model: llmConfig().model, configured: Boolean(llmConfig().apiKey) },
      };
    },
  );

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
        return { position_id: positionOfDevice(db, deviceCode), persona: "", items: [], provider: "dify", detail: "开场与对话由 Dify 管理" };
      }
      const positionId = positionOfDevice(db, deviceCode);
      if (positionId <= 0) {
        return { position_id: 0, persona: "", items: [], detail: "设备未绑定岗位" };
      }
      const position = positionRow(db, positionId);
      if (position && position.status !== "enabled") {
        return { position_id: positionId, persona: "", items: [], detail: "岗位已停用" };
      }
      return {
        position_id: positionId,
        persona: personaOf(db, positionId),
        items: request.query.mode === "flow" ? firstFlowSegment(db, positionId) : openingOf(db, positionId).map((item) => ({
          seq: Number(item.seq),
          kind: String(item.kind),
          content: String(item.content ?? ""),
          media_name: String(item.media_name ?? ""),
          delay_ms: Number(item.delay_ms ?? 2000),
        })),
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
      return { ok: true };
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
          city: String(row.city ?? ""),
          interview_date: String(row.interview_date ?? ""),
          interview_time: String(row.interview_time ?? ""),
          interview_confirmed: Number(row.interview_confirmed) === 1,
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
      `SELECT a.session_key, a.name, a.phone, a.city,
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
      "SELECT status FROM bridge_commands WHERE idempotency_key=? ORDER BY created_at DESC LIMIT 1",
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
      if (complete && groupChat) {
        const stampCandidates = [
          `group-notify:${sessionKey}:${String(row.updated_at ?? "")}`,
          `group-notify:${sessionKey}:${new Date(String(row.updated_at ?? "")).toISOString()}`,
        ];
        for (const key of stampCandidates) {
          const cmd = notifyStmt.get(key) as { status: string } | undefined;
          if (cmd) {
            notifyStatus = String(cmd.status);
            break;
          }
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
        city: shared?.city || String(row.city ?? ""),
        interview_date: String(row.interview_date ?? ""),
        interview_time: String(row.interview_time ?? ""),
        interview_confirmed: Boolean(row.interview_confirmed),
        arrival_status: String(row.arrival_status ?? ""),
        notify_status: notifyStatus,
        updated_at: String(row.updated_at ?? ""),
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

  // 面试到达状态：运营在面试登记面板把约定时间到了的客户标记「已到达/爽约」。
  app.get<{Params:{key:string};Querystring:{before_id?:string}}>("/api/v1/agent/candidates/:key/messages",async(request,reply)=>{
    if(request.auth?.role!=='admin') return reply.code(403).send({detail:'Admin access required'});
    const direct = candidateConversation(db,request.params.key);
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
    db.prepare(
      `INSERT INTO agent_archive(session_key, position_id, name, phone, city,
         interview_date, interview_time, interview_confirmed, updated_at)
       VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)`,
    ).run(sessionKey, Number(body.position_id ?? 0) || 0, name, phone, text("city"), interviewDate, interviewTime);
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
             VALUES (?,?,'群聊','active',0,?,CURRENT_TIMESTAMP)`,
          ).run(deviceCode, groupChat, `group:${groupChat}`);
        }
        const finalKey = `manual:${deviceCode}:${sessionKey}`;
        const notifyText = [
          "【面试登记】",
          `时间：${interviewDate} ${interviewTime}`.trimEnd(),
          `姓名：${name}`,
          `电话：${phone}`,
          `客户：${text("customer_nickname") || name}`,
          `设备：${deviceCode}`,
        ].join("\n");
        db.prepare(
          `INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,created_at)
           VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
        ).run(randomUUID(), deviceCode, groupChat, groupChat, notifyText, `group-notify:${finalKey}`);
        db.prepare("UPDATE agent_archive SET group_notified=1 WHERE session_key=?").run(finalKey);
      }
    }
    return { ok: true, session_key: deviceCode ? `manual:${deviceCode}:${sessionKey}` : sessionKey };
  });

  // ── 一轮对话 ──────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/chat", async (request, reply) => {
    // 客户端（设备令牌）与调试台（管理员 JWT）都可调：对话链路的两个调用方
    if (!isAdmin(request) && !isValidDeviceToken(db, request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const deviceCode = text(body.device_code).trim();
    if (deviceCode && deviceReplyProvider(db, deviceCode) === "dify") {
      if (!ownsReplyDevice(db, request, deviceCode)) return reply.code(403).send(ADMIN_REQUIRED);
      const input = text(body.text).trim();
      if (!input || input.length > 2000) return reply.code(422).send({ detail: "text is required (max 2000)" });
      return generateDifyReply(db, { deviceCode, positionId: positionOfDevice(db, deviceCode), sessionKey: text(body.session_key).trim().slice(0,120), text: input, dry: body.dry === true });
    }
    const positionId = int(body.position_id) || (deviceCode ? positionOfDevice(db, deviceCode) : 0);
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
    const { messages, scripts } = buildOrchestration({ persona, facts, opening, now: nowLabel, history, input, sentSummary, knowledge });

    // dry：只回拼好的 prompt，不调模型、不写会话。调试台用它确认
    // 「人设 + 事实 + 话术库 + 开场 + 历史」有没有喂对。
    if (body.dry === true) {
      return {
        ok: true,
        dry: true,
        knowledge,
        session_key: sessionKey || null,
        messages,
        facts,
        persona,
        position_id: positionId,
        scripts: scripts.map((script) => ({ id: script.id, title: script.title })),
      };
    }

    try {
      const result = await complete(messages);
      // JSON 解析失败单独一档：带着耗时与 token 返回，调试台能看到
      // 「模型花了多少毫秒、烧了多少 token 才吐出这段不合格的输出」。
      let parsed: Record<string, unknown>;
      try {
        parsed = parseJsonObject(result.content);
      } catch (error) {
        return {
          ok: false,
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
        return {
          ok: false,
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

      if (body.preview === true) return {
        ok: true, preview: true, reply: replyPayload, facts, knowledge,
        model: result.model, usage: result.usage, latency_ms: result.latency_ms,
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
            .get(sessionKey) as (ArchiveRecord & { position_id: number }) | undefined)
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
                db.prepare(
                  `INSERT INTO agent_conversations(device_code,customer_id,nickname,state,unread,external_conversation_id,updated_at)
                   VALUES (?,?,'群聊','active',0,?,CURRENT_TIMESTAMP)`,
                ).run(convRow.device_code, groupChat, `group:${groupChat}`);
              }
              const notifyText = [
                "【面试登记】",
                `时间：${archive.interview_date || ""} ${archive.interview_time || ""}`.trimEnd(),
                `姓名：${archive.name || "（待补）"}`,
                `电话：${archive.phone}`,
                `客户：${convRow.nickname}`,
                `设备：${convRow.device_code}`,
              ].join("\n");
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

      return {
        ok: true,
        session_key: sessionKey || null,
        reply: replyPayload,
        archive: archive,
        raw: result.content,
        model: result.model,
        usage: result.usage,
        latency_ms: result.latency_ms,
        scripts: scripts.map((script) => script.id + " " + script.title),
        messages,
      };
    } catch (error) {
      const failure = error as Error & { code?: string };
      return {
        ok: false,
        error: failure.message,
        code: failure.code || "",
        messages,
        scripts: scripts.map((script) => script.id + " " + script.title),
      };
    }
  });
}

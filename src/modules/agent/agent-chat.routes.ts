import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { authorizeProfileRequest } from "./profile.routes.js";
import { isValidDeviceToken } from "./position-scripts.routes.js";
import { complete, llmConfig, parseJsonObject } from "./agent-llm.js";
import { buildOrchestration, guardMoney, guardScript, parseScripts } from "./agent-orchestrator.js";

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
      `SELECT p.id, p.position_name, p.data_json,
              f.factory_name AS factory_name, c.city_name AS city_name
         FROM service_positions p
         LEFT JOIN factories f ON f.id = p.factory_id
         LEFT JOIN cities c ON c.id = COALESCE(p.city_id, f.city_id)
        WHERE p.id = ?`,
    )
    .get(positionId) as PositionRow | undefined;
}

/** 设备 → 岗位。设备绑定在 agent_devices.data_json.position_id。 */
function positionOfDevice(db: DatabaseSync, deviceCode: string): number {
  const row = db
    .prepare(
      `SELECT json_extract(data_json,'$.position_id') AS position_id
         FROM agent_devices
        WHERE json_extract(data_json,'$.device_code')=? AND status='enabled'`,
    )
    .get(deviceCode) as { position_id: number | null } | undefined;
  return Number(row?.position_id ?? 0);
}

function buildFacts(row: PositionRow | undefined): Record<string, string> {
  if (!row) return {};
  const data = safeJson(row.data_json);
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
    height_text: text(data.height_text),
    tattoo_policy: text(data.tattoo_policy),
    cert_text: text(data.cert_text),
    job_content: text(data.job_content),
  };
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
      day: text(capture.day).trim(),
    },
    handoff: Boolean(parsed.handoff),
    done: Boolean(parsed.done),
    script_used: typeof parsed.script_used === "string" ? parsed.script_used : null,
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
      const facts = buildFacts(row);
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
  app.get<{ Querystring: { device_code?: string } }>(
    "/api/v1/agent/opening",
    async (request, reply) => {
      if (!authorizeProfileRequest(request) && !isValidDeviceToken(db, request)) {
        return reply.code(403).send({ detail: "Not authenticated" });
      }
      const deviceCode = text(request.query.device_code).trim();
      if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
      const positionId = positionOfDevice(db, deviceCode);
      if (positionId <= 0) {
        return { position_id: 0, persona: "", items: [], detail: "设备未绑定岗位" };
      }
      return {
        position_id: positionId,
        persona: personaOf(db, positionId),
        items: openingOf(db, positionId).map((item) => ({
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

  // ── 一轮对话 ──────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/chat", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const deviceCode = text(body.device_code).trim();
    const positionId = int(body.position_id) || (deviceCode ? positionOfDevice(db, deviceCode) : 0);
    if (positionId <= 0) return reply.code(422).send({ detail: "position_id or device_code is required" });

    const input = text(body.text).trim();
    if (!input) return reply.code(422).send({ detail: "text is required" });

    const row = positionRow(db, positionId);
    if (!row) return reply.code(404).send({ detail: "position not found" });

    const history = Array.isArray(body.history)
      ? (body.history as Array<Record<string, unknown>>)
          .filter((item) => item && typeof item === "object")
          .map((item) => ({ role: text(item.role), text: text(item.text) }))
      : [];
    const persona = personaOf(db, positionId);
    const facts = buildFacts(row);
    // 编排：system(人设+事实+话术库+规则) + 全量历史 + 当前这句（DeepSeek 无状态多轮拼接）
    const { messages, scripts } = buildOrchestration({ persona, facts, history, input });

    // dry：只回拼好的 prompt，不调模型。调试台用它确认「人设 + 事实 + 话术库」有没有喂对。
    if (body.dry === true) {
      return {
        ok: true,
        dry: true,
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

      // 话术护栏：模型说用了某类话术但输出跑偏 → 整条替换回运营原文
      const scriptGuard = guardScript(replyPayload.messages, (parsed as Record<string, unknown>).script_used, scripts);
      replyPayload.messages = scriptGuard.messages;

      // 金额护栏：事实卡 + 话术库原文都是可信数字来源（原文是运营写的，
      // 模型逐字引用原文里的「175/班」不算编造）；两头都没有的数字才拦。
      const moneyIssue = guardMoney(
        replyPayload.messages,
        facts,
        scripts.map((script) => script.content).join("\n"),
      );
      return {
        ok: !moneyIssue,
        error: moneyIssue || undefined,
        reply: replyPayload,
        raw: result.content,
        model: result.model,
        usage: result.usage,
        latency_ms: result.latency_ms,
        script_used: typeof (parsed as Record<string, unknown>).script_used === "string"
          ? (parsed as Record<string, unknown>).script_used
          : null,
        script_replaced: scriptGuard.replaced,
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

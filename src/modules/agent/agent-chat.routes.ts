import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { complete, llmConfig, parseJsonObject, type ChatMessage } from "./agent-llm.js";

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

/** 事实卡里允许出现的键。顺序即 prompt 里的展示顺序。 */
const FACT_LABELS: Array<[string, string]> = [
  ["city", "城市"],
  ["factory_name", "厂名"],
  ["job_title", "岗位"],
  ["wage_text", "工价"],
  ["hours_text", "班次"],
  ["age_text", "年龄要求"],
  ["welfare_text", "吃住"],
  ["place", "面试地点"],
  ["interview_time", "面试时间"],
];

const OUTPUT_SPEC = `# 输出格式（必须是 JSON，不要代码块，不要解释）
{"messages":[{"type":"text","content":"发给客户的一句话"}],"capture":{"name":"","phone":"","city":"","day":""},"handoff":false,"done":false}

# 硬规则
- 只能使用上面「岗位事实」里的数字，事实里没有的工价/年龄/费用一个字都不许说
- 不确定的事说「这个我确认一下」，不要编
- 需要发图片或视频时，type 填 image / video，name 填素材文件名；没有素材就不要输出
- 客户明确说不来了 → handoff=false、done=true，回一句客气收尾
- 姓名只填客户明确说出的 2-4 个汉字；手机号必须 11 位，没给就留空串`;

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
  };
  // 空值不出现：prompt 里「工价：」后面空着比不写更容易让模型以为「没有限制」
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => String(value || "").trim()),
  );
}

function factsText(facts: Record<string, string>): string {
  const lines = FACT_LABELS.filter(([key]) => facts[key]).map(
    ([key, label]) => `- ${label}：${facts[key]}`,
  );
  return lines.length ? lines.join("\n") : "（这个岗位还没有填事实，任何数字都不要说）";
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

/** 组装这一轮的完整 messages：system(人设 + 事实 + 输出格式) + 历史 + 当前这句。 */
function buildMessages(
  persona: string,
  facts: Record<string, string>,
  history: Array<{ role: string; text: string }>,
  input: string,
): ChatMessage[] {
  const system = [
    persona.trim() || "你是一家劳务中介的招聘顾问。",
    "",
    "# 岗位事实（这一轮唯一允许使用的数字来源）",
    factsText(facts),
    "",
    OUTPUT_SPEC,
  ].join("\n");

  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const item of history) {
    const content = text(item.text).trim();
    if (!content) continue;
    messages.push({
      role: String(item.role) === "agent" ? "assistant" : "user",
      content,
    });
  }
  messages.push({ role: "user", content: input });
  return messages;
}

/** 金额护栏：回复里出现的钱数必须能在事实里找到，否则整条判失败。 */
function checkMoney(messages: unknown, facts: Record<string, string>): string | null {
  const chunks: string[] = [];
  if (Array.isArray(messages)) {
    for (const item of messages) {
      if (item && typeof item === "object" && text((item as { type?: string }).type) === "text") {
        chunks.push(text((item as { content?: string }).content));
      }
    }
  }
  const prose = chunks.join("\n");
  const allowed = Object.values(facts).join(" ").replace(/\s+/g, "");
  const patterns = [/(\d+(?:\.\d+)?)\s*元/g, /(\d+(?:\.\d+)?)\s*\/\s*(?:小时|时|天|月|班)/g];
  for (const pattern of patterns) {
    let match = pattern.exec(prose);
    while (match) {
      const number = match[1];
      if (!allowed.includes(number)) {
        return `回复里的「${match[0]}」不在岗位事实里`;
      }
      match = pattern.exec(prose);
    }
  }
  return null;
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
        llm: { model: llmConfig().model, configured: Boolean(llmConfig().apiKey) },
      };
    },
  );

  // ── 客户端：开场清单 + 人设 ────────────────────────────────────
  app.get<{ Querystring: { device_code?: string } }>(
    "/api/v1/agent/opening",
    async (request, reply) => {
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
    const messages = buildMessages(persona, facts, history, input);

    // dry：只回拼好的 prompt，不调模型。调试台用它确认「人设 + 事实」有没有喂对。
    if (body.dry === true) {
      return { ok: true, dry: true, messages, facts, persona, position_id: positionId };
    }

    try {
      const result = await complete(messages);
      const parsed = parseJsonObject(result.content);
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

      const moneyIssue = checkMoney(replyPayload.messages, facts);
      return {
        ok: !moneyIssue,
        error: moneyIssue || undefined,
        reply: replyPayload,
        raw: result.content,
        model: result.model,
        usage: result.usage,
        latency_ms: result.latency_ms,
        messages,
      };
    } catch (error) {
      const failure = error as Error & { code?: string };
      return {
        ok: false,
        error: failure.message,
        code: failure.code || "",
        messages,
      };
    }
  });
}

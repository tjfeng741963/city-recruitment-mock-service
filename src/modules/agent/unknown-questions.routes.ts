import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { canAccessRecruiter, getUserScope } from "../../auth/user-scopes.js";
import { authorizeProfileRequest } from "./profile.routes.js";

/**
 * 未知问题（知识库没答上来的原话）。
 *
 * 三条链路：
 * 1. 8090 的对话流程未命中知识库 → POST /api/v1/agent/unknown-questions
 *    （服务间调用，X-Profile-Token；同一句问法按 question 归一化后累加 occurrence_count）
 * 2. 知识库页列表 → GET /api/v1/unknown-questions（列表/筛选在 resource.routes 里）
 * 3. 运营点「已处理」→ POST /api/v1/unknown-questions/:id/resolve
 *
 * 本期只做占位：不接 LLM 生成回答，也不做自动合并相似问法。
 */

/** 归一化：折叠空白、去掉结尾标点。「体检要花钱吗？」和「体检要花钱吗」算一条。 */
export function normalizeQuestion(text: unknown): string {
  const raw = typeof text === "string" ? text : "";
  return raw.replace(/\s+/g, " ").trim().replace(/[?？。.!！~ ]+$/u, "");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

interface UnknownQuestionRow {
  id: number;
  question: string;
  status: string;
  device_code: string;
  customer_id: string;
  occurrence_count: number;
  data_json: string;
  created_at: string;
  updated_at: string;
  [key: string]: string | number;
}

export async function registerUnknownQuestionRoutes(app: FastifyInstance, db: DatabaseSync) {
  // 8090 的 flow 调这里记一条（同问题累加次数）。鉴权与档案推送同一把钥匙。
  app.post<{ Body: { question?: unknown; device_code?: unknown; customer_id?: unknown; external_conversation_id?: unknown } }>(
    "/api/v1/agent/unknown-questions",
    async (request, reply) => {
      if (!authorizeProfileRequest(request)) return reply.code(403).send({ detail: "Not authenticated" });

      const body = request.body ?? {};
      const question = normalizeQuestion(body.question);
      if (!question) return reply.code(422).send({ detail: "question is required" });
      const deviceCode = asText(body.device_code).trim();
      const customerId = asText(body.customer_id).trim() || asText(body.external_conversation_id).trim();

      // 同一设备 + 同一句问法只留一行：运营补一次话术就都解决了
      const existing = db.prepare("SELECT * FROM unknown_questions WHERE question=? AND device_code=? ORDER BY id DESC LIMIT 1")
        .get(question, deviceCode) as UnknownQuestionRow | undefined;

      if (existing) {
        db.prepare("UPDATE unknown_questions SET occurrence_count=occurrence_count+1,customer_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(customerId || existing.customer_id, existing.id);
        const row = db.prepare("SELECT * FROM unknown_questions WHERE id=?").get(existing.id) as UnknownQuestionRow;
        return { id: row.id, question: row.question, occurrence_count: Number(row.occurrence_count), status: row.status };
      }

      const inserted = db.prepare("INSERT INTO unknown_questions(question,status,device_code,customer_id,occurrence_count,data_json) VALUES (?,'pending',?,?,1,?)")
        .run(question, deviceCode, customerId, JSON.stringify({ source: "flow", device_code: deviceCode, customer_id: customerId }));
      const row = db.prepare("SELECT * FROM unknown_questions WHERE id=?").get(Number(inserted.lastInsertRowid)) as UnknownQuestionRow;
      return { id: row.id, question: row.question, occurrence_count: Number(row.occurrence_count), status: row.status };
    },
  );

  // 运营点「已处理」。幂等：已经是 resolved 也返回成功，不报 409 折磨前端。
  app.post<{ Params: { id: string } }>("/api/v1/unknown-questions/:id/resolve", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id)) return reply.code(404).send({ detail: "未知问题不存在" });

    const row = db.prepare("SELECT * FROM unknown_questions WHERE id=?").get(id) as UnknownQuestionRow | undefined;
    if (!row) return reply.code(404).send({ detail: "未知问题不存在" });

    const scope = getUserScope(db, request.auth!);
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.data_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
    if (!scope.isAdmin && !canAccessRecruiter(scope, String(data.recruiter_id ?? ""))) {
      return reply.code(404).send({ detail: "未知问题不存在" });
    }

    if (row.status !== "resolved") {
      db.prepare("UPDATE unknown_questions SET status='resolved',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    }
    return { success: true, id, status: "resolved" };
  });
}

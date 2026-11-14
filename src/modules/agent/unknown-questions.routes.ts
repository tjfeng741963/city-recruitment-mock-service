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
 * 4. 运营点「转知识库」→ POST /api/v1/unknown-questions/:id/convert
 *    （拿运营填的答案去 8090 建一条 script 话术，成功才标 resolved；
 *     写法与 resolve 一致：同 scope 校验、幂等返回成功不报 409）
 *
 * 本期只做占位：不接 LLM 生成回答，也不做自动合并相似问法。
 */

/** 归一化：折叠空白、去掉结尾标点。「体检要花钱吗？」和「体检要花钱吗」算一条。 */
export function normalizeQuestion(text: unknown): string {
  const raw = typeof text === "string" ? text : "";
  return raw.replace(/\s+/g, " ").trim().replace(/[?？。.!！~ ]+$/u, "");
}

/** 8090 知识库条目的默认标题：问题去掉标点再截 30 字，运营没填标题时兜底。 */
export function defaultKbTitle(question: unknown): string {
  const raw = typeof question === "string" ? question : "";
  const stripped = raw.replace(/[\p{P}\p{S}\p{C}\s]+/gu, "");
  const base = stripped || raw.trim();
  return base.slice(0, 30);
}

/** convert 到 8090 的超时：运营在弹窗里等，太长会以为按钮坏了。 */
const BRAIN_TIMEOUT_MS = 5000;

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

  // 运营点「转知识库」：答案拿到 8090 建一条 script 话术，建成功才标 resolved。
  // 幂等与 resolve 一致：已是 resolved 直接返回成功，不再重复调 8090。
  app.post<{ Params: { id: string }; Body: { answer?: unknown; title?: unknown } }>(
    "/api/v1/unknown-questions/:id/convert",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id)) return reply.code(404).send({ detail: "未知问题不存在" });

      const answer = typeof request.body?.answer === "string" ? request.body.answer.trim() : "";
      if (!answer) return reply.code(422).send({ detail: "Answer cannot be empty" });

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

      if (row.status === "resolved") return { success: true, id, status: "resolved" };

      const customTitle = typeof request.body?.title === "string" ? request.body.title.trim() : "";
      const title = customTitle || defaultKbTitle(row.question);
      const brainUrl = (process.env.REA_BRAIN_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
      const token = process.env.REA_PROFILE_TOKEN ?? "";

      try {
        const response = await fetch(`${brainUrl}/api/v1/kb/entries`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Profile-Token": token },
          body: JSON.stringify({ kind: "script", title, body: answer, status: "enabled" }),
          signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
        });
        if (response.status === 422) {
          const reason = await response.json().catch(() => ({})) as { detail?: unknown };
          return reply.code(422).send({ detail: typeof reason.detail === "string" ? reason.detail : "知识库内容未通过校验，请在知识库配置中明确工厂或岗位归属。" });
        }
        if (response.status !== 201) {
          return reply.code(502).send({ detail: `知识库服务返回 ${response.status}，条目未创建` });
        }
      } catch (error) {
        // 8090 挂了/超时：明确报错，不标 resolved，运营可以重试
        const reason = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ detail: `知识库服务不可达：${reason}` });
      }

      db.prepare("UPDATE unknown_questions SET status='resolved',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'resolved'").run(id);
      return { success: true, id, status: "resolved", title, kb_title: title };
    },
  );
}

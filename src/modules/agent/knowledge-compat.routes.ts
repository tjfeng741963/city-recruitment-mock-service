import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";

/**
 * 知识库「旧页面契约 → 新数据表」衔接层（2026-11-15）。
 *
 * ## 为什么需要这一层
 *
 * 我们有两条路线并存：
 *   A. 竞品原版页面（public/assets 的 KnowledgeView）→ 调 /api/v1/knowledge
 *   B. 我们自己的知识库 v3（kb_faq 表 + Python 侧的硬过滤检索）
 *
 * 原版页面调的 `/api/v1/knowledge` 走的是旧表 `knowledge_items`，
 * 而 AI 实际回复时读的是 `kb_faq`。结果是：管理员在页面上改的，
 * AI 不用；运营在配置台里配的，页面看不见。
 *
 * 本模块让**原版页面直接读写 kb_faq**，不改前端一行代码 —— 这是「补骨架」
 * 的第一块拼图：页面壳保持用户认可的样子，数据换成我们自己的路线。
 *
 * ## 契约来源（实测自 public/assets/knowledge-D9f7vM6e.js）
 *
 *   GET    /api/v1/knowledge            ?page&page_size&search
 *   GET    /api/v1/knowledge/:id
 *   POST   /api/v1/knowledge
 *   PUT    /api/v1/knowledge/:id
 *   DELETE /api/v1/knowledge/:id
 *   POST   /api/v1/knowledge/batch/update   { ids, status|is_active }
 *   POST   /api/v1/knowledge/batch/delete   { ids }
 *
 * ## 字段映射（旧契约 ← kb_faq）
 *
 *   question      ← question
 *   keywords[]    ← keywords   (JSON 字符串 → 数组)
 *   is_active     ← status === 'enabled'
 *   sort_order    ← priority
 *   recruiter_id  ← ''         (新表没有招聘员维度，保留字段避免前端报错)
 *   updated_at    ← updated_at
 *
 * ## 开关
 *
 *   REA_KB_COMPAT=on   启用（默认）
 *   REA_KB_COMPAT=off  关闭，回落到 resource.routes.ts 的旧表实现
 *
 * 为什么要有开关：万一新表数据异常，运维可以远程切回旧实现，不用回滚代码。
 */

type Row = Record<string, unknown>;

/** keywords 存的是 JSON 数组；解析失败就当空数组，不让页面崩。 */
function parseKeywords(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item ?? "")).filter(Boolean);
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? "")).filter(Boolean);
  } catch {
    /* 坏数据不阻塞列表 */
  }
  return [];
}

/** kb_faq 一行 → 旧页面要求的七字段。 */
function toLegacyShape(row: Row): Row {
  return {
    id: Number(row.id ?? 0),
    question: String(row.question ?? ""),
    keywords: parseKeywords(row.keywords),
    is_active: String(row.status ?? "") === "enabled",
    sort_order: Number(row.priority ?? 0),
    recruiter_id: "",
    updated_at: String(row.updated_at ?? ""),
  };
}

function isCompatEnabled(): boolean {
  return (process.env.REA_KB_COMPAT ?? "on").trim().toLowerCase() !== "off";
}

export function registerKnowledgeCompatRoutes(app: FastifyInstance, db: DatabaseSync): void {
  if (!isCompatEnabled()) return;

  const isAdmin = (request: import("fastify").FastifyRequest) => request.auth?.role === "admin";
  const ADMIN_REQUIRED = { detail: "需要管理员权限" };

  // 已经有人注册过就直接跳过，避免重复注册崩服务
  const occupied = (method: string, url: string): boolean =>
    typeof app.hasRoute === "function" && app.hasRoute({ method: method as never, url });

  // ── 列表 ────────────────────────────────────────────────────────
  // 旧页面只传 page/page_size/search；新表没有 title，搜索落在 question + answer。
  if (!occupied("GET", "/api/v1/knowledge")) {
    app.get<{ Querystring: Record<string, unknown> }>("/api/v1/knowledge", async (request) => {
      const { pageSize, offset } = parsePagination(request.query);
      const search = String(request.query.search ?? "").trim();
      const conditions = ["status<>'deleted'"];
      const params: Array<string | number> = [];
      if (search) {
        conditions.push("(question LIKE ? OR answer LIKE ?)");
        params.push(`%${search}%`, `%${search}%`);
      }
      const where = conditions.join(" AND ");
      const rows = db
        .prepare(`SELECT * FROM kb_faq WHERE ${where} ORDER BY priority DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset) as Row[];
      const total = Number(
        (db.prepare(`SELECT COUNT(*) c FROM kb_faq WHERE ${where}`).get(...params) as { c: number }).c,
      );
      return { items: rows.map(toLegacyShape), total };
    });
  }

  // ── 单条读取 ────────────────────────────────────────────────────
  if (!occupied("GET", "/api/v1/knowledge/:id")) {
    app.get<{ Params: { id: string } }>("/api/v1/knowledge/:id", async (request, reply) => {
      const row = db
        .prepare("SELECT * FROM kb_faq WHERE id=? AND status<>'deleted'")
        .get(Number(request.params.id)) as Row | undefined;
      if (!row) return reply.code(404).send({ detail: "记录不存在" });
      // 编辑弹窗要看 answer，列表契约里没有它，单条这里补上
      return { ...toLegacyShape(row), answer: String(row.answer ?? "") };
    });
  }

  // ── 新建 ────────────────────────────────────────────────────────
  if (!occupied("POST", "/api/v1/knowledge")) {
    app.post<{ Body: Row }>("/api/v1/knowledge", async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const body = request.body ?? {};
      const question = String(body.question ?? "").trim();
      if (!question) return reply.code(422).send({ detail: "question 不能为空" });
      const answer = String(body.answer ?? "").trim();
      if (!answer) return reply.code(422).send({ detail: "answer 不能为空" });
      const keywords = Array.isArray(body.keywords)
        ? body.keywords.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [];
      // 排序默认值：不传就取「现有最大值 +1」，让新建条目排在最前。
      // 旧表按 id DESC 排序，新建的天然在最上面；新表按 priority DESC 排，
      // 若默认 0 会沉到几百条存量之后 —— 运营建完看不见，会以为没保存成功。
      const explicitPriority = body.sort_order ?? body.priority;
      const priority = explicitPriority !== undefined && explicitPriority !== null
        ? Number(explicitPriority) || 0
        : Number(
            (db.prepare("SELECT COALESCE(MAX(priority),0)+1 AS p FROM kb_faq").get() as { p: number }).p,
          );
      const status = body.is_active === false ? "disabled" : "enabled";

      const result = db
        .prepare(
          `INSERT INTO kb_faq(tenant_id, scope_level, question, keywords, answer, priority, status)
           VALUES(1, 'global', ?, ?, ?, ?, ?)`,
        )
        .run(question, JSON.stringify(keywords), answer, priority, status);
      const created = db
        .prepare("SELECT * FROM kb_faq WHERE id=?")
        .get(Number(result.lastInsertRowid)) as Row;
      return { ...toLegacyShape(created), answer: String(created.answer ?? "") };
    });
  }

  // ── 更新 ────────────────────────────────────────────────────────
  if (!occupied("PUT", "/api/v1/knowledge/:id")) {
    app.put<{ Params: { id: string }; Body: Row }>("/api/v1/knowledge/:id", async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const id = Number(request.params.id);
      const current = db
        .prepare("SELECT * FROM kb_faq WHERE id=? AND status<>'deleted'")
        .get(id) as Row | undefined;
      if (!current) return reply.code(404).send({ detail: "记录不存在" });

      const body = request.body ?? {};
      // 只更新传了的字段：旧页面的批量操作会只带 is_active
      const sets: string[] = [];
      const params: Array<string | number> = [];
      if (body.question !== undefined) {
        const question = String(body.question).trim();
        if (!question) return reply.code(422).send({ detail: "question 不能为空" });
        sets.push("question=?");
        params.push(question);
      }
      if (body.answer !== undefined) {
        const answer = String(body.answer).trim();
        if (!answer) return reply.code(422).send({ detail: "answer 不能为空" });
        sets.push("answer=?");
        params.push(answer);
      }
      if (body.keywords !== undefined) {
        const keywords = Array.isArray(body.keywords)
          ? body.keywords.map((item) => String(item ?? "").trim()).filter(Boolean)
          : [];
        sets.push("keywords=?");
        params.push(JSON.stringify(keywords));
      }
      if (body.sort_order !== undefined || body.priority !== undefined) {
        sets.push("priority=?");
        params.push(Number(body.sort_order ?? body.priority ?? 0) || 0);
      }
      if (body.is_active !== undefined || body.status !== undefined) {
        const enabled = body.is_active !== undefined
          ? Boolean(body.is_active)
          : String(body.status ?? "") === "enabled";
        sets.push("status=?");
        params.push(enabled ? "enabled" : "disabled");
      }
      if (!sets.length) {
        return reply.code(422).send({ detail: "没有可更新的字段" });
      }
      sets.push("updated_at=CURRENT_TIMESTAMP");
      db.prepare(`UPDATE kb_faq SET ${sets.join(",")} WHERE id=?`).run(...params, id);
      const updated = db.prepare("SELECT * FROM kb_faq WHERE id=?").get(id) as Row;
      return { ...toLegacyShape(updated), answer: String(updated.answer ?? "") };
    });
  }

  // ── 删除（软删）──────────────────────────────────────────────────
  // 旧表是硬删；这里改软删，因为 kb_faq 可能被 template_item_id 引用，
  // 硬删会让「这条是从哪个模板来的」断链。
  if (!occupied("DELETE", "/api/v1/knowledge/:id")) {
    app.delete<{ Params: { id: string } }>("/api/v1/knowledge/:id", async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const result = db
        .prepare("UPDATE kb_faq SET status='deleted', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(Number(request.params.id));
      return { success: true, deleted: Number(result.changes) };
    });
  }

  // ── 批量改状态 ──────────────────────────────────────────────────
  if (!occupied("POST", "/api/v1/knowledge/batch/update")) {
    app.post<{ Body: { ids?: number[]; status?: string; is_active?: boolean } }>(
      "/api/v1/knowledge/batch/update",
      async (request, reply) => {
        if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
        const ids = Array.isArray(request.body?.ids) ? request.body.ids.map(Number).filter(Number.isFinite) : [];
        if (!ids.length) return reply.code(422).send({ detail: "ids 不能为空" });
        const enabled = request.body?.is_active !== undefined
          ? Boolean(request.body.is_active)
          : String(request.body?.status ?? "") === "enabled";
        const status = enabled ? "enabled" : "disabled";
        const stmt = db.prepare(
          "UPDATE kb_faq SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'deleted'",
        );
        let updated = 0;
        for (const id of ids) updated += Number(stmt.run(status, id).changes);
        return { success: true, updated };
      },
    );
  }

  // ── 批量删除（软删）──────────────────────────────────────────────
  if (!occupied("POST", "/api/v1/knowledge/batch/delete")) {
    app.post<{ Body: { ids?: number[] } }>("/api/v1/knowledge/batch/delete", async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const ids = Array.isArray(request.body?.ids) ? request.body.ids.map(Number).filter(Number.isFinite) : [];
      if (!ids.length) return reply.code(422).send({ detail: "ids 不能为空" });
      const stmt = db.prepare(
        "UPDATE kb_faq SET status='deleted', updated_at=CURRENT_TIMESTAMP WHERE id=?",
      );
      let deleted = 0;
      for (const id of ids) deleted += Number(stmt.run(id).changes);
      return { success: true, deleted };
    });
  }
}

/** 给测试用：导出映射函数，验证七字段契约。 */
export const __test = { toLegacyShape, parseKeywords };

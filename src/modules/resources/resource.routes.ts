import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";
import { serializeAccountSummary, serializeEvaluationOverview, serializeRecruiter } from "../../shared/response-serializers.js";
import { canAccessCity, canAccessDevice, canAccessRecruiter, getUserScope, type UserScope } from "../../auth/user-scopes.js";
import { rolePreHandler } from "../../auth/rbac.js";

type Resource = { table: string; name: string; fields: string[]; scope: "city" | "recruiter" | "device" | "admin" };
const resources: Resource[] = [
  // kind / date 都是 NOT NULL 但前端不传，由 normalizeHolidayBody 兜底。
  { table: "holiday_schedules", name: "holiday-schedules", fields: ["city_id", "date", "kind"], scope: "city" },
  { table: "recruiters", name: "recruiters", fields: ["username", "city_id", "status"], scope: "recruiter" },
];

function rowData(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.data_json !== "string") return {};
  try {
    const data: unknown = JSON.parse(row.data_json);
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch { return {}; }
}

/** knowledge 的路由是否已被 agent/knowledge-compat.routes.ts 接管（读写 kb_faq）。 */
function knowledgeCompatEnabled(): boolean {
  return (process.env.REA_KB_COMPAT ?? "on").trim().toLowerCase() !== "off";
}

function canAccessResource(resource: Resource, row: Record<string, unknown>, scope: UserScope): boolean {
  if (scope.isAdmin) return true;
  const data = rowData(row);
  switch (resource.scope) {
    case "city": return canAccessCity(scope, Number(row.city_id));
    case "recruiter": return canAccessRecruiter(scope, String(data.recruiter_id ?? row.recruiter_id ?? row.username ?? ""));
    case "device": return canAccessDevice(scope, String(data.device_code ?? row.device_code ?? ""));
    case "admin": return false;
  }
}

function toOutput(row: Record<string, unknown>, resource?: Resource, db?: DatabaseSync) {
  const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
  const { data_json: _data, ...base } = row;
  const result = { ...base, ...data } as Record<string, unknown>;
  // Target projects knowledge items to exactly these seven fields; title/content/
  // status/created_at are local storage details and must not leak out.
  if (resource?.name === "knowledge") {
    return {
      id: result.id,
      question: result.question ?? result.title ?? "",
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      is_active: Boolean(result.is_active ?? result.status === "enabled"),
      sort_order: Number(result.sort_order ?? 0),
      recruiter_id: String(result.recruiter_id ?? ""),
      updated_at: result.updated_at,
    };
  }
  if (resource?.name === "unknown-questions") {
    // 知识库页要的字段：次数、城市、最近出现、被合并的相似问法
    const seen = Number(row.occurrence_count ?? 0) || 0;
    const legacy = Number(data.count ?? 0) || 0;
    result.status = row.status;
    result.count = legacy || seen;
    result.occurrence_count = result.count;
    result.city_name = String(data.city_name ?? "");
    result.last_seen_at = row.updated_at;
    result.merged_questions = Array.isArray(data.merged_questions) ? data.merged_questions : [];
    delete result.converted_knowledge_id;
    delete result.converted_at;
  }
  if (resource?.name === "activation/scripts") { result.content = result.content ?? result.script_name; result.category = result.category ?? data.category ?? "寒暄召回"; result.is_active = result.is_active ?? result.status === "enabled"; result.used_count = result.used_count ?? 0; }
  if (resource?.name === "recruiters") {
    const recruiterId = Number(result.id);
    const cities = db ? db.prepare("SELECT rc.city_id,c.city_name,rc.is_enabled,rc.sort_order FROM recruiter_cities rc JOIN cities c ON c.id=rc.city_id WHERE rc.recruiter_id=? AND rc.is_service=0 ORDER BY rc.sort_order,c.city_name").all(recruiterId) as Array<Record<string, unknown>> : [];
    return serializeRecruiter(row, cities);
  }
  return result;
}

function value(body: Record<string, unknown>, field: string): string | number {
  const raw = body[field];
  return typeof raw === "number" || typeof raw === "string" ? raw : "";
}

/**
 * The target's public field names differ from the local column names.
 * knowledge: {question, answer} -> (title, content)
 * recruiters: {recruiter_id, name} -> (username)
 * Without this mapping the NOT NULL columns receive nothing and SQLite 500s.
 */
const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  knowledge: { title: ["question"], content: ["answer"] },
  recruiters: { username: ["recruiter_id", "name"] },
};

/**
 * 节假日配置：前端发的是业务字段，表里是 city_id + date。
 * 不转换的话 date 是 NOT NULL 直接 500（实测点"新增"必崩）。
 */
function normalizeHolidayBody(
  db: DatabaseSync,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };

  // city_name -> city_id
  if (next.city_id === undefined || next.city_id === null) {
    const name = typeof next.city_name === "string" ? next.city_name.trim() : "";
    if (name) {
      const city = db.prepare("SELECT id FROM cities WHERE city_name=?").get(name) as
        | { id: number }
        | undefined;
      if (city) next.city_id = city.id;
    }
  }

  // start_date -> date（date 列 NOT NULL，缺失必定 500）
  if (next.date === undefined || next.date === null || next.date === "") {
    const start = typeof next.start_date === "string" ? next.start_date.trim() : "";
    if (start) next.date = start.slice(0, 10);
  }

  // is_active 是前端展示字段，落到 status
  if (next.status === undefined && typeof next.is_active === "boolean") {
    next.status = next.is_active ? "enabled" : "disabled";
  }

  // kind 是 NOT NULL 但前端没有这个概念，按节假日名推断一个合理值
  if (next.kind === undefined || next.kind === null || next.kind === "") {
    const name = typeof next.holiday_name === "string" ? next.holiday_name : "";
    next.kind = /补班|调休/.test(name) ? "workday" : "holiday";
  }
  return next;
}

function resolveField(resourceName: string, body: Record<string, unknown>, column: string): unknown {
  if (body[column] !== undefined && body[column] !== null) return body[column];
  for (const alias of FIELD_ALIASES[resourceName]?.[column] ?? []) {
    if (typeof body[alias] === "string") return body[alias];
  }
  return undefined;
}

function list(db: DatabaseSync, resource: Resource, query: Record<string, unknown>, scope: UserScope) {
  const { page, pageSize, offset } = parsePagination(query);
  let rows = (db.prepare(`SELECT * FROM ${resource.table} ORDER BY id DESC`).all() as Array<Record<string, unknown>>).filter((row) => canAccessResource(resource, row, scope));
  // 知识库页会带 status + search；其它 resource 沿用原样，不新增行为。
  if (resource.name === "unknown-questions") {
    const status = typeof query.status === "string" ? query.status.trim() : "";
    const search = typeof query.search === "string" ? query.search.trim() : "";
    if (status) rows = rows.filter((row) => String(row.status) === status);
    if (search) rows = rows.filter((row) => String(row.question ?? "").includes(search));
  }
  // Target list envelope is exactly {items, total} for these resources.
  return { items: rows.slice(offset, offset + pageSize).map((row) => toOutput(row, resource, db)), total: rows.length };
}

export async function registerResourceRoutes(app: FastifyInstance, db: DatabaseSync) {
  // 「转知识库」convert 已迁到 agent/unknown-questions.routes.ts：
  // 现在是拿答案去 8090 建 script 话术（X-Profile-Token），成功才标 resolved。

  for (const resource of resources) {
    // knowledge 的路由已由 agent/knowledge-compat.routes.ts 接管：那条路线读写
    // kb_faq（AI 实际回复用的表），不再是 knowledge_items。这里跳过，否则
    // Fastify 会因重复注册抛 FST_ERR_DUPLICATED_ROUTE。
    // 回退方式：把环境变量 REA_KB_COMPAT 设成 off，本分支即不再跳过。
    if (resource.name === "knowledge" && knowledgeCompatEnabled()) continue;
    const base = `/api/v1/${resource.name}`;
    app.get<{ Querystring: Record<string, unknown> }>(base, async (request) => {
      const result = list(db, resource, request.query, getUserScope(db, request.auth!));
      if (resource.name === "activation/scripts") {
        const active = (db.prepare("SELECT COUNT(*) count FROM activation_scripts WHERE status='enabled'").get() as { count: number }).count;
        const categories = [...new Set(result.items.map((item) => String((item as Record<string, unknown>).category ?? "")))].filter(Boolean);
        return { ...result, active_total: active, categories };
      }
      return result;
    });
    app.get<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => { const row = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(request.params.id)) as Record<string, unknown> | undefined; return row && canAccessResource(resource, row, getUserScope(db, request.auth!)) ? toOutput(row, resource, db) : reply.code(404).send({ detail: "记录不存在" }); });
    app.post<{ Body: Record<string, unknown> }>(base, async (request, reply) => {
      let body = request.body ?? {};
      if (resource.name === "holiday-schedules") {
        body = normalizeHolidayBody(db, body);
        if (!body.date) {
          return reply.code(422).send({ detail: "start_date 不能为空" });
        }
      }
      const scope = getUserScope(db, request.auth!);
      const proposedRow = {
        ...body,
        username: resolveField(resource.name, body, "username"),
        data_json: JSON.stringify(body),
      };
      if (!canAccessResource(resource, proposedRow, scope)) return reply.code(403).send({ detail: "Resource scope required" });
      const columns = resource.fields.filter((field) => field !== "status" || body[field] !== undefined);
      // Absent values must be SQL NULL, not "": an empty string for a foreign
      // key (recruiters.city_id) fails the constraint with a 500. Fields whose
      // public name differs from the column go through resolveField.
      const values = columns.map((column) => {
        const resolved = resolveField(resource.name, body, column);
        if (resolved === undefined) return null;
        return typeof resolved === "number" || typeof resolved === "string" ? resolved : "";
      });
      const placeholders = columns.map(() => "?").join(",");
      const result = db.prepare(`INSERT INTO ${resource.table}(${columns.join(",")},data_json) VALUES (${placeholders},?)`).run(...values, JSON.stringify(body));
      return toOutput(db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(result.lastInsertRowid)) as Record<string, unknown>, resource, db);
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(`${base}/:id`, async (request, reply) => {
      let body = request.body ?? {};
      if (resource.name === "holiday-schedules") {
        body = normalizeHolidayBody(db, body);
      }
      const id = Number(request.params.id);
      const current = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      const scope = getUserScope(db, request.auth!);
      if (!current || !canAccessResource(resource, current, scope)) return reply.code(404).send({ detail: "记录不存在" });
      const nextData = { ...rowData(current), ...body };
      const nextRow = { ...current, ...body, data_json: JSON.stringify(nextData) };
      if (!canAccessResource(resource, nextRow, scope)) return reply.code(403).send({ detail: "Resource scope required" });
      const assignments = resource.fields.map((field) => `${field}=COALESCE(?,${field})`).join(",");
      const values = resource.fields.map((field) => body[field] === undefined ? null : value(body, field));
      const result = db.prepare(`UPDATE ${resource.table} SET ${assignments},data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values, JSON.stringify(nextData), id);
      return result.changes ? toOutput(db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(id) as Record<string, unknown>, resource, db) : reply.code(404).send({ detail: "记录不存在" });
    });
    app.delete<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => { const id = Number(request.params.id); const row = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(id) as Record<string, unknown> | undefined; if (!row || !canAccessResource(resource, row, getUserScope(db, request.auth!))) return reply.code(404).send({ detail: "记录不存在" }); const result = db.prepare(`DELETE FROM ${resource.table} WHERE id=?`).run(id); return result.changes ? { success: true } : reply.code(404).send({ detail: "记录不存在" }); });
  }

  // Target shape is a fixed four-key object: company_name, dedup_llm_api_key,
  // dedup_llm_model (strings) and requirements (object).
  app.get("/api/v1/settings", async () => {
    const rows = db.prepare("SELECT key,value_json FROM settings ORDER BY key").all() as Array<{ key: string; value_json: string }>;
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
    return {
      company_name: String(stored.company_name ?? ""),
      dedup_llm_api_key: String(stored.dedup_llm_api_key ?? ""),
      dedup_llm_model: String(stored.dedup_llm_model ?? ""),
      // Target types: age_range is a label string ("18-35岁"), age_limit is an
      // object ({min, max}). Swapping them is a shape divergence.
      requirements: (() => {
        const storedReq = stored.requirements && typeof stored.requirements === "object" ? stored.requirements as Record<string, unknown> : {};
        return {
          age_range: typeof storedReq.age_range === "string" ? storedReq.age_range : "",
          age_limit: storedReq.age_limit && typeof storedReq.age_limit === "object" ? storedReq.age_limit : { min: 0, max: 0 },
        };
      })(),
    };
  });
  // The target echoes the same four-key settings object that GET returns.
  app.put<{ Body: Record<string, unknown> }>("/api/v1/settings", { preHandler: rolePreHandler("admin") }, async (request) => {
    for (const [key, value] of Object.entries(request.body ?? {})) db.prepare("INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(key, JSON.stringify(value));
    const rows = db.prepare("SELECT key,value_json FROM settings").all() as Array<{ key: string; value_json: string }>;
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
    const storedReq = stored.requirements && typeof stored.requirements === "object" ? stored.requirements as Record<string, unknown> : {};
    return {
      company_name: String(stored.company_name ?? ""),
      dedup_llm_api_key: String(stored.dedup_llm_api_key ?? ""),
      dedup_llm_model: String(stored.dedup_llm_model ?? ""),
      requirements: {
        age_range: typeof storedReq.age_range === "string" ? storedReq.age_range : "",
        age_limit: storedReq.age_limit && typeof storedReq.age_limit === "object" ? storedReq.age_limit : { min: 0, max: 0 },
      },
    };
  });
  // Target includes is_default alongside the base URL.
  app.get("/api/v1/settings/agent", async () => ({ agent_base_url: "", is_default: true }));
  app.put<{ Body: { agent_base_url?: string } }>("/api/v1/settings/agent", { preHandler: rolePreHandler("admin") }, async (request, reply) => {
    const url = request.body?.agent_base_url;
    if (typeof url !== "string" || url.trim() === "") return reply.code(400).send({ detail: "agent_base_url 不能为空" });
    db.prepare("INSERT INTO settings(key,value_json) VALUES ('agent_base_url',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(url));
    return { agent_base_url: url };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/settings/sync", { preHandler: rolePreHandler("admin") }, async (request) => ({ success: true, synced: Object.keys(request.body ?? {}) }));
  // Target shape: {days: number, items: array} — no per-status counters.
  // Running an evaluation across devices is admin-only on the target.
  // knowledge 的两个批量接口已由 agent/knowledge-compat.routes.ts 接管
  // （读写 kb_faq）。这里按同一开关跳过，否则 Fastify 报 FST_ERR_DUPLICATED_ROUTE。
  if (!knowledgeCompatEnabled()) {
  }
  // Target shape: {cities: array, unlimited: boolean} — no items envelope.
  // Target item shape: {city_name, interview_site_name}.
  app.get("/api/v1/holiday-schedules/my-cities", async (request) => {
    const scope = getUserScope(db, request.auth!);
    const rows = (db.prepare("SELECT id,city_name,data_json FROM cities ORDER BY city_name").all() as Array<{ id: number; city_name: string; data_json: string }>).filter((row) => canAccessCity(scope, row.id));
    return {
      cities: rows.map((row) => {
        const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
        return { city_name: row.city_name, interview_site_name: String(data.interview_site_name ?? "") };
      }),
      unlimited: scope.isAdmin,
    };
  });
}

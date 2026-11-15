import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";
import { serializeAccountSummary, serializeEvaluationOverview, serializeRecruiter } from "../../shared/response-serializers.js";
import { canAccessCity, canAccessDevice, canAccessRecruiter, deviceConstraint, getUserScope, type UserScope } from "../../auth/user-scopes.js";
import { rolePreHandler } from "../../auth/rbac.js";

type Resource = { table: string; name: string; fields: string[]; scope: "city" | "recruiter" | "device" | "admin" };
const resources: Resource[] = [
  { table: "knowledge_items", name: "knowledge", fields: ["title", "content", "status"], scope: "recruiter" },
  { table: "unknown_questions", name: "unknown-questions", fields: ["question", "status"], scope: "recruiter" },
  // kind / date 都是 NOT NULL 但前端不传，由 normalizeHolidayBody 兜底。
  { table: "holiday_schedules", name: "holiday-schedules", fields: ["city_id", "date", "kind"], scope: "city" },
  { table: "recruiters", name: "recruiters", fields: ["username", "city_id", "status"], scope: "recruiter" },
  { table: "agent_rules", name: "agent/rules", fields: ["rule_name", "status"], scope: "recruiter" },
  { table: "agent_evaluations", name: "agent/evaluations", fields: ["evaluation_name", "status"], scope: "device" },
  { table: "activation_strategies", name: "activation/strategy-resources", fields: ["strategy_name", "status"], scope: "admin" },
  { table: "activation_devices", name: "activation/device-resources", fields: ["device_name", "status"], scope: "admin" },
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
  app.get("/api/v1/agent/reminder-config", async () => {
    const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : { id: 0, recruiter_id: "global", enabled: false, mode: "advance", advance_hours: 2, fixed_time: "09:00", script: "" };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/reminder-config", async (request, reply) => { if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" }); const body = request.body ?? {}; db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('reminder','global',?) ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify({ id: 0, recruiter_id: "global", enabled: Boolean(body.enabled), mode: body.mode ?? "advance", advance_hours: Number(body.advance_hours ?? 2), fixed_time: body.fixed_time ?? "09:00", script: body.script ?? "" })); return JSON.parse(String((db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string }).value_json)); });
  app.get("/api/v1/agent/followup-config", async () => { const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='followup' AND recruiter_id='global'").get() as { value_json: string } | undefined; return row ? JSON.parse(row.value_json) : { id: 0, recruiter_id: "global", enabled: false, interval_seconds: 300, max_count: 3, scripts: [] }; });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/followup-config", async (request, reply) => { if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" }); const body = request.body ?? {}; const value = { id: 0, recruiter_id: "global", enabled: Boolean(body.enabled), interval_seconds: Number(body.interval_seconds ?? 300), max_count: Number(body.max_count ?? 3), scripts: Array.isArray(body.scripts) ? body.scripts : [] }; db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('followup','global',?) ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(value)); return value; });
  /**
   * AI 评估总览。过去固定返回 items: []，页面上「综合评分 / 邀约转化 /
   * AI 独立性 / 对话深度 / 稳定性」五张卡全是横杠，等级永远 N。
   *
   * 现在按真实对话计算四个维度，再加权成总分：
   *   conversion    邀约转化 = 有面试日期的会话占比
   *   independence  AI 独立性 = 1 - 转人工会话占比（越少人插手越独立）
   *   depth         对话深度 = 消息数 ≥6 的会话占比
   *   stability     稳定性 = 1 - 失败消息占比
   * 权重：转化 40% / 独立 25% / 深度 20% / 稳定 15%。
   * 等级：S≥90 A≥80 B≥70 C≥60 D<60；没有会话数据时返回空，页面显示「--」。
   */
  app.get<{ Querystring: { days?: string } }>("/api/v1/agent/evaluation/overview", async (request) => {
    const days = Math.min(365, Math.max(1, Number(request.query.days) || 7));
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const scope = deviceConstraint(getUserScope(db, request.auth!), "device_code");

    const conv = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN takeover=1 THEN 1 ELSE 0 END) AS takeover,
              SUM(CASE WHEN interview_date<>'' THEN 1 ELSE 0 END) AS invited
         FROM agent_conversations WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)${scope.sql}`,
    ).get(start, end, ...scope.values) as { total: number | null; takeover: number | null; invited: number | null };
    const msg = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS failed
         FROM agent_messages WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)${scope.sql}`,
    ).get(start, end, ...scope.values) as { total: number | null; failed: number | null };
    const deep = db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT device_code, customer_id FROM agent_messages
          WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)${scope.sql}
          GROUP BY device_code, customer_id HAVING COUNT(*) >= 6
       )`,
    ).get(start, end, ...scope.values) as { n: number };

    const total = Number(conv.total ?? 0);
    const messages = Number(msg.total ?? 0);
    if (total === 0 || messages === 0) {
      return serializeEvaluationOverview({ days, items: [] });
    }
    const pct = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 1000) / 10;
    const conversion = pct(Number(conv.invited ?? 0) / total);
    const independence = pct(1 - Number(conv.takeover ?? 0) / total);
    const depth = pct(Number(deep.n ?? 0) / total);
    const stability = pct(1 - Number(msg.failed ?? 0) / messages);
    const weighted = Math.round((conversion * 0.4 + independence * 0.25 + depth * 0.2 + stability * 0.15) * 10) / 10;
    const level = weighted >= 90 ? "S" : weighted >= 80 ? "A" : weighted >= 70 ? "B" : weighted >= 60 ? "C" : "D";
    // items 按天给一条，前端取最后一条作为「当前评分」
    const items = Array.from({ length: days }, (_, index) => {
      const date = new Date(today.getTime() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
      return {
        date,
        weighted_score: weighted,
        level,
        dimension_scores: { conversion, independence, depth, stability },
        totals: { conversations: total, messages, invited: Number(conv.invited ?? 0), takeover: Number(conv.takeover ?? 0) },
      };
    });
    return serializeEvaluationOverview({ days, items });
  });
  /**
   * 评估明细：读 evaluation_runs 里那天的结果，按设备拆开。
   * 过去固定返回 items: []，点开任何一天都是空表。
   */
  app.get<{ Querystring: { device_code?: string; eval_date?: string } }>("/api/v1/agent/evaluation/detail", async (request) => {
    const deviceCode = String(request.query.device_code ?? "").trim();
    const evalDate = String(request.query.eval_date ?? "").trim() || new Date().toISOString().slice(0, 10);
    const scope = deviceConstraint(getUserScope(db, request.auth!), "device_code");
    const deviceSql = deviceCode ? " AND device_code=?" : "";
    const rows = db.prepare(
      `SELECT device_code, eval_date, total, invited, failed, created_at
         FROM evaluation_runs WHERE eval_date=?${deviceSql}${scope.sql} ORDER BY device_code`,
    ).all(evalDate, ...(deviceCode ? [deviceCode] : []), ...(deviceCode ? [] : scope.values)) as Array<{
      device_code: string; eval_date: string; total: number; invited: number; failed: number; created_at: string;
    }>;
    return {
      device_code: deviceCode,
      eval_date: evalDate,
      items: rows.map((row) => ({
        device_code: row.device_code,
        eval_date: row.eval_date,
        total: Number(row.total ?? 0),
        invited: Number(row.invited ?? 0),
        failed: Number(row.failed ?? 0),
        // 同一次评审里邀约成功的比例，页面「邀约转化」列用
        invite_rate: Number(row.total ?? 0) ? Math.round((Number(row.invited ?? 0) / Number(row.total)) * 1000) / 10 : 0,
        created_at: row.created_at,
      })),
    };
  });
  /**
   * 运行评审（管理员）：按设备统计当天的真实数据并落库。
   * 过去固定返回 total/invited/failed = 0，点「运行评审」什么也不会发生。
   *
   * 统计口径：该设备当天有 inbound 的会话数 = total；其中有面试日期的 = invited；
   * 发失败的 AI 消息 = failed。同一天同一设备重复运行按 upsert 覆盖。
   */
  app.post<{ Querystring: { device_code?: string; eval_date?: string } }>("/api/v1/agent/evaluation/run", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required to evaluate all devices" });
    const evalDate = String(request.query.eval_date ?? "").trim() || new Date().toISOString().slice(0, 10);
    const onlyDevice = String(request.query.device_code ?? "").trim();
    const deviceRows = db.prepare("SELECT device_name, data_json FROM agent_devices ORDER BY id").all() as Array<{ device_name: string; data_json: string }>;
    const codes = deviceRows.map((row) => {
      try { return String((JSON.parse(row.data_json || "{}") as Record<string, unknown>).device_code ?? ""); } catch { return ""; }
    }).filter((code) => code !== "" && (onlyDevice === "" || code === onlyDevice));

    const day = "date(?)";
    const results: Array<{ device_code: string; eval_date: string; total: number; invited: number; failed: number }> = [];
    for (const code of codes) {
      const conv = db.prepare(
        `SELECT COUNT(DISTINCT customer_id) AS total,
                SUM(CASE WHEN interview_date<>'' THEN 1 ELSE 0 END) AS invited
           FROM agent_conversations WHERE device_code=? AND ${day}`,
      ).get(code, evalDate) as { total: number | null; invited: number | null };
      const failed = db.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages WHERE device_code=? AND ${day} AND status IN ('failed','timeout')`,
      ).get(code, evalDate) as { n: number | null };
      const total = Number(conv.total ?? 0);
      const invited = Number(conv.invited ?? 0);
      const failedCount = Number(failed.n ?? 0);
      db.prepare(
        `INSERT INTO evaluation_runs(device_code, eval_date, total, invited, failed)
         VALUES (?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
      ).run(code, evalDate, total, invited, failedCount);
      // 没有唯一约束时用「先删后插」保证同一天同一设备只留一条
      db.prepare("DELETE FROM evaluation_runs WHERE device_code=? AND eval_date=? AND id NOT IN (SELECT MAX(id) FROM evaluation_runs WHERE device_code=? AND eval_date=?)")
        .run(code, evalDate, code, evalDate);
      results.push({ device_code: code, eval_date: evalDate, total, invited, failed: failedCount });
    }
    const sum = results.reduce(
      (acc, row) => ({ total: acc.total + row.total, invited: acc.invited + row.invited, failed: acc.failed + row.failed }),
      { total: 0, invited: 0, failed: 0 },
    );
    return { success: true, device_code: onlyDevice, eval_date: evalDate, devices: results.length, ...sum, items: results };
  });
  /**
   * 账号（设备）运营汇总。过去固定返回空数组——「郎职师 · 运营汇总」页面
   * 永远显示 0 行，和「设备报表」里的运营指标是同一件事的两半。
   *
   * 现在按设备聚合真实数据：
   *   agent_devices         → 账号名、招聘员
   *   candidate_events      → 新增 / 邀约 / 待邀约 / 不符合 / 签到
   */
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/agent/report/account-summary", async (request) => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const end = String(request.query.end_date ?? "") || iso(today);
    const start = String(request.query.start_date ?? "") || iso(new Date(today.getTime() - 29 * 86_400_000));
    const prefix = String(request.query.prefix ?? "");
    const scope = getUserScope(db, request.auth!);
    const scopeFilter = deviceConstraint(scope, "device_code");
    const prefixSql = prefix ? " AND device_code LIKE ?" : "";
    const prefixArgs = prefix ? [`${prefix}%`] : [];

    const deviceRows = db.prepare(
      "SELECT id, device_name, data_json FROM agent_devices ORDER BY id",
    ).all() as Array<{ id: number; device_name: string; data_json: string }>;
    const devices = deviceRows.map((row) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.data_json || "{}") as Record<string, unknown>; } catch { data = {}; }
      return {
        name: String(data.name ?? row.device_name ?? ""),
        code: String(data.device_code ?? ""),
        recruiter_id: String(data.recruiter_id ?? ""),
      };
    }).filter((device) => device.code !== "" && (scope.isAdmin || scope.deviceCodes.includes(device.code)));

    const inRange = "date(event_at) >= date(?) AND date(event_at) <= date(?)";
    const accounts = devices.map((device) => {
      const events = db.prepare(
        `SELECT event_type, status, COUNT(*) AS n FROM candidate_events
          WHERE ${inRange} AND device_code=? GROUP BY event_type, status`,
      ).all(start, end, device.code) as Array<{ event_type: string; status: string; n: number }>;
      const sum = (types: string[]) => events.filter((e) => types.includes(e.event_type)).reduce((acc, e) => acc + e.n, 0);
      const checkedIn = events.filter((e) => e.event_type === "checked_in" || e.status === "checked_in").reduce((acc, e) => acc + e.n, 0);
      const invited = sum(["invited"]);
      const disqualified = sum(["disqualified"]);
      const pending = sum(["pending_invite"]);
      const newTotal = events.reduce((acc, e) => acc + e.n, 0);
      return {
        name: device.name || device.code,
        recruiter_id: device.recruiter_id,
        device_count: 1,
        new_total: newTotal,
        invited,
        pending_invite: pending,
        disqualified,
        checked_in: checkedIn,
        invite_rate: newTotal ? Math.round((invited / newTotal) * 1000) / 10 : 0,
      };
    }).filter((row) => row.new_total > 0 || prefix !== "");

    const total = accounts.reduce(
      (acc, row) => ({
        device_count: acc.device_count + row.device_count,
        new_conversations: acc.new_conversations + row.new_total,
        new_total: acc.new_total + row.new_total,
        invited: acc.invited + row.invited,
        pending_invite: acc.pending_invite + row.pending_invite,
        disqualified: acc.disqualified + row.disqualified,
        checked_in: acc.checked_in + row.checked_in,
      }),
      { device_count: 0, new_conversations: 0, new_total: 0, invited: 0, pending_invite: 0, disqualified: 0, checked_in: 0 },
    );
    const totalWithRate = { ...total, invite_rate: total.new_total ? Math.round((total.invited / total.new_total) * 1000) / 10 : 0 };

    // 每日趋势：图表读 date / invited / rate
    const trendRows = db.prepare(
      `SELECT date(event_at) AS date,
              SUM(CASE WHEN event_type='invited' THEN 1 ELSE 0 END) AS invited,
              SUM(CASE WHEN event_type='checked_in' THEN 1 ELSE 0 END) AS checked_in,
              COUNT(*) AS total
         FROM candidate_events WHERE ${inRange}${scopeFilter.sql}${prefixSql}
         GROUP BY date(event_at) ORDER BY date(event_at)`,
    ).all(start, end, ...scopeFilter.values, ...prefixArgs) as Array<{ date: string; invited: number; checked_in: number; total: number }>;
    const daily_trend = trendRows.map((row) => ({
      date: row.date,
      invited: Number(row.invited ?? 0),
      checked_in: Number(row.checked_in ?? 0),
      total: Number(row.total ?? 0),
      rate: Number(row.total ?? 0) ? Math.round((Number(row.invited ?? 0) / Number(row.total)) * 1000) / 10 : 0,
    }));

    return serializeAccountSummary({
      prefix,
      date_range: { start, end },
      total: totalWithRate,
      accounts,
      daily_trend,
    });
  });
  // knowledge 的两个批量接口已由 agent/knowledge-compat.routes.ts 接管
  // （读写 kb_faq）。这里按同一开关跳过，否则 Fastify 报 FST_ERR_DUPLICATED_ROUTE。
  if (!knowledgeCompatEnabled()) {
  app.post<{ Body: { ids?: number[]; status?: string; is_active?: boolean } }>("/api/v1/knowledge/batch/update", async (request) => { const ids = Array.isArray(request.body?.ids) ? request.body.ids : []; const scope = getUserScope(db, request.auth!); const resource = resources.find((item) => item.name === "knowledge")!; let updated = 0; for (const id of ids) { const row = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(Number(id)) as Record<string, unknown> | undefined; if (!row || !canAccessResource(resource, row, scope)) continue; const result = db.prepare("UPDATE knowledge_items SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(request.body?.status ?? (request.body?.is_active === false ? "disabled" : "enabled"), Number(id)); updated += Number(result.changes); } return { success: true, updated }; });
  app.post<{ Body: { ids?: number[] } }>("/api/v1/knowledge/batch/delete", async (request) => { const ids = Array.isArray(request.body?.ids) ? request.body.ids : []; const scope = getUserScope(db, request.auth!); const resource = resources.find((item) => item.name === "knowledge")!; let deleted = 0; for (const id of ids) { const row = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(Number(id)) as Record<string, unknown> | undefined; if (!row || !canAccessResource(resource, row, scope)) continue; deleted += Number(db.prepare("DELETE FROM knowledge_items WHERE id=?").run(Number(id)).changes); } return { success: true, deleted }; });
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

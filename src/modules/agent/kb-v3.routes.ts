import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";

/**
 * 知识库 v3 配置接口：品类 / 位置树 / 招工方 / 场景问答 / 模板包。
 *
 * 设计见 docs/知识库方案-流程驱动-20261113.md，表结构见迁移 021~023。
 *
 * 为什么要有这一层：8090 的 FAQ 检索靠 vertical_id + employer_id 硬过滤，
 * 而这两个 id 目前只能手工写进 agent_devices.data_json——没有界面就没法运营。
 * 本模块提供运营配置这些数据的 HTTP 入口。
 *
 * 约定：
 * - 增删改仅管理员；读允许已登录用户；
 * - 列表统一返回 {items,total}，分页字段 page/page_size；
 * - 删除前检查引用，被引用时返回 409 并说明谁在用（不静默级联）。
 */

type Json = Record<string, unknown>;

/** 把 data_json 之类的字符串安全解析成对象。 */
function parseJson(raw: unknown): Json {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/** keywords / media 存的是 JSON 数组，parseJson 只吃对象，这里单独解析。 */
function parseList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function int(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;

export async function registerKbV3Routes(app: FastifyInstance, db: DatabaseSync) {
  const isAdmin = (request: import("fastify").FastifyRequest) => request.auth?.role === "admin";

  // ── 品类 ────────────────────────────────────────────────────────
  app.get("/api/v1/verticals", async () => {
    const rows = db
      .prepare("SELECT * FROM vertical WHERE status<>'deleted' ORDER BY sort_order, id")
      .all() as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({ ...row, config: parseJson(row.config_json) })),
      total: rows.length,
    };
  });

  app.post<{ Body: Json }>("/api/v1/verticals", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const code = text(body.code).trim();
    const name = text(body.name).trim();
    if (!code) return reply.code(422).send({ detail: "code is required" });
    if (!name) return reply.code(422).send({ detail: "name is required" });
    if (db.prepare("SELECT id FROM vertical WHERE tenant_id=1 AND code=?").get(code)) {
      return reply.code(409).send({ detail: "品类编码已存在" });
    }
    const config = body.config_json ?? body.config;
    const row = db
      .prepare(
        "INSERT INTO vertical(tenant_id,code,name,config_json,sort_order,status) VALUES (1,?,?,?,?,?) RETURNING *",
      )
      .get(
        code,
        name,
        typeof config === "string" ? config : JSON.stringify(config ?? {}),
        int(body.sort_order, 0),
        text(body.status, "enabled"),
      ) as Record<string, unknown>;
    return reply.code(201).send({ ...row, config: parseJson(row.config_json) });
  });

  app.put<{ Params: { id: string }; Body: Json }>("/api/v1/verticals/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const current = db.prepare("SELECT * FROM vertical WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ detail: "品类不存在" });
    const body = request.body ?? {};
    const config = body.config_json ?? body.config;
    const row = db
      .prepare(
        "UPDATE vertical SET name=?,config_json=?,sort_order=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *",
      )
      .get(
        text(body.name, String(current.name)),
        config === undefined
          ? String(current.config_json)
          : typeof config === "string"
            ? config
            : JSON.stringify(config),
        body.sort_order === undefined ? Number(current.sort_order) : int(body.sort_order),
        text(body.status, String(current.status)),
        id,
      ) as Record<string, unknown>;
    return { ...row, config: parseJson(row.config_json) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/verticals/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const used = db.prepare("SELECT COUNT(*) c FROM employer WHERE vertical_id=?").get(id) as { c: number };
    if (Number(used.c) > 0) {
      return reply.code(409).send({ detail: "该品类下还有招工方，不能删除", blocking: { employers: used.c } });
    }
    const result = db.prepare("DELETE FROM vertical WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "品类不存在" });
  });

  // ── 位置树 ──────────────────────────────────────────────────────
  app.get<{ Querystring: { level?: string; parent_id?: string } }>("/api/v1/locations", async (request) => {
    const conditions: string[] = ["status<>'deleted'"];
    const params: Array<string | number> = [];
    if (request.query.level) {
      conditions.push("level=?");
      params.push(request.query.level);
    }
    if (request.query.parent_id !== undefined) {
      const parent = int(request.query.parent_id, -1);
      if (parent < 0) {
        conditions.push("parent_id IS NULL");
      } else {
        conditions.push("parent_id=?");
        params.push(parent);
      }
    }
    const rows = db
      .prepare(`SELECT * FROM location WHERE ${conditions.join(" AND ")} ORDER BY level, name`)
      .all(...params) as Array<Record<string, unknown>>;
    return { items: rows, total: rows.length };
  });

  app.post<{ Body: Json }>("/api/v1/locations", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const level = text(body.level).trim();
    const name = text(body.name).trim();
    if (!level) return reply.code(422).send({ detail: "level is required" });
    if (!name) return reply.code(422).send({ detail: "name is required" });
    const parentId = body.parent_id === undefined || body.parent_id === null ? null : int(body.parent_id);
    if (db.prepare("SELECT id FROM location WHERE parent_id IS ? AND level=? AND name=?").get(parentId, level, name)) {
      return reply.code(409).send({ detail: "同级下已有同名位置" });
    }
    const row = db
      .prepare(
        `INSERT INTO location(parent_id,level,name,code,lat,lng,address,walk_guide,image_key,status,data_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      )
      .get(
        parentId,
        level,
        name,
        text(body.code),
        body.lat === undefined || body.lat === null ? null : Number(body.lat),
        body.lng === undefined || body.lng === null ? null : Number(body.lng),
        text(body.address),
        text(body.walk_guide),
        text(body.image_key),
        text(body.status, "enabled"),
        JSON.stringify(parseJson(body.data_json)),
      ) as Record<string, unknown>;
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string }; Body: Json }>("/api/v1/locations/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const current = db.prepare("SELECT * FROM location WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ detail: "位置不存在" });
    const body = request.body ?? {};
    const row = db
      .prepare(
        `UPDATE location SET name=?,code=?,lat=?,lng=?,address=?,walk_guide=?,image_key=?,status=?,
         data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`,
      )
      .get(
        text(body.name, String(current.name)),
        text(body.code, String(current.code)),
        body.lat === undefined ? (current.lat as number | null) : body.lat === null ? null : Number(body.lat),
        body.lng === undefined ? (current.lng as number | null) : body.lng === null ? null : Number(body.lng),
        text(body.address, String(current.address)),
        text(body.walk_guide, String(current.walk_guide)),
        text(body.image_key, String(current.image_key)),
        text(body.status, String(current.status)),
        body.data_json ? JSON.stringify(parseJson(body.data_json)) : String(current.data_json),
        id,
      ) as Record<string, unknown>;
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/v1/locations/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const children = db.prepare("SELECT COUNT(*) c FROM location WHERE parent_id=?").get(id) as { c: number };
    if (Number(children.c) > 0) {
      return reply.code(409).send({ detail: "该位置下还有子级，请先删除子级", blocking: { children: children.c } });
    }
    const employers = db.prepare("SELECT COUNT(*) c FROM employer WHERE location_id=?").get(id) as { c: number };
    if (Number(employers.c) > 0) {
      return reply.code(409).send({ detail: "该位置被招工方引用，不能删除", blocking: { employers: employers.c } });
    }
    const result = db.prepare("DELETE FROM location WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "位置不存在" });
  });

  // ── 招工方 ──────────────────────────────────────────────────────
  app.get<{ Querystring: { vertical_id?: string; status?: string } }>("/api/v1/employers", async (request) => {
    const conditions: string[] = ["status<>'deleted'"];
    const params: Array<string | number> = [];
    if (request.query.vertical_id) {
      conditions.push("vertical_id=?");
      params.push(int(request.query.vertical_id));
    }
    if (request.query.status) {
      conditions.push("status=?");
      params.push(request.query.status);
    }
    const rows = db
      .prepare(`SELECT * FROM employer WHERE ${conditions.join(" AND ")} ORDER BY employer_code`)
      .all(...params) as Array<Record<string, unknown>>;
    const aliasStmt = db.prepare(
      "SELECT alias FROM employer_alias WHERE employer_id=? ORDER BY weight DESC, alias",
    );
    return {
      items: rows.map((row) => ({
        ...row,
        aliases: (aliasStmt.all(Number(row.id)) as Array<{ alias: string }>).map((a) => a.alias),
      })),
      total: rows.length,
    };
  });

  app.post<{ Body: Json }>("/api/v1/employers", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const code = text(body.employer_code).trim();
    const name = text(body.display_name).trim();
    const verticalId = int(body.vertical_id);
    if (!code) return reply.code(422).send({ detail: "employer_code is required" });
    if (!name) return reply.code(422).send({ detail: "display_name is required" });
    if (!verticalId) return reply.code(422).send({ detail: "vertical_id is required" });
    if (!db.prepare("SELECT id FROM vertical WHERE id=?").get(verticalId)) {
      return reply.code(422).send({ detail: "品类不存在" });
    }
    if (db.prepare("SELECT id FROM employer WHERE tenant_id=1 AND employer_code=?").get(code)) {
      return reply.code(409).send({ detail: "招工方编码已存在" });
    }
    const row = db
      .prepare(
        `INSERT INTO employer(tenant_id,vertical_id,employer_code,display_name,short_name,location_id,status,data_json)
         VALUES (1,?,?,?,?,?,?,?) RETURNING *`,
      )
      .get(
        verticalId,
        code,
        name,
        text(body.short_name),
        body.location_id === undefined || body.location_id === null ? null : int(body.location_id),
        text(body.status, "enabled"),
        JSON.stringify(parseJson(body.data_json)),
      ) as Record<string, unknown>;
    const insertAlias = db.prepare(
      "INSERT OR IGNORE INTO employer_alias(employer_id,alias,weight) VALUES (?,?,?)",
    );
    for (const alias of Array.isArray(body.aliases) ? body.aliases : []) {
      const value = text(alias).trim();
      if (value) insertAlias.run(Number(row.id), value, 0);
    }
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string }; Body: Json }>("/api/v1/employers/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const current = db.prepare("SELECT * FROM employer WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ detail: "招工方不存在" });
    const body = request.body ?? {};
    const row = db
      .prepare(
        `UPDATE employer SET display_name=?,short_name=?,location_id=?,status=?,data_json=?,
         updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`,
      )
      .get(
        text(body.display_name, String(current.display_name)),
        text(body.short_name, String(current.short_name)),
        body.location_id === undefined
          ? (current.location_id as number | null)
          : body.location_id === null
            ? null
            : int(body.location_id),
        text(body.status, String(current.status)),
        body.data_json ? JSON.stringify(parseJson(body.data_json)) : String(current.data_json),
        id,
      ) as Record<string, unknown>;
    // 别名全量替换：传了就按传入的来，没传不动
    if (Array.isArray(body.aliases)) {
      db.prepare("DELETE FROM employer_alias WHERE employer_id=?").run(id);
      const insertAlias = db.prepare(
        "INSERT OR IGNORE INTO employer_alias(employer_id,alias,weight) VALUES (?,?,?)",
      );
      for (const alias of body.aliases) {
        const value = text(alias).trim();
        if (value) insertAlias.run(id, value, 0);
      }
    }
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/v1/employers/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const faqs = db.prepare("SELECT COUNT(*) c FROM kb_faq WHERE scope_employer_id=?").get(id) as { c: number };
    if (Number(faqs.c) > 0) {
      return reply.code(409).send({ detail: "该招工方下还有场景问答，请先处理", blocking: { faqs: faqs.c } });
    }
    db.prepare("DELETE FROM employer_alias WHERE employer_id=?").run(id);
    const result = db.prepare("DELETE FROM employer WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "招工方不存在" });
  });

  // ── 场景问答 ────────────────────────────────────────────────────
  app.get<{ Querystring: { vertical_id?: string; scope_level?: string; scope_employer_id?: string } }>(
    "/api/v1/kb-faqs",
    async (request) => {
      const { pageSize, offset } = parsePagination(request.query as Record<string, unknown>);
      const conditions: string[] = ["status<>'deleted'"];
      const params: Array<string | number> = [];
      if (request.query.vertical_id) {
        conditions.push("vertical_id=?");
        params.push(int(request.query.vertical_id));
      }
      if (request.query.scope_level) {
        conditions.push("scope_level=?");
        params.push(request.query.scope_level);
      }
      if (request.query.scope_employer_id) {
        conditions.push("scope_employer_id=?");
        params.push(int(request.query.scope_employer_id));
      }
      const where = conditions.join(" AND ");
      const rows = db
        .prepare(`SELECT * FROM kb_faq WHERE ${where} ORDER BY priority DESC, id LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset) as Array<Record<string, unknown>>;
      const total = Number(
        (db.prepare(`SELECT COUNT(*) c FROM kb_faq WHERE ${where}`).get(...params) as { c: number }).c,
      );
      return {
        items: rows.map((row) => ({
          ...row,
          keywords: parseList(row.keywords),
          media: parseList(row.media),
        })),
        total,
      };
    },
  );

  app.post<{ Body: Json }>("/api/v1/kb-faqs", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const question = text(body.question).trim();
    const answer = text(body.answer).trim();
    if (!question) return reply.code(422).send({ detail: "question is required" });
    if (!answer) return reply.code(422).send({ detail: "answer is required" });
    const scopeLevel = text(body.scope_level, "global");
    if (!["global", "vertical", "city", "employer"].includes(scopeLevel)) {
      return reply.code(422).send({ detail: "scope_level 只能是 global/vertical/city/employer" });
    }
    const scopeEmployerId =
      body.scope_employer_id === undefined || body.scope_employer_id === null
        ? null
        : int(body.scope_employer_id);
    const scopeLocationId =
      body.scope_location_id === undefined || body.scope_location_id === null
        ? null
        : int(body.scope_location_id);
    // scope 与 id 必须配套，否则检索时这一条永远命中不到
    if (scopeLevel === "employer" && !scopeEmployerId) {
      return reply.code(422).send({ detail: "employer 级问答必须指定 scope_employer_id" });
    }
    if (scopeLevel === "city" && !scopeLocationId) {
      return reply.code(422).send({ detail: "city 级问答必须指定 scope_location_id" });
    }
    const row = db
      .prepare(
        `INSERT INTO kb_faq(tenant_id,vertical_id,scope_level,scope_location_id,scope_employer_id,
          question,keywords,answer,media,priority,status,template_item_id)
         VALUES (1,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      )
      .get(
        body.vertical_id === undefined || body.vertical_id === null ? null : int(body.vertical_id),
        scopeLevel,
        scopeLocationId,
        scopeEmployerId,
        question,
        JSON.stringify(Array.isArray(body.keywords) ? body.keywords : []),
        answer,
        JSON.stringify(Array.isArray(body.media) ? body.media : []),
        int(body.priority, 0),
        text(body.status, "enabled"),
        body.template_item_id === undefined || body.template_item_id === null
          ? null
          : int(body.template_item_id),
      ) as Record<string, unknown>;
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string }; Body: Json }>("/api/v1/kb-faqs/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    const current = db.prepare("SELECT * FROM kb_faq WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!current) return reply.code(404).send({ detail: "问答不存在" });
    const body = request.body ?? {};
    // 运营手工改过的条目默认断开模板关联，否则下次模板升级会被覆盖；
    // 显式传 keep_template_link=true 才保留。
    const keepTemplateLink = body.keep_template_link === true;
    const row = db
      .prepare(
        `UPDATE kb_faq SET question=?,keywords=?,answer=?,media=?,priority=?,status=?,
         template_item_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`,
      )
      .get(
        text(body.question, String(current.question)),
        Array.isArray(body.keywords) ? JSON.stringify(body.keywords) : String(current.keywords),
        text(body.answer, String(current.answer)),
        Array.isArray(body.media) ? JSON.stringify(body.media) : String(current.media),
        body.priority === undefined ? Number(current.priority) : int(body.priority),
        text(body.status, String(current.status)),
        keepTemplateLink ? Number(current.template_item_id ?? 0) || null : null,
        id,
      ) as Record<string, unknown>;
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/v1/kb-faqs/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const result = db.prepare("DELETE FROM kb_faq WHERE id=?").run(int(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "问答不存在" });
  });

  // ── 模板包 ──────────────────────────────────────────────────────
  app.get("/api/v1/kb-templates", async () => {
    const rows = db.prepare("SELECT * FROM kb_template ORDER BY code").all() as Array<Record<string, unknown>>;
    const countStmt = db.prepare("SELECT COUNT(*) c FROM kb_template_item WHERE template_id=?");
    return {
      items: rows.map((row) => ({
        ...row,
        item_count: Number((countStmt.get(Number(row.id)) as { c: number }).c),
      })),
      total: rows.length,
    };
  });

  app.get<{ Params: { code: string } }>("/api/v1/kb-templates/:code", async (request, reply) => {
    const template = db.prepare("SELECT * FROM kb_template WHERE code=?").get(request.params.code) as
      | Record<string, unknown>
      | undefined;
    if (!template) return reply.code(404).send({ detail: "模板不存在" });
    const items = db
      .prepare("SELECT * FROM kb_template_item WHERE template_id=? ORDER BY sort_order, id")
      .all(Number(template.id)) as Array<Record<string, unknown>>;
    return {
      ...template,
      items: items.map((row) => ({
        ...row,
        keywords: parseList(row.keywords),
        media: parseList(row.media),
      })),
    };
  });

  // 一键导入：模板项 → 租户的 kb_faq。
  // 已存在同 question 的跳过，不覆盖运营改过的内容。
  app.post<{ Params: { code: string } }>("/api/v1/kb-templates/:code/import", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const template = db.prepare("SELECT * FROM kb_template WHERE code=?").get(request.params.code) as
      | Record<string, unknown>
      | undefined;
    if (!template) return reply.code(404).send({ detail: "模板不存在" });
    const vertical = db
      .prepare("SELECT id FROM vertical WHERE tenant_id=1 AND code=?")
      .get(String(template.vertical_code)) as { id: number } | undefined;
    if (!vertical) {
      return reply.code(422).send({ detail: `品类 ${template.vertical_code} 不存在，请先建品类` });
    }
    const items = db
      .prepare("SELECT * FROM kb_template_item WHERE template_id=? ORDER BY sort_order, id")
      .all(Number(template.id)) as Array<Record<string, unknown>>;
    const exists = db.prepare(
      "SELECT id FROM kb_faq WHERE tenant_id=1 AND vertical_id IS ? AND scope_level='global' AND question=?",
    );
    const insert = db.prepare(
      `INSERT INTO kb_faq(tenant_id,vertical_id,scope_level,question,keywords,answer,media,priority,status,template_item_id)
       VALUES (1,?,'global',?,?,?,?,?,'enabled',?)`,
    );
    let imported = 0;
    let skipped = 0;
    for (const item of items) {
      if (exists.get(vertical.id, String(item.question))) {
        skipped += 1;
        continue;
      }
      insert.run(
        vertical.id,
        String(item.question),
        String(item.keywords),
        String(item.answer),
        String(item.media),
        Number(item.priority ?? 0),
        item.id as number,
      );
      imported += 1;
    }
    return { success: true, imported, skipped, template: template.code };
  });
}

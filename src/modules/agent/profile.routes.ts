import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";

/**
 * 候选人档案接口（4222 侧写入/读取）。
 *
 * 语义见 docs/候选人档案契约.md：
 * - 档案必须落到 4222 的 agent_conversations，前端（Vue 产物）不做任何改动；
 * - POST 幂等 + 部分更新：profile 里出现的键才覆盖，没出现的保持原值；
 * - 有 interview_date -> recruit_status='invited' / state='pending_invite'，并 upsert 一条
 *   candidate_events(event_type='invited') 供 /agent/candidates 展示；
 * - stage='gave_up' -> recruit_status='disqualified'，candidate_events 记 'disqualified'。
 *
 * 鉴权有两条路：正常用户 token（server.ts 的 preHandler 已解析成 request.auth），
 * 或服务间调用的 X-Profile-Token（与 REA_PROFILE_TOKEN 常数时间比较）。
 */

/** 档案里可以直接同步到 agent_conversations 列的键。 */
const COLUMN_FIELDS = ["name", "phone", "factory_name", "interview_date", "interview_time", "province", "city", "district"] as const;
type ColumnField = (typeof COLUMN_FIELDS)[number];

interface ConversationRow {
  id: number;
  device_code: string;
  customer_id: number;
  nickname: string;
  state: string;
  recruit_status: string;
  province: string;
  city: string;
  district: string;
  name: string;
  phone: string;
  remark: string;
  factory_name: string;
  interview_date: string;
  interview_time: string;
  profile_json: string;
  updated_at: string;
}

/**
 * 常数时间比较：长度不同直接 false（timingSafeEqual 在长度不等时会抛错），
 * 长度相同再逐字节比较，避免用 `===` 泄漏前缀信息。
 */
export function isProfileTokenValid(supplied: unknown, expected = process.env.REA_PROFILE_TOKEN ?? ""): boolean {
  if (!expected) return false; // 未配置 REA_PROFILE_TOKEN 时该通道整体关闭
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const actual = Buffer.from(supplied, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

/** 用户 token 或 X-Profile-Token，二选一通过即可。 */
export function authorizeProfileRequest(request: FastifyRequest): boolean {
  if (request.auth) return true;
  return isProfileTokenValid(request.headers["x-profile-token"]);
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function findConversation(db: DatabaseSync, deviceCode: string, customerId: string, externalId: string): ConversationRow | undefined {
  if (customerId) {
    const numeric = Number(customerId);
    if (!Number.isSafeInteger(numeric)) return undefined;
    const byCustomer = db.prepare("SELECT * FROM agent_conversations WHERE device_code=? AND customer_id=?").get(deviceCode, numeric) as ConversationRow | undefined;
    if (byCustomer) return byCustomer;
  }
  if (externalId) {
    // 外部会话 id 由渠道侧生成（微信客服 / 8090），比 device_code 更可靠，不再叠加设备条件。
    return db.prepare("SELECT * FROM agent_conversations WHERE external_conversation_id=? ORDER BY id LIMIT 1").get(externalId) as ConversationRow | undefined;
  }
  return undefined;
}

/**
 * candidate_events 没有 (device_code,customer_id,event_type) 唯一约束，用「先查后写」实现 upsert：
 * 同一个人同一事件类型只保留一条，反复推送只更新时间/字段，不会在候选人页堆重复行。
 */
function upsertCandidateEvent(db: DatabaseSync, row: ConversationRow, eventType: "invited" | "disqualified", fields: Record<string, string>) {
  const existing = db.prepare("SELECT id FROM candidate_events WHERE device_code=? AND customer_id=? AND event_type=? ORDER BY id DESC LIMIT 1")
    .get(row.device_code, String(row.customer_id), eventType) as { id: number } | undefined;
  const status = eventType;
  // 空值不覆盖：8090 的档案是「部分更新」，这次没带省/区县/厂名不代表要清空，
  // 直接写空串会把之前收集到的信息冲掉（OA 页面上表现为字段时有时无）。
  const keep = (incoming: string | undefined, fallback = "") => {
    const value = String(incoming ?? "").trim();
    return value !== "" ? value : fallback;
  };
  const values = [
    keep(fields.nickname, row.nickname),
    keep(fields.name),
    keep(fields.phone),
    keep(fields.interview_date),
    keep(fields.interview_time),
    keep(fields.factory_name),
    keep(fields.province),
    keep(fields.city),
    keep(fields.district),
    status,
  ];
  if (existing) {
    // COALESCE(NULLIF(?, ''), 列) —— 新值非空才覆盖，空则保留库里已有的
    db.prepare(`UPDATE candidate_events SET nickname=COALESCE(NULLIF(?,''),nickname),name=COALESCE(NULLIF(?,''),name),
        phone=COALESCE(NULLIF(?,''),phone),interview_date=COALESCE(NULLIF(?,''),interview_date),
        interview_time=COALESCE(NULLIF(?,''),interview_time),factory_name=COALESCE(NULLIF(?,''),factory_name),
        province=COALESCE(NULLIF(?,''),province),city=COALESCE(NULLIF(?,''),city),district=COALESCE(NULLIF(?,''),district),
        status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(...values, existing.id);
    return existing.id;
  }
  const inserted = db.prepare(`INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,event_at,name,phone,interview_date,interview_time,factory_name,province,city,district,status,data_json)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.device_code, String(row.customer_id), values[0], eventType, values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8], status, JSON.stringify({ source: "profile", customer_id: row.customer_id }));
  return Number(inserted.lastInsertRowid);
}

/**
 * 「沟通中」事件（Task：collect 沟通中显示）：8090 一进 collect 阶段就推
 * {"stage":"collect"}，这里给候选人页建一条 event_type='communicating'、
 * status='pending'。与 invited 的 upsert 不同：**已存在就不动**——
 * 反复推送不刷新时间，避免「沟通中」排序被顶到最上面。
 */
function ensureCommunicatingEvent(db: DatabaseSync, row: ConversationRow): number {
  const existing = db.prepare("SELECT id FROM candidate_events WHERE device_code=? AND customer_id=? AND event_type='communicating' ORDER BY id DESC LIMIT 1")
    .get(row.device_code, String(row.customer_id)) as { id: number } | undefined;
  if (existing) return existing.id;
  const inserted = db.prepare(`INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,event_at,status,data_json)
    VALUES (?,?,?,'communicating',CURRENT_TIMESTAMP,'pending',?)`)
    .run(row.device_code, String(row.customer_id), row.nickname, JSON.stringify({ source: "profile", customer_id: row.customer_id, stage: "collect" }));
  return Number(inserted.lastInsertRowid);
}

/** 拿到姓名电话建 invited 事件时，把还在「沟通中」的事件推进到已转化。 */
function convertCommunicatingEvents(db: DatabaseSync, row: ConversationRow) {
  db.prepare("UPDATE candidate_events SET status='converted',updated_at=CURRENT_TIMESTAMP WHERE device_code=? AND customer_id=? AND event_type='communicating' AND status='pending'")
    .run(row.device_code, String(row.customer_id));
}

export async function registerProfileRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.post<{ Body: { device_code?: unknown; customer_id?: unknown; external_conversation_id?: unknown; profile?: unknown } }>("/api/v1/agent/profile", async (request, reply) => {
    if (!authorizeProfileRequest(request)) return reply.code(403).send({ detail: "Not authenticated" });

    const body = request.body ?? {};
    const deviceCode = asText(body.device_code).trim();
    const customerId = asText(body.customer_id).trim();
    const externalId = asText(body.external_conversation_id).trim();
    if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
    if (!customerId && !externalId) return reply.code(422).send({ detail: "customer_id or external_conversation_id is required" });
    const incoming = body.profile;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return reply.code(422).send({ detail: "profile is required" });
    // 用户 token 仍受设备范围约束；X-Profile-Token（8090 服务间）不走范围校验。
    if (request.auth && !canAccessDevice(getUserScope(db, request.auth), deviceCode)) return reply.code(403).send({ detail: "Device scope required" });

    const conversation = findConversation(db, deviceCode, customerId, externalId);
    if (!conversation) {
      // 契约：定位不到就 404，绝不新建会话（新建是入站消息的职责）。
      return reply.code(404).send({ detail: "conversation not found" });
    }

    const profile = incoming as Record<string, unknown>;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(profile, key);
    const merged: Record<ColumnField, string> = {
      name: conversation.name ?? "",
      phone: conversation.phone ?? "",
      factory_name: conversation.factory_name ?? "",
      interview_date: conversation.interview_date ?? "",
      interview_time: conversation.interview_time ?? "",
      province: conversation.province ?? "",
      city: conversation.city ?? "",
      district: conversation.district ?? "",
    };
    for (const field of COLUMN_FIELDS) {
      if (has(field)) merged[field] = asText(profile[field]);
    }
    // 备注：契约里 8090 送的是 notes，前端读的是 remark 列，这里映射一次。
    let remark = conversation.remark ?? "";
    if (has("remark")) remark = asText(profile.remark);
    else if (has("notes")) remark = asText(profile.notes);

    const profileJson = { ...parseJson(conversation.profile_json ?? "{}"), ...profile };

    const gaveUp = asText(profile.stage) === "gave_up";
    // 只有本次推送真的带了面试日期才切 invited：否则一次「只改备注」的推送会把
    // 已经 disqualified 的候选重新拉回面试队列。
    const invited = !gaveUp && has("interview_date") && merged.interview_date.trim() !== "";
    let recruitStatus = conversation.recruit_status;
    let state = conversation.state;
    if (gaveUp) recruitStatus = "disqualified";
    else if (invited) {
      recruitStatus = "invited";
      state = "pending_invite";
    }

    db.prepare(`UPDATE agent_conversations SET name=?,phone=?,remark=?,factory_name=?,interview_date=?,interview_time=?,profile_json=?,province=?,city=?,district=?,recruit_status=?,state=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(merged.name, merged.phone, remark, merged.factory_name, merged.interview_date, merged.interview_time, JSON.stringify(profileJson), merged.province, merged.city, merged.district, recruitStatus, state, conversation.id);

    const row: ConversationRow = { ...conversation, ...merged, remark, recruit_status: recruitStatus, state };
    const eventFields = {
      nickname: conversation.nickname,
      name: merged.name,
      phone: merged.phone,
      interview_date: merged.interview_date,
      interview_time: merged.interview_time,
      factory_name: merged.factory_name,
      province: merged.province,
      city: merged.city,
      district: merged.district,
    };
    if (gaveUp) upsertCandidateEvent(db, row, "disqualified", eventFields);
    else if (invited) {
      upsertCandidateEvent(db, row, "invited", eventFields);
      // 沟通中 → 已约面：invited 建好的同一推送里把 pending 的 communicating 收尾
      convertCommunicatingEvents(db, row);
    } else if (asText(profile.stage) === "collect") {
      // collect 阶段只建「沟通中」；部分更新语义不受影响，profile 照常合并
      ensureCommunicatingEvent(db, row);
    }

    return { ok: true, customer_id: String(conversation.customer_id), recruit_status: recruitStatus };
  });

  app.get<{ Querystring: { device_code?: string; customer_id?: string; external_conversation_id?: string } }>("/api/v1/agent/profile", async (request, reply) => {
    if (!authorizeProfileRequest(request)) return reply.code(403).send({ detail: "Not authenticated" });

    const deviceCode = asText(request.query.device_code).trim();
    const customerId = asText(request.query.customer_id).trim();
    const externalId = asText(request.query.external_conversation_id).trim();
    if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
    if (!customerId && !externalId) return reply.code(422).send({ detail: "customer_id or external_conversation_id is required" });
    if (request.auth && !canAccessDevice(getUserScope(db, request.auth), deviceCode)) return reply.code(403).send({ detail: "Device scope required" });

    const row = findConversation(db, deviceCode, customerId, externalId);
    if (!row) return reply.code(404).send({ detail: "conversation not found" });

    const profile = parseJson(row.profile_json ?? "{}");
    return {
      device_code: row.device_code,
      customer_id: String(row.customer_id),
      nickname: row.nickname,
      name: row.name ?? "",
      phone: row.phone ?? "",
      remark: row.remark ?? "",
      factory_name: row.factory_name ?? "",
      interview_date: row.interview_date ?? "",
      interview_time: row.interview_time ?? "",
      province: row.province ?? "",
      city: row.city ?? "",
      district: row.district ?? "",
      recruit_status: row.recruit_status,
      state: row.state,
      profile,
      updated_at: row.updated_at,
    };
  });
}

/**
 * 从名称猜品类：没匹配到 employer 的老数据兜底用。
 * 「深圳地铁安检」不该按工厂处理，卡片标题也不该写「厂名」。
 */
function inferVertical(name: string): string {
  return /地铁|安检/.test(name || "") ? "subway" : "factory";
}

/**
 * 按城市查可推岗位（给 8090 的 flow 用）。
 *
 * 数据源是运营在「城市/工厂/岗位」页维护的三张表，join 出一条可直接念给客户听的
 * 岗位信息；没有数据的字段回空串，由调用方决定兜底。
 *
 * 鉴权：X-Profile-Token（8090 服务间）或正常用户 token，二选一。
 */
export async function registerJobRoutes(app: FastifyInstance, db: DatabaseSync) {
  /**
   * 后台知识库的匹配接口（给 8090 用）。
   *
   * 为什么需要：后台「知识管理 → 知识库」写的是本库的 knowledge_items，
   * 而回复链路读的是 Python 侧的 kb_entry / kb_faq，两张表之间没有任何同步。
   * 运营在网页上填的知识，过去对 AI 回复完全无效。
   *
   * 匹配规则与 Python 侧 keywords_of 保持一致：整句命中或前 2 字片段命中；
   * 关键词字段优先，没配关键词就用标题切词。
   */
  app.get<{ Querystring: { text?: string; city?: string } }>("/api/v1/agent/kb-match", async (request, reply) => {
    if (!authorizeProfileRequest(request) && !request.auth) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const text = String(request.query.text ?? "").trim();
    if (!text) return reply.code(422).send({ detail: "text is required" });
    const cityHint = String(request.query.city ?? "").trim();

    const rows = db.prepare(
      "SELECT id, title, content, data_json FROM knowledge_items WHERE status='enabled' ORDER BY id",
    ).all() as Array<{ id: number; title: string; content: string; data_json: string }>;

    let best: { id: number; title: string; content: string; score: number } | null = null;
    for (const row of rows) {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.data_json || "{}") as Record<string, unknown>; } catch { data = {}; }
      if (data.is_active === false) continue;
      const rowCity = String(data.city ?? "").trim();
      if (rowCity && cityHint && rowCity !== cityHint) continue;

      const declared = Array.isArray(data.keywords)
        ? (data.keywords as unknown[]).map((k) => String(k ?? "").trim()).filter(Boolean)
        : [];
      const title = String(data.question ?? row.title ?? "").trim();
      const words = declared.length ? declared : [title, title.slice(0, 2)].filter((w) => w.length >= 2);
      const hits = words.filter((word) => word.length >= 2 && text.includes(word));
      if (!hits.length) continue;
      const score = hits.reduce((sum, word) => sum + word.length, 0) + (rowCity ? 3 : 0);
      if (!best || score > best.score) {
        best = { id: row.id, title, content: String(row.content ?? ""), score };
      }
    }
    return best ? { hit: best } : { hit: null };
  });

  /**
   * 给 8090 用的城市清单：客户说「我要找北京的工作」时，Python 侧靠它识别城市。
   * 之前城市识别是 flow_engine 里硬编码的 3 个城市，后台新建任何城市都认不出来。
   * 只返回招聘中的城市，带上区县别名（「番禺」「龙华」这类客户常说的小地名）。
   */
  app.get("/api/v1/agent/cities", async (request, reply) => {
    if (!authorizeProfileRequest(request) && !request.auth) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const rows = db.prepare(
      "SELECT city_name, province, data_json FROM cities WHERE recruitment_status='enabled' ORDER BY id",
    ).all() as Array<{ city_name: string; province: string; data_json: string }>;
    const items = rows.map((row) => {
      let districts: string[] = [];
      try {
        const parsed = JSON.parse(row.data_json || "{}") as { districts?: unknown };
        if (Array.isArray(parsed.districts)) {
          districts = parsed.districts.filter((d): d is string => typeof d === "string" && d.trim() !== "");
        }
      } catch { districts = []; }
      return { city_name: row.city_name, province: row.province ?? "", districts };
    });
    return { items, total: items.length };
  });

  app.get<{ Querystring: { city?: string } }>("/api/v1/agent/jobs", async (request, reply) => {
    if (!authorizeProfileRequest(request) && !request.auth) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const city = String((request.query as { city?: string }).city ?? "").trim();
    if (!city) return reply.code(422).send({ detail: "city is required" });

    const rows = db.prepare(
      `SELECT sp.id AS position_id, sp.position_name, sp.data_json AS sp_json, f.factory_name, f.data_json AS f_json,
              c.city_name, c.province,
              v.code AS vertical_code, v.config_json AS vertical_config
       FROM service_positions sp
       LEFT JOIN factories f ON sp.factory_id = f.id
       JOIN cities c ON sp.city_id = c.id
       LEFT JOIN employer e ON e.tenant_id = 1 AND e.display_name = f.factory_name
       LEFT JOIN vertical v ON v.id = e.vertical_id
       WHERE sp.status='enabled' AND (f.status IS NULL OR f.status='enabled') AND c.recruitment_status='enabled'
         AND (c.city_name = ? OR c.city_name LIKE '%' || ? || '%')`
    ).all(city, city) as Array<{
      position_id: number; position_name: string; sp_json: string; factory_name: string;
      f_json: string; city_name: string; province: string;
      vertical_code: string | null; vertical_config: string | null;
    }>;

    const pick = (raw: string): Record<string, string> => {
      try {
        const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
        // POST /service-positions 把整个请求体存进 data_json，真实字段在再嵌一层里
        const nested = parsed.data_json;
        const inner = (nested && typeof nested === "object" ? nested : {}) as Record<string, unknown>;
        const merged = { ...parsed, ...inner } as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(merged)) {
          if (value !== null && value !== undefined && typeof value !== "object") {
            out[key] = String(value);
          }
        }
        return out;
      } catch { return {}; }
    };
    /**
     * 后台「工价与要求」写的是 base_sections（salary_detail / work_hours / meal_dorm …），
     * 而回复层读的是 wage_text / hours_text / welfare_text。过去两者没有任何映射：
     * 表单建的岗位这三个字段全空，job_lookup 把它当「空壳岗位」直接丢掉，AI 永远念不出来。
     * 这里在源头补齐，后台表单不用改。
     */
    const sectionsOf = (raw: string): Record<string, string> => {
      try {
        const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
        const nested = parsed.data_json;
        const inner = (nested && typeof nested === "object" ? nested : {}) as Record<string, unknown>;
        const sections = { ...parsed, ...inner }.base_sections;
        if (!sections || typeof sections !== "object") return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
        }
        return out;
      } catch { return {}; }
    };
    const items = rows.map((row) => {
      const sp = pick(row.sp_json);
      const f = pick(row.f_json);
      const sec = sectionsOf(row.sp_json);
      // 品类决定卡片长什么样：工厂显示「厂名/工价/吃住」，地铁显示「线路/薪资/身高/安排线路」。
      // 之前卡片标签写死成工厂的形状，地铁的「安排线路」只能挤进「吃住」那一行。
      let verticalConfig: Record<string, unknown> = {};
      try {
        verticalConfig = JSON.parse(row.vertical_config || "{}") as Record<string, unknown>;
      } catch { verticalConfig = {}; }
      const schema = Array.isArray(verticalConfig.position_schema)
        ? (verticalConfig.position_schema as Array<{ key?: string; label?: string }>)
            .filter((field) => typeof field?.key === "string" && typeof field?.label === "string")
            .map((field) => ({ key: String(field.key), label: String(field.label) }))
        : [];
      return {
        // 岗位 data_json 里的所有字段原样透出，再被下面规范化过的同名字段覆盖。
        //
        // 为什么要全透：知识库模板用了 {medical} {tattoo_policy} {dorm}
        // {insurance} {regular} {advance} {relocate_policy} 等占位符，
        // 而这里过去只挑 12 个字段，其余一律丢掉 → render() 填不上值 →
        // 整句被丢弃 → 客户问「要不要体检」得到空回复。
        // 运营在后台填的新字段也不该再改一次代码才能生效。
        ...sp,
        position_id: row.position_id,
        factory_name: row.factory_name,
        job_title: row.position_name,
        // 品类：没有匹配到 employer 时按名字猜（地铁/安检 → 地铁），再不行按工厂
        vertical_code: row.vertical_code ?? inferVertical(row.factory_name),
        // 「厂名」还是「线路」，由品类配置给，不再写死
        employer_label: String(verticalConfig.employer_label ?? "厂名"),
        position_schema: schema,
        // 优先用岗位上的独立字段（回填 SQL 写的），没有就取后台表单填的 base_sections
        wage_text: String(sp.wage_text || sec.salary_detail || sec.salary_ask || ""),
        hours_text: String(sp.hours_text || sec.work_hours || sec.shift_info || ""),
        age_text: String(sp.age_text || sp.age_range || ""),
        welfare_text: String(sp.welfare_text || sec.meal_dorm || ""),
        // 地铁特有字段：之前没透出，导致「安排线路/身高/月休/民族限制」只能塞进吃住
        rest_text: String(sp.rest_text ?? ""),
        height_text: String(sp.height_text ?? ""),
        line_text: String(sp.line_text ?? ""),
        ethnicity_policy: String(sp.ethnicity_policy ?? ""),
        cert_text: String(sp.cert_text ?? ""),
        place: String(sp.place ?? f.place ?? row.factory_name),
        interview_time: String(sp.interview_time ?? f.interview_time ?? ""),
        province: row.province ?? "",
        city: row.city_name,
      };
    });
    return { items };
  });
}

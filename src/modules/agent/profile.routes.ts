import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import { deviceFactoryIds, loadFactories } from "../../shared/device-factories.js";
import { mediaAssetsByNames, parsePositionMedia, resolveMediaRefs, type ResolvedMedia } from "../../shared/media-assets.js";

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
  const values = [
    fields.nickname ?? row.nickname,
    fields.name ?? "",
    fields.phone ?? "",
    fields.interview_date ?? "",
    fields.interview_time ?? "",
    fields.factory_name ?? "",
    fields.province ?? "",
    fields.city ?? "",
    fields.district ?? "",
    status,
  ];
  if (existing) {
    db.prepare(`UPDATE candidate_events SET nickname=?,name=?,phone=?,interview_date=?,interview_time=?,factory_name=?,province=?,city=?,district=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
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
   * 给 8090 用的城市清单：客户说「我要找北京的工作」时，Python 侧靠它识别城市。
   * 之前城市识别是 flow_engine 里硬编码的 3 个城市，后台新建任何城市都认不出来。
   * 只返回招聘中的城市，带上区县别名（「番禺」「龙华」这类客户常说的小地名）。
   */
  app.get<{ Querystring: { device_code?: string } }>("/api/v1/agent/cities", async (request, reply) => {
    if (!authorizeProfileRequest(request) && !request.auth) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const rows = db.prepare(
      "SELECT id, city_name, province, data_json FROM cities WHERE recruitment_status IN ('enabled','active') ORDER BY id",
    ).all() as Array<{ id: number; city_name: string; province: string; data_json: string }>;
    // 周边城市：后台「周边城市设置」配的关系。主城查不到岗位时 Python 侧按这个列表兜底，
    // 过去这张表只有管理页自己读写，招聘链路里没有任何消费方。
    const linkRows = db.prepare(
      `SELECT s.city_name AS city, t.city_name AS neighbor
         FROM city_links l
         JOIN cities s ON s.id = l.city_id
         JOIN cities t ON t.id = l.linked_city_id
        ORDER BY s.city_name, t.city_name`,
    ).all() as Array<{ city: string; neighbor: string }>;
    const neighborsByCity = new Map<string, string[]>();
    for (const row of linkRows) {
      const list = neighborsByCity.get(row.city) ?? [];
      list.push(row.neighbor);
      neighborsByCity.set(row.city, list);
    }
    const items = rows.map((row) => {
      let districts: string[] = [];
      try {
        const parsed = JSON.parse(row.data_json || "{}") as { districts?: unknown };
        if (Array.isArray(parsed.districts)) {
          districts = parsed.districts.filter((d): d is string => typeof d === "string" && d.trim() !== "");
        }
      } catch { districts = []; }
      return {
        city_name: row.city_name,
        province: row.province ?? "",
        districts,
        neighbors: neighborsByCity.get(row.city_name) ?? [],
      };
    });
    // 设备 → 工厂多选绑定（契约 §5）：绑了厂就只返回这些厂所在城市，
    // 让 8090 的城市识别不会把设备根本接不了的城市的岗拿出来问。
    // 没传 device_code / 设备不存在 / 没绑厂 → 原逻辑（全量城市）不变。
    const citiesDeviceCode = String(request.query.device_code ?? "").trim();
    if (citiesDeviceCode) {
      const boundFactoryIds = deviceFactoryIds(db, citiesDeviceCode);
      if (boundFactoryIds.length) {
        const boundCities = new Set(loadFactories(db, boundFactoryIds).map((factory) => factory.city_name).filter((name) => name !== ""));
        const filtered = items.filter((item) => boundCities.has(item.city_name));
        return { items: filtered, total: filtered.length };
      }
    }
    return { items, total: items.length };
  });

  app.get<{ Querystring: { city?: string; device_code?: string } }>("/api/v1/agent/jobs", async (request, reply) => {
    if (!authorizeProfileRequest(request) && !request.auth) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const city = String((request.query as { city?: string }).city ?? "").trim();
    if (!city) return reply.code(422).send({ detail: "city is required" });

    // 城市「在招」状态的取值不统一：历史数据是 'active'
    // （response-serializers 的默认值），而 POST /cities 新建时默认写 'enabled'。
    // 只认 'enabled' 会让存量城市全部查不到岗位 → Python 侧每轮都走
    // 「已记下，我帮你问问」，自动回复形同停摆（2026-11-14 实测复现）。
    // 招聘链路必须两种都认；上面 /agent/cities 与下面周边城市兜底同理。
    //
    // 设备 → 工厂多选绑定（契约 §4）：设备绑了厂就只出这些厂的岗，避免拿 A 厂
    // 的号去说 B 厂的待遇。没传 device_code / 设备不存在 / 没绑厂 → 原逻辑不变，
    // 客户端绝不能因为没绑厂就收不到岗位。
    const deviceCode = String(request.query.device_code ?? "").trim();
    const boundFactoryIds = deviceCode ? deviceFactoryIds(db, deviceCode) : [];
    // id 列表只拼占位符，值全部走参数绑定。
    const factoryClause = boundFactoryIds.length
      ? `\n         AND sp.factory_id IN (${boundFactoryIds.map(() => "?").join(",")})`
      : "";
    const queryJobs = db.prepare(
      `SELECT sp.id AS position_id, sp.position_name, sp.data_json AS sp_json, f.factory_name, f.data_json AS f_json,
              c.city_name, c.province,
              v.code AS vertical_code, v.config_json AS vertical_config
       FROM service_positions sp
       LEFT JOIN factories f ON sp.factory_id = f.id
       JOIN cities c ON sp.city_id = c.id
       LEFT JOIN employer e ON e.tenant_id = 1 AND e.display_name = f.factory_name
       LEFT JOIN vertical v ON v.id = e.vertical_id
       WHERE sp.status='enabled' AND (f.status IS NULL OR f.status='enabled')
         AND c.recruitment_status IN ('enabled','active')
         AND (c.city_name = ? OR c.city_name LIKE '%' || ? || '%')${factoryClause}`
    );
    const queryArgs = (cityName: string): Array<string | number> =>
      boundFactoryIds.length ? [cityName, cityName, ...boundFactoryIds] : [cityName, cityName];
    type JobRow = {
      position_id: number; position_name: string; sp_json: string; factory_name: string;
      f_json: string; city_name: string; province: string;
      vertical_code: string | null; vertical_config: string | null;
    };
    const rows = queryJobs.all(...queryArgs(city)) as JobRow[];

    /**
     * 主城查不到岗位时，按后台「周边城市设置」再查一次（东莞没单 → 推广州）。
     * 过去 city_links 只有管理页自己读写，招聘链路里没有任何消费方；
     * 返回里带上 cross_city，让回复层知道「这是隔壁城市的岗」，话术要说明。
     */
    let crossCity = "";
    if (!rows.length) {
      const neighborRows = db.prepare(
        `SELECT t.city_name AS neighbor
           FROM city_links l
           JOIN cities s ON s.id = l.city_id
           JOIN cities t ON t.id = l.linked_city_id
          WHERE (s.city_name = ? OR s.city_name LIKE '%' || ? || '%')
            AND t.recruitment_status IN ('enabled','active')
          ORDER BY t.city_name`,
      ).all(city, city) as Array<{ neighbor: string }>;
      for (const { neighbor } of neighborRows) {
        const neighborJobs = queryJobs.all(...queryArgs(neighbor)) as JobRow[];
        if (neighborJobs.length) {
          rows.push(...neighborJobs);
          crossCity = neighbor;
          break;
        }
      }
    }


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
    /**
     * 岗位媒体（契约 §4）：来源是 service_positions.data_json.media（[{name,kind}]），
     * 这里按 media_assets 补 sha256；查不到的资源直接丢弃，否则会把必然 404 的
     * 名字交给客户端，回复层念了图却没有文件。
     *
     * pick() 只透标量、数组会被它丢掉，所以媒体不能走 pick，单独解析。
     */
    const mediaByPosition = new Map<number, ResolvedMedia[]>();
    {
      const refsByPosition = new Map<number, ReturnType<typeof parsePositionMedia>>();
      const names: string[] = [];
      for (const row of rows) {
        const refs = parsePositionMedia(row.sp_json);
        refsByPosition.set(row.position_id, refs);
        for (const ref of refs) names.push(ref.name);
      }
      const assets = mediaAssetsByNames(db, names);
      for (const [positionId, refs] of refsByPosition) {
        mediaByPosition.set(positionId, resolveMediaRefs(refs, assets));
      }
    }
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
        // 主城没单、按后台周边城市兜底取到的岗：回复层要说清「这是隔壁城市的」
        cross_city: crossCity !== "",
        // 岗位配图/视频：与话术里的【图片:xxx】对应，客户端按 name 下载本地缓存
        media: mediaByPosition.get(row.position_id) ?? [],
      };
    });
    return { items, cross_city: crossCity, asked_city: city };
  });
}

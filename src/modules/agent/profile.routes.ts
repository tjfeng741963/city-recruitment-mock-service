import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import { deviceFactoryIds, loadFactories } from "../../shared/device-factories.js";
import { mediaAssetsByNames, parsePositionMedia, resolveMediaRefs, type ResolvedMedia } from "../../shared/media-assets.js";
import { createMessageChannelProvider } from "../messaging/message-channel-provider.js";
import { DeviceBridgeStore } from "../messaging/device-bridge.js";
import { buildInviteLine, readInviteGroupConfig, sendInviteGroupLine } from "../../shared/invite-group.js";

/**
 * 候选人档案接口（4222 侧写入/读取）。
 *
 * 语义见 docs/候选人档案契约.md：
 * - 档案必须落到 4222 的 agent_conversations，编译后的 Vue 产物不做改动；
 * - POST 幂等 + 部分更新：profile 里出现的键才覆盖，没出现的保持原值；
 * - 同意邀约且城市/工厂/姓名/有效手机齐全 -> invited，并 upsert 一条
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
  const existing = db.prepare("SELECT id,data_json,status FROM candidate_events WHERE device_code=? AND customer_id=? AND event_type=? ORDER BY id DESC LIMIT 1")
    .get(row.device_code, String(row.customer_id), eventType) as { id: number; data_json: string; status: string } | undefined;
  const data = { ...parseJson(existing?.data_json ?? "{}"), source: "profile", customer_id: row.customer_id,
    ...(fields.registration_text ? { registration_text: fields.registration_text } : {}),
  };
  // 档案同步只补资料，不能把运营已经标记的候选人状态改回初始状态。
  const status = existing?.status || eventType;
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
    db.prepare(`UPDATE candidate_events SET nickname=?,name=?,phone=?,interview_date=?,interview_time=?,factory_name=?,province=?,city=?,district=?,status=?,data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(...values, JSON.stringify(data), existing.id);
    return existing.id;
  }
  const inserted = db.prepare(`INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,event_at,name,phone,interview_date,interview_time,factory_name,province,city,district,status,data_json)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.device_code, String(row.customer_id), values[0], eventType, values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8], status, JSON.stringify(data));
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
}

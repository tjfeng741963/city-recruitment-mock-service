import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { canAccessDevice, deviceConstraint, getUserScope, type UserScope } from "../../auth/user-scopes.js";
import { parseDeviceData } from "../../shared/device-factories.js";
import { flowLocationOptions, WORK_LOCATION_KEY } from "../../shared/flow-location.js";
import { difyMediaName, type MediaKind } from "../../shared/media-assets.js";
import { replyModeRow } from "../dify/reply-mode-transition.js";
import {
  boundPositions, cancelInvalidRecontacts, parseRecontactParts, queueRecontactBatch, recontactDeviceStatus, recontactJobs, recontactPendingReason,
  recontactPositions, recontactTarget, recontactTargets, recontactTenant, resolveRecontactParts, reviewRecontactJob, setRecontactDevice,
  type RecontactPart, type RecontactTarget,
} from "./recontact.js";

const PREFIX = "/api/v1/recontact";
const DEFAULT_MIN_DAYS = 3;
const PREVIEW_TTL_MS = 15 * 60_000;
const PREVIEW_RETENTION_MS = 24 * 60 * 60_000;
const MAX_BATCH_SIZE = 100;
const stages = ["work_location", "interview_invite"] as const;
type Stage = (typeof stages)[number];
type RuleRow = {
  position_id: number; stage: Stage; enabled: number; wait_minutes: number;
  start_minute: number; end_minute: number; parts_json: string;
};
type TemplateRow = { id: number; position_id: number; name: string; parts_json: string };
type Selection = {
  id: number; nickname: string; device_code: string; position_id: number; reason: string; parts: RecontactPart[];
};
type PreviewItem = { selection: Selection; target?: RecontactTarget; parts?: RecontactPart[]; fingerprint?: string };
type PreviewPayload = { days: number; items: PreviewItem[] };
type BatchResult = { created: number; skipped: Array<{ id: number; reason: string }> };
type PreviewRow = { expires_at: number; payload_json: string; result_json: string | null };

class RecontactRequestError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function scopeFor(db: DatabaseSync, request: FastifyRequest) {
  const user = request.auth;
  if (!user || (user.role !== "admin" && user.role !== "recruiter")) {
    throw new RecontactRequestError(403, "需要招聘管理权限");
  }
  return getUserScope(db, user);
}

function integer(value: unknown, min: number, max: number, label: string) {
  const parsed = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RecontactRequestError(422, `${label}应为 ${min}–${max} 的整数`);
  }
  return parsed;
}

function id(value: unknown, label: string) { return integer(value, 1, Number.MAX_SAFE_INTEGER, label); }

function positionFor(db: DatabaseSync, scope: UserScope, value: unknown) {
  const position = id(value, "岗位编号");
  if (!recontactPositions(db, scope).some(item => item.id === position)) {
    throw new RecontactRequestError(scope.isAdmin ? 404 : 403, "岗位不可用或超出权限");
  }
  return position;
}

function readFilters(db: DatabaseSync, scope: UserScope, request: FastifyRequest) {
  const query = object(request.query);
  const positionId = query.position_id ? positionFor(db, scope, query.position_id) : undefined;
  const deviceCode = query.device_code === undefined || query.device_code === "" ? undefined
    : typeof query.device_code === "string" ? query.device_code.trim() : "";
  if (deviceCode !== undefined && (!deviceCode || !canAccessDevice(scope, deviceCode))) {
    throw new RecontactRequestError(403, "企微账号超出权限");
  }
  return { positionId, deviceCode, query };
}

function readParts(db: DatabaseSync, positionId: number, value: unknown, allowEmpty = false) {
  if (allowEmpty && Array.isArray(value) && !value.length) return [];
  try { return parseRecontactParts(db, positionId, value); }
  catch (error) { throw new RecontactRequestError(422, error instanceof Error ? error.message : "消息内容无效"); }
}

function serializeRule({ parts_json, enabled, ...rule }: RuleRow) {
  return { ...rule, enabled: Boolean(enabled), parts: JSON.parse(parts_json) as RecontactPart[] };
}

function serializeTemplate({ parts_json, ...template }: TemplateRow) {
  return { ...template, parts: JSON.parse(parts_json) as RecontactPart[] };
}

function publicTarget(target: RecontactTarget) {
  const { id, customer_id, device_code, nickname, position_id, last_contact_at, reason } = target;
  return { id, customer_id, device_code, nickname, position_id, last_contact_at, reason };
}

function availableLocations(db: DatabaseSync, positions: { id: number }[]) {
  const read = db.prepare("SELECT data_json FROM service_positions WHERE id=?");
  return positions.flatMap(({ id }) => {
    const data = parseDeviceData(read.get(id)?.data_json);
    const locations = flowLocationOptions(data).map(({ key, name, address }) =>
      ({ position_id: id, key, name, address, mappable: true }));
    const address = typeof data.work_address === "string" ? data.work_address.trim() : "";
    if (address && !locations.some(location => location.key === WORK_LOCATION_KEY)) {
      locations.push({ position_id: id, key: WORK_LOCATION_KEY, name: "岗位工作地点", address, mappable: false });
    }
    return locations;
  });
}

function sameTarget(current: RecontactTarget, previewed: RecontactTarget) {
  return current.tenant_id === previewed.tenant_id && current.account_id === previewed.account_id
    && current.contact_id === previewed.contact_id && current.device_code === previewed.device_code
    && current.position_id === previewed.position_id && current.provider === previewed.provider
    && current.mode_generation === previewed.mode_generation
    && current.baseline_inbound_id === previewed.baseline_inbound_id && current.last_contact_at === previewed.last_contact_at;
}

export function registerRecontactRoutes(app: FastifyInstance, db: DatabaseSync) {
  const templateById = (templateId: number) => db.prepare("SELECT id,position_id,name,parts_json FROM recontact_templates WHERE id=?")
    .get(templateId) as TemplateRow | undefined;
  const accessibleTarget = (scope: UserScope, allowedPositions: Set<number>, conversationId: number, days: number) => {
    const target = recontactTarget(db, conversationId, days);
    return target && canAccessDevice(scope, target.device_code) && allowedPositions.has(target.position_id) ? target : undefined;
  };

  app.get(`${PREFIX}/options`, async request => {
    const scope = scopeFor(db, request);
    const positions = recontactPositions(db, scope);
    const allowed = new Set(positions.map(position => position.id));
    const { sql, values } = deviceConstraint(scope, "json_extract(data_json,'$.device_code')");
    const tenant = recontactTenant(db, scope);
    const devices = db.prepare(`SELECT json_extract(data_json,'$.device_code') AS code,device_name AS name,data_json FROM agent_devices
      WHERE tenant_id=? AND status='enabled' AND length(json_extract(data_json,'$.device_code'))>0${sql} ORDER BY device_name,id`)
      .all(tenant, ...values).map(row => {
        const code = String(row.code);
        const config = parseDeviceData(row.data_json);
        const provider = replyModeRow(db, code)?.effective ?? (config.reply_provider === "dify" ? "dify" : "agent");
        const { enabled, ready } = recontactDeviceStatus(db, code);
        return {
          code, name: String(row.name), position_ids: boundPositions(db, config, provider, tenant).filter(position => allowed.has(position)),
          recontact_enabled: enabled, recontact_account_ready: ready,
        };
      });
    const candidates = db.prepare(`SELECT id,name,kind,position_id,sha256,storage_path FROM media_assets
      WHERE status='enabled' AND kind IN ('image','video') ORDER BY name,id`).all() as
      Array<{ id: number; name: string; kind: MediaKind; position_id: number; sha256: string; storage_path: string }>;
    const assets = candidates.filter(asset => (asset.position_id === 0 || allowed.has(asset.position_id)) && difyMediaName(asset))
      .map(({ name, kind, position_id }) => ({ name, kind, position_id }));
    return { can_edit_rules: scope.isAdmin, positions, devices, assets, locations: availableLocations(db, positions) };
  });

  app.put<{ Params: { code: string } }>(`${PREFIX}/devices/:code`, async request => {
    const scope = scopeFor(db, request);
    const { code } = request.params;
    const { enabled } = object(request.body);
    if (typeof enabled !== "boolean") throw new RecontactRequestError(422, "启停状态无效");
    if (!canAccessDevice(scope, code)) throw new RecontactRequestError(403, "企微账号超出权限");
    const tenant = recontactTenant(db, scope);
    const rows = db.prepare(`SELECT d.tenant_id,b.tenant_id AS bridge_tenant_id FROM agent_devices d
      LEFT JOIN bridge_devices b ON b.device_code=json_extract(d.data_json,'$.device_code')
      WHERE json_extract(d.data_json,'$.device_code')=? LIMIT 2`).all(code);
    if (rows.length !== 1 || rows[0].tenant_id !== tenant || (rows[0].bridge_tenant_id !== null && rows[0].bridge_tenant_id !== tenant)) {
      throw new RecontactRequestError(404, "企微账号不可用");
    }
    if (!setRecontactDevice(db, code, enabled)) throw new RecontactRequestError(409, "当前企微账号未就绪或私聊尚未同步");
    return { enabled };
  });

  app.get(`${PREFIX}/rules`, async request => {
    const position = positionFor(db, scopeFor(db, request), object(request.query).position_id);
    const rows = db.prepare("SELECT * FROM recontact_rules WHERE position_id=? ORDER BY stage DESC").all(position) as unknown as RuleRow[];
    return { items: rows.map(serializeRule) };
  });

  app.put<{ Params: { position_id: string; stage: string } }>(`${PREFIX}/rules/:position_id/:stage`, async request => {
    const scope = scopeFor(db, request);
    if (!scope.isAdmin) throw new RecontactRequestError(403, "仅管理员可编辑岗位规则");
    const position = positionFor(db, scope, request.params.position_id);
    const stage = stages.find(value => value === request.params.stage);
    const draft = object(request.body);
    if (!stage || typeof draft.enabled !== "boolean") throw new RecontactRequestError(422, "触发阶段或启停状态无效");
    const minutes = integer(draft.wait_minutes, 1, 10080, "等待分钟数");
    const start = integer(draft.start_minute, 540, 1259, "开始时间");
    const end = integer(draft.end_minute, 541, 1260, "结束时间");
    if (start >= end) throw new RecontactRequestError(422, "结束时间须晚于开始时间");
    const prior = db.prepare("SELECT * FROM recontact_rules WHERE position_id=? AND stage=?").get(position, stage) as RuleRow | undefined;
    // A disabled rule may retain an existing reference after its media or location has been removed.
    const raw = JSON.stringify(draft.parts);
    const parts = !draft.enabled && prior?.parts_json === raw ? JSON.parse(prior.parts_json) as RecontactPart[]
      : readParts(db, position, draft.parts, !draft.enabled);
    const row = db.prepare(`INSERT INTO recontact_rules(position_id,stage,enabled,wait_minutes,start_minute,end_minute,parts_json,enabled_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(position_id,stage) DO UPDATE SET enabled=excluded.enabled,
      wait_minutes=excluded.wait_minutes,start_minute=excluded.start_minute,end_minute=excluded.end_minute,
      parts_json=excluded.parts_json,enabled_at=CASE WHEN recontact_rules.enabled=0 AND excluded.enabled=1 THEN excluded.enabled_at ELSE recontact_rules.enabled_at END,
      updated_at=CURRENT_TIMESTAMP RETURNING *`)
      .get(position, stage, Number(draft.enabled), minutes, start, end, JSON.stringify(parts),Date.now()) as unknown as RuleRow;
    if (!row.enabled) cancelInvalidRecontacts(db,{positionId:position,stage});
    return { item: serializeRule(row) };
  });

  app.get(`${PREFIX}/templates`, async request => {
    const scope = scopeFor(db, request);
    const requested = object(request.query).position_id;
    const positions = requested === undefined ? recontactPositions(db, scope).map(position => position.id) : [positionFor(db, scope, requested)];
    if (!positions.length) return { items: [] };
    const parameters = positions.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM recontact_templates WHERE position_id IN (${parameters}) ORDER BY position_id,id`)
      .all(...positions) as unknown as TemplateRow[];
    return { items: rows.map(serializeTemplate) };
  });

  const saveTemplate = (request: FastifyRequest, templateId?: number) => {
    const scope = scopeFor(db, request);
    const draft = object(request.body);
    const position = positionFor(db, scope, draft.position_id);
    const name = typeof draft.name === "string" ? draft.name.trim() : "";
    if (!name || name.length > 80) throw new RecontactRequestError(422, "模板名称须为 1–80 个字符");
    const parts = JSON.stringify(readParts(db, position, draft.parts));
    if (!templateId) {
      const row = db.prepare("INSERT INTO recontact_templates(position_id,name,parts_json) VALUES (?,?,?) RETURNING *")
        .get(position, name, parts) as unknown as TemplateRow;
      return { item: serializeTemplate(row) };
    }
    const row = db.prepare("UPDATE recontact_templates SET name=?,parts_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND position_id=? RETURNING *")
      .get(name, parts, templateId, position) as TemplateRow | undefined;
    if (!row) throw new RecontactRequestError(404, "模板不存在");
    return { item: serializeTemplate(row) };
  };

  app.post(`${PREFIX}/templates`, async request => saveTemplate(request));
  app.put<{ Params: { id: string } }>(`${PREFIX}/templates/:id`, async request => saveTemplate(request, id(request.params.id, "模板编号")));

  app.get(`${PREFIX}/candidates`, async request => {
    const scope = scopeFor(db, request);
    const { positionId, deviceCode, query } = readFilters(db, scope, request);
    const days = integer(query.days ?? DEFAULT_MIN_DAYS, 0, 3650, "未联系天数");
    return { items: recontactTargets(db, scope, { positionId, deviceCode, days }).map(publicTarget) };
  });

  app.post(`${PREFIX}/batches/preview`, async request => {
    const scope = scopeFor(db, request);
    const payload = object(request.body);
    const ids = payload.conversation_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH_SIZE) {
      throw new RecontactRequestError(422, `请选择 1–${MAX_BATCH_SIZE} 个会话`);
    }
    const days = integer(payload.days ?? DEFAULT_MIN_DAYS, 0, 3650, "未联系天数");
    const templates = new Map(Object.entries(object(payload.template_ids)).map(([position, template]) =>
      [id(position, "岗位编号"), id(template, "模板编号")]));
    const defaultTemplate = payload.template_id === undefined ? undefined : id(payload.template_id, "模板编号");
    if (!templates.size && defaultTemplate === undefined) throw new RecontactRequestError(422, "请选择复聊模板");
    const positions = new Set(recontactPositions(db, scope).map(position => position.id));
    const items: PreviewItem[] = [...new Set(ids.map(value => id(value, "会话编号")))].map(conversationId => {
      const target = accessibleTarget(scope, positions, conversationId, days);
      const selection: Selection = target ? {
        id: target.id, nickname: target.nickname, device_code: target.device_code, position_id: target.position_id,
        reason: target.reason || recontactPendingReason(db, target), parts: [],
      } : { id: conversationId, nickname: "", device_code: "", position_id: 0, reason: "会话不可用或超出权限", parts: [] };
      if (!target || selection.reason) return { selection };
      const templateId = templates.get(target.position_id) ?? defaultTemplate;
      const template = templateId === undefined ? undefined : templateById(templateId);
      if (!template || template.position_id !== target.position_id) {
        return { selection: { ...selection, reason: "该岗位缺少适用的复聊模板" } };
      }
      try {
        const parts = parseRecontactParts(db, target.position_id, JSON.parse(template.parts_json));
        const resolved = resolveRecontactParts(db, target.position_id, parts);
        selection.parts = resolved.map(({ kind, value, content, delay_ms }) => ({ kind, value: kind === "location" ? content : value, delay_ms }));
        return { selection, target, parts, fingerprint: JSON.stringify(resolved) };
      } catch (error) {
        return { selection: { ...selection, reason: error instanceof Error ? error.message : "模板内容无效" } };
      }
    });
    const token = randomUUID();
    const now = Date.now();
    db.prepare("DELETE FROM recontact_previews WHERE expires_at<?").run(now - PREVIEW_RETENTION_MS);
    db.prepare("INSERT INTO recontact_previews(token,user_id,payload_json,created_at,expires_at) VALUES (?,?,?,?,?)")
      .run(token, scope.userId, JSON.stringify({ days, items } satisfies PreviewPayload), now, now + PREVIEW_TTL_MS);
    return { items: items.map(item => item.selection), token };
  });

  app.post(`${PREFIX}/batches`, async request => {
    const scope = scopeFor(db, request);
    const token = object(request.body).token;
    if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) throw new RecontactRequestError(422, "请先预览待发送名单");
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT expires_at,payload_json,result_json FROM recontact_previews WHERE token=? AND user_id=?")
        .get(token, scope.userId) as PreviewRow | undefined;
      if (!row) throw new RecontactRequestError(404, "发送预览不存在");
      if (row.result_json) {
        const saved = JSON.parse(row.result_json) as BatchResult;
        db.exec("COMMIT");
        return saved;
      }
      if (row.expires_at <= Date.now()) throw new RecontactRequestError(409, "发送预览已过期，请重新预览");
      const payload = JSON.parse(row.payload_json) as PreviewPayload;
      const positions = new Set(recontactPositions(db, scope).map(position => position.id));
      const result: BatchResult = { created: 0, skipped: [] };
      for (const item of payload.items) {
        const previewed = item.target;
        const parts = item.parts;
        let reason = item.selection.reason;
        const current = previewed && parts && accessibleTarget(scope, positions, previewed.id, payload.days);
        if (!reason) {
          if (!current || !previewed || !parts) reason = "会话不可用或超出权限";
          else if (current.baseline_inbound_id !== previewed.baseline_inbound_id) reason = "候选人已回复";
          else if (current.reason) reason = current.reason;
          else if (!sameTarget(current, previewed)) reason = "会话或收件账号已变化";
          else {
            try {
              const resolved = resolveRecontactParts(db, current.position_id, parts);
              if (JSON.stringify(resolved) !== item.fingerprint) reason = "模板引用的素材或地点已变化";
            } catch (error) {
              reason = error instanceof Error ? error.message : "模板引用的素材或地点不可用";
            }
            if (!reason && queueRecontactBatch(db, current, parts, token, previewed.baseline_inbound_id)) result.created++;
            else if (!reason) reason = "已有复聊任务或会话已变化";
          }
        }
        if (reason) result.skipped.push({ id: item.selection.id, reason });
      }
      db.prepare("UPDATE recontact_previews SET result_json=? WHERE token=? AND user_id=?").run(JSON.stringify(result), token, scope.userId);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  app.get(`${PREFIX}/jobs`, async request => {
    const scope = scopeFor(db, request);
    const { positionId, deviceCode, query } = readFilters(db, scope, request);
    const status = typeof query.status === "string" && query.status ? query.status : undefined;
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : undefined;
    return { items: recontactJobs(db, scope, { positionId, deviceCode, status, q }) };
  });

  app.post<{ Params: { id: string } }>(`${PREFIX}/jobs/:id/review`, async request => {
    const scope = scopeFor(db, request);
    const jobId = id(request.params.id, "任务编号");
    const resolution = object(request.body).resolution;
    if (resolution !== "sent" && resolution !== "not_sent" && resolution !== "cancel") {
      throw new RecontactRequestError(422, "核对结果无效");
    }
    if (!reviewRecontactJob(db, jobId, scope, resolution)) throw new RecontactRequestError(409, "任务不可核对或已更新");
    return { ok: true };
  });
}

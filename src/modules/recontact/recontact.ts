import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canAccessCity, canAccessDevice, type UserScope } from "../../auth/user-scopes.js";
import { parseDeviceData, receptionFactoryIds, resolveDevicePosition } from "../../shared/device-factories.js";
import { flowLocationOptions } from "../../shared/flow-location.js";
import { difyMediaName, type MediaKind } from "../../shared/media-assets.js";
import { openingLocationReply } from "../agent/shared-opening.js";
import { replyModePending, replyModeRow } from "../dify/reply-mode-transition.js";
import { isDirectRecipient, readRecipientBinding } from "../messaging/recipient-binding.js";

export type RecontactStage = "work_location" | "interview_invite";
export type RecontactKind = "text" | "image" | "video" | "location";
export type RecontactPart = { kind: RecontactKind; value: string; delay_ms: number };
type ResolvedPart = RecontactPart & { content: string; payload: string };
type Provider = "agent" | "dify";
type Position = { id: number; name: string; tenant_id: number; city_id: number; factory_id: number };
export type RecontactTarget = {
  id: number; customer_id: number; nickname: string; position_id: number; device_code: string;
  tenant_id: number; account_id: string; contact_id: string; provider: Provider; mode_generation: string;
  baseline_inbound_id: number; inbound_at: number; last_contact_at: string; reason: string;
};
type Job = {
  id: number; tenant_id: number; position_id: number; conversation_id: number; customer_id: number;
  device_code: string; account_id: string; contact_id: string; provider: Provider; mode_generation: string;
  source: "auto" | "batch"; stage: RecontactStage | ""; baseline_inbound_id: number;
  status: string; reason: string; due_at: number; created_at: number;
};
type Step = ResolvedPart & {
  job_id: number; seq: number; status: string; reason: string; due_at: number | null;
  confirmed_at: number | null; command_id: string | null;
};

const DAY = 86400_000;
const ZONE_OFFSET = 8 * 3600_000;
const SEND_START = 9 * 60;
const SEND_END = 21 * 60;
const rejected = /^(?:我)?(?:不考虑了|暂时不考虑|不去了|不参加面试|先不面试|不感兴趣|不用联系了|不要再联系我)[。！!\s]*$/u;

export function recontactTenant(db: DatabaseSync, scope: UserScope): number {
  return (db.prepare("SELECT tenant_id FROM users WHERE id=?").get(scope.userId) as { tenant_id: number } | undefined)?.tenant_id ?? 0;
}

function selectedPosition(db: DatabaseSync, id: number, tenant: number): Position | undefined {
  return db.prepare("SELECT id,position_name AS name,tenant_id,city_id,factory_id FROM service_positions WHERE id=? AND tenant_id=? AND status='enabled'")
    .get(id,tenant) as Position | undefined;
}

export function boundPositions(db: DatabaseSync, config: Record<string, unknown>, provider: Provider, tenant: number): number[] {
  const primary = resolveDevicePosition(db, config, provider);
  const factories = receptionFactoryIds(db,config,provider);
  if (provider === "agent" || !factories.length) return primary > 0 ? [primary] : [];
  const positions = db.prepare(`SELECT id FROM service_positions WHERE tenant_id=? AND status='enabled'
    AND factory_id IN (${factories.map(() => "?").join(",")})`).all(tenant,...factories) as Array<{id:number}>;
  return [...new Set([primary, ...positions.map(row => row.id)].filter(id => id > 0))];
}

export function recontactPositions(db: DatabaseSync, scope: UserScope) {
  const tenant = recontactTenant(db,scope);
  const positions = db.prepare("SELECT id,position_name AS name,tenant_id,city_id,factory_id FROM service_positions WHERE tenant_id=? AND status='enabled' ORDER BY position_name,id")
    .all(tenant) as Position[];
  const allowed = new Set<number>();
  if (!scope.isAdmin) {
    for (const row of db.prepare("SELECT data_json FROM agent_devices WHERE tenant_id=? AND status='enabled'").all(tenant)) {
      const cfg = parseDeviceData(row.data_json);
      if (!canAccessDevice(scope, String(cfg.device_code ?? ""))) continue;
      const provider = replyModeRow(db,String(cfg.device_code))?.effective ?? (cfg.reply_provider === "dify" ? "dify" : "agent");
      for (const id of boundPositions(db,cfg,provider,tenant)) allowed.add(id);
    }
  }
  return positions.filter(p => canAccessCity(scope,p.city_id) || allowed.has(p.id)).map(({id,name}) => ({id,name}));
}

export function parseRecontactParts(db: DatabaseSync, positionId: number, input: unknown): RecontactPart[] {
  if (!Array.isArray(input) || !input.length || input.length > 12) throw new Error("请配置 1–12 条消息");
  const parts = input.map((row): RecontactPart => {
    const kind = row?.kind as RecontactKind;
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    const delay = row?.delay_ms;
    if (!["text","image","video","location"].includes(kind) || !value || value.length > 2000
      || !Number.isSafeInteger(delay) || delay < 0 || delay > 600_000) throw new Error("消息内容或间隔无效");
    return {kind,value,delay_ms:delay};
  });
  resolveRecontactParts(db,positionId,parts);
  return parts;
}

export function resolveRecontactParts(db: DatabaseSync, positionId: number, parts: RecontactPart[]): ResolvedPart[] {
  const row = db.prepare("SELECT data_json FROM service_positions WHERE id=? AND status='enabled'").get(positionId);
  const locations = flowLocationOptions(parseDeviceData(row?.data_json));
  return parts.map(part => {
    let content = part.value;
    let payload = content;
    if (part.kind === "location") {
      const point = locations.find(item => item.key === part.value);
      if (!point) throw new Error("地点需要有效的地址和坐标");
      content = openingLocationReply(point);
      payload = content;
    }
    if (part.kind === "image" || part.kind === "video") {
      const asset = db.prepare("SELECT id,kind,storage_path,sha256 FROM media_assets WHERE name=? AND status='enabled' AND kind=? AND position_id IN (0,?)")
        .get(part.value,part.kind,positionId) as {id:number;kind:MediaKind;storage_path:string;sha256:string} | undefined;
      const alias = asset && difyMediaName(asset);
      if (!alias) throw new Error("所选素材已失效或不属于该岗位");
      payload = alias;
    }
    return {...part,content,payload};
  });
}

function stamp(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ","T") + "Z");
}

export function recontactTarget(db: DatabaseSync, id: number, days = 0, now = Date.now()): RecontactTarget | undefined {
  const row = db.prepare(`SELECT c.*, d.data_json, d.status AS device_status, b.account_id,
      m.contact_id, b.tenant_id AS device_tenant
    FROM agent_conversations c JOIN agent_devices d ON json_extract(d.data_json,'$.device_code')=c.device_code AND d.tenant_id=c.tenant_id
    JOIN bridge_devices b ON b.device_code=c.device_code AND b.tenant_id=c.tenant_id
    LEFT JOIN bridge_contacts m ON m.device_code=c.device_code AND m.customer_id=c.customer_id WHERE c.id=?`).get(id) as
    {id:number;customer_id:number;nickname:string;tenant_id:number;device_code:string;account_id:string;contact_id:string;
      data_json:string;device_status:string;external_conversation_id:string;takeover:number;recruit_status:string;state:string} | undefined;
  if (!row) return;
  const {id:conversationId,customer_id,nickname,tenant_id,device_code,account_id,contact_id} = row;
  const cfg = parseDeviceData(row.data_json);
  const mode = replyModeRow(db,device_code);
  const provider = mode?.effective ?? (cfg.reply_provider === "dify" ? "dify" : "agent");
  const mode_generation = mode?.generation ?? "";
  const allowed = boundPositions(db,cfg,provider,tenant_id);
  const identity = createHash("sha256").update(JSON.stringify([device_code,account_id,row.external_conversation_id])).digest("hex");
  const chosen = provider === "dify" ? db.prepare("SELECT position_id FROM dify_recruitment_state WHERE identity=?").get(identity) as {position_id:number|null} | undefined : undefined;
  const position_id = chosen?.position_id ?? resolveDevicePosition(db,cfg,provider);
  const latest = db.prepare(`SELECT id,content,created_at FROM agent_messages WHERE device_code=? AND customer_id=? AND tenant_id=? AND direction='inbound'
    ORDER BY id DESC LIMIT 1`).get(device_code,customer_id,tenant_id) as {id:number;content:string;created_at:string} | undefined;
  const activity = db.prepare(`SELECT created_at FROM agent_messages WHERE device_code=? AND customer_id=? AND tenant_id=?
     AND (direction='inbound' OR (direction='outbound' AND status='sent')) ORDER BY julianday(created_at) DESC,id DESC LIMIT 1`)
    .get(device_code,customer_id,tenant_id) as {created_at:string} | undefined;
  const last_contact_at = activity?.created_at ?? "";
  const binding = contact_id && readRecipientBinding(db,device_code,account_id,contact_id);
  let reason = "";
  if (row.device_status !== "enabled") reason = "账号已停用";
  else if (!contact_id || contact_id !== row.external_conversation_id || !isDirectRecipient(account_id,contact_id) || !nickname.trim()
    || db.prepare("SELECT COUNT(*) AS n FROM agent_conversations WHERE device_code=? AND external_conversation_id=?").get(device_code,contact_id)?.n !== 1
    || (binding && binding.status !== "verified")) reason = "当前企微账号无法核对该私聊";
  else if (replyModePending(db,device_code)) reason = "回复模式正在切换";
  else if (!allowed.includes(position_id) || !selectedPosition(db,position_id,tenant_id)) reason = "岗位已变更或停用";
  else if (row.takeover) reason = "人工已接管";
  else if (row.recruit_status === "disqualified" || row.state === "abandoned" || (latest && rejected.test(latest.content.trim()))) reason = "候选人已拒绝或结束";
  else if (["invited","checked_in","registered"].includes(row.recruit_status) || db.prepare(`SELECT 1 FROM agent_archive WHERE interview_confirmed=1 AND
    ((dify_device_code=? AND dify_conversation_row_id=? AND dify_account_id=?) OR (dify_device_code='' AND session_key=?)) LIMIT 1`)
    .get(device_code,id,account_id,contact_id)) reason = "候选人已报名";
  else if (!latest || !Number.isFinite(stamp(latest.created_at))) reason = "缺少真实来信记录";
  else if (days > 0 && !(now - stamp(last_contact_at) >= days * DAY)) reason = "最近联系时间未达到筛选条件";
  return {id:conversationId,customer_id,nickname,position_id,device_code,tenant_id,account_id,contact_id:contact_id ?? "",
    provider,mode_generation,baseline_inbound_id:latest?.id ?? 0,inbound_at:latest ? stamp(latest.created_at) : 0,last_contact_at,reason};
}

function activeJob(db: DatabaseSync, target: RecontactTarget, own = 0): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM recontact_jobs WHERE tenant_id=? AND account_id=? AND contact_id=?
    AND id<>? AND status IN ('scheduled','sending','unknown')`).get(target.tenant_id,target.account_id,target.contact_id,own));
}

function legacyWait(db: DatabaseSync, target: RecontactTarget, includeCompleted = true): boolean {
  if (target.provider !== "agent") return false;
  const row = db.prepare("SELECT phase,node_key,snapshot_json,last_inbound_at,followup_round FROM agent_conversation_state WHERE device_code=? AND session_key=?")
    .get(target.device_code,target.contact_id) as {phase:string;node_key:string;snapshot_json:string;last_inbound_at:number;followup_round:number} | undefined;
  if (!row) return false;
  if (includeCompleted && row.followup_round > 0 && row.last_inbound_at >= Math.floor(target.inbound_at/1000)) return true;
  if (row.phase === "running" || row.phase === "held") return true;
  if (!["awaiting","followup_due"].includes(row.phase)) return false;
  const snapshot = parseDeviceData(row.snapshot_json);
  if (!Array.isArray(snapshot.edges)) return true;
  return snapshot.edges.some(edge => edge?.trigger === "timeout" && edge.from_key === row.node_key);
}

export function recontactFlowStage(db:DatabaseSync,positionId:number,parts:unknown[]):RecontactStage|undefined {
  const bodies=parts.flatMap(item=>item && typeof item==="object" && "body" in item && typeof item.body==="string" ? [item.body] : []);
  return classifyStage(db,positionId,bodies,"",true);
}

export function recontactTargets(db: DatabaseSync, scope: UserScope, filters: {positionId?:number;deviceCode?:string;days?:number}) {
  const tenant = recontactTenant(db,scope);
  const now = Date.now();
  const positions = new Set(recontactPositions(db,scope).map(p => p.id));
  const rows = db.prepare(`SELECT id,device_code FROM agent_conversations WHERE tenant_id=? AND (?='' OR device_code=?)
    ORDER BY julianday(last_msg_at) DESC,id DESC`).all(tenant,filters.deviceCode ?? "",filters.deviceCode ?? "") as Array<{id:number;device_code:string}>;
  const items: RecontactTarget[] = [];
  for (const row of rows) {
    if (!canAccessDevice(scope,row.device_code)) continue;
    const target = recontactTarget(db,row.id,filters.days ?? 3,now);
    if (!target || !positions.has(target.position_id) || (filters.positionId && filters.positionId !== target.position_id) ||
        !target.last_contact_at || (filters.days && now - stamp(target.last_contact_at) < filters.days * DAY)) continue;
    if (!target.reason) target.reason = recontactPendingReason(db,target);
    items.push(target);
    if (items.length >= 250) break;
  }
  return items;
}

export function recontactPendingReason(db:DatabaseSync,target:RecontactTarget) {
  return activeJob(db,target) || legacyWait(db,target,false) ? "该会话已有跟进任务" : "";
}

function enqueueJob(db: DatabaseSync, target: RecontactTarget, parts: RecontactPart[], origin: string,
  source: Job["source"], stage: Job["stage"], due: number, now: number): number | undefined {
  const steps = resolveRecontactParts(db,target.position_id,parts);
  if (!steps.length || activeJob(db,target)) return;
  db.exec("SAVEPOINT recontact_job");
  try {
    const result = db.prepare(`INSERT OR IGNORE INTO recontact_jobs
     (tenant_id,position_id,conversation_id,customer_id,device_code,account_id,contact_id,provider,mode_generation,
      source,stage,origin_key,baseline_inbound_id,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(target.tenant_id,target.position_id,target.id,target.customer_id,target.device_code,target.account_id,target.contact_id,
        target.provider,target.mode_generation,source,stage,origin,target.baseline_inbound_id,due,now);
    const id = Number(result.lastInsertRowid);
    if (result.changes) {
      const insert = db.prepare("INSERT INTO recontact_steps(job_id,seq,kind,content,value,payload,delay_ms,due_at) VALUES (?,?,?,?,?,?,?,?)");
      for (const [i,step] of steps.entries()) {
        insert.run(id,i+1,step.kind,step.content,step.value,step.payload,step.delay_ms,i === 0 ? due : null);
      }
    }
    db.exec("RELEASE recontact_job");
    return result.changes ? id : undefined;
  } catch (error) {
    db.exec("ROLLBACK TO recontact_job; RELEASE recontact_job");
    throw error;
  }
}

export function queueRecontactBatch(db: DatabaseSync, target: RecontactTarget, parts: RecontactPart[], requestKey: string,
  expectedInboundId: number, now = Date.now()): number | undefined {
  const fresh = recontactTarget(db,target.id,0,now);
  if (!fresh || fresh.reason || fresh.baseline_inbound_id !== expectedInboundId || fresh.last_contact_at !== target.last_contact_at
    || fresh.account_id !== target.account_id || fresh.contact_id !== target.contact_id || fresh.tenant_id !== target.tenant_id
    || fresh.position_id !== target.position_id || fresh.provider !== target.provider || fresh.mode_generation !== target.mode_generation
    || legacyWait(db,fresh,false)) return;
  return enqueueJob(db,fresh,parts,"batch:"+requestKey,"batch","",now,now);
}

function jobSteps(db: DatabaseSync,id:number): Step[] {
  return db.prepare("SELECT * FROM recontact_steps WHERE job_id=? ORDER BY seq").all(id) as unknown as Step[];
}

function getJob(db: DatabaseSync,id:number): Job | undefined {
  return db.prepare("SELECT * FROM recontact_jobs WHERE id=?").get(id) as Job | undefined;
}

type Rule = {enabled:number; wait_minutes:number; start_minute:number; end_minute:number; parts_json:string};
const ruleOf = (db: DatabaseSync,pid:number,stage:string) =>
  db.prepare("SELECT enabled,wait_minutes,start_minute,end_minute,parts_json FROM recontact_rules WHERE position_id=? AND stage=?").get(pid,stage) as Rule | undefined;

function classifyStage(db:DatabaseSync,positionId:number,bodies:string[],question:string,canvas=false):RecontactStage|undefined {
  const position = db.prepare("SELECT data_json FROM service_positions WHERE id=? AND status='enabled'").get(positionId);
  const work = String(parseDeviceData(position?.data_json).work_address ?? "").trim();
  const format = (value:string) => value.normalize("NFKC").replace(/[\s，,。；;：:]/gu,"").trim();
  const asksWork = /在哪(?:里|儿)?上班|上班(?:地点|地址|在哪)|工作(?:地点|地址|在哪)|在哪(?:里|儿)?工作|哪个站上班/u;
  const invite = /(?:要不要|愿不愿意|想不想|能不能|方便|可以约|想约|要约).{0,14}(?:参加|来|去)?面试|(?:来|去)面试.{0,8}(?:吗|方便|可以)/u;
  if (work.length>=2 && (canvas || asksWork.test(question)) && bodies.some(msg=>format(msg).includes(format(work)))
    && ruleOf(db,positionId,"work_location")?.enabled) return "work_location";
  if (bodies.some(msg=>invite.test(msg) && !/不方便|不想|不愿意|不用面试|无需面试|不能面试|已登记|面试已确认/u.test(msg))
    && ruleOf(db,positionId,"interview_invite")?.enabled) return "interview_invite";
}

export function markRecontactAnchor(db:DatabaseSync,input:{
  traceId:string;deviceCode:string;sessionKey:string;positionId:number;provider:Provider;question:string;messages:unknown[];turnId?:string;
}): boolean {
  if (!input.traceId || !input.deviceCode || !input.sessionKey || !input.turnId || !/^\d{1,24}$/.test(input.turnId)) return false;
  const messages = input.messages.flatMap(item => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && "type" in item && item.type === "text" &&
        "content" in item && typeof item.content === "string") return [item.content];
    return [];
  });
  const stage = classifyStage(db,input.positionId,messages,input.question);
  if (!stage || !ruleOf(db,input.positionId,stage)?.enabled) return false;
  const device=db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(input.deviceCode) as {account_id:string} | undefined;
  if (!device || !isDirectRecipient(device.account_id,input.sessionKey)) return false;
  const generation=replyModeRow(db,input.deviceCode)?.generation ?? "";
  const inboundSource=inboundEventSource(input.deviceCode,input.sessionKey,input.turnId);
  db.prepare(`INSERT OR IGNORE INTO recontact_anchors(trace_id,device_code,contact_id,account_id,position_id,mode_generation,provider,inbound_source,stage,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.traceId,input.deviceCode,input.sessionKey,device.account_id,input.positionId,generation,input.provider,inboundSource,stage,Date.now());
  return true;
}

const inboundEventSource = (device:string,contact:string,messageId:string) =>
  "bridge-inbound:"+createHash("sha256").update(JSON.stringify([device,contact+":"+messageId])).digest("hex");

function saveCanvasAnchors(db:DatabaseSync,device:string,now:number) {
  const account=db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(device)?.account_id;
  if (typeof account!=="string" || !account) return;
  const generation=replyModeRow(db,device)?.generation ?? "";
  const rows=db.prepare(`SELECT s.session_key,s.position_id,s.await_since,s.snapshot_json,s.node_key,s.recontact_inbound_id,s.step_index,
      ('canvas:'||json_array(s.device_code,s.session_key,s.recontact_inbound_id,s.node_key)) AS trace_id
    FROM agent_conversation_state s WHERE s.device_code=? AND s.phase IN ('awaiting','followup_due') AND s.followup_round=0
      AND s.recontact_inbound_id<>'' AND s.await_since IS NOT NULL AND julianday(s.await_since)>=julianday(?)
      AND EXISTS (SELECT 1 FROM json_each(s.snapshot_json,'$.nodes') n
        WHERE n.type='object' AND json_extract(n.value,'$.node_key')=s.node_key
        AND json_extract(n.value,'$.recontact_stage') IN ('work_location','interview_invite'))
      AND NOT EXISTS (SELECT 1 FROM recontact_anchors a
       WHERE a.trace_id=('canvas:'||json_array(s.device_code,s.session_key,s.recontact_inbound_id,s.node_key)))
      AND EXISTS (SELECT 1 FROM recontact_rules WHERE position_id=s.position_id AND enabled=1)
    ORDER BY s.await_since LIMIT 60`).all(device,new Date(now-10*60_000).toISOString()) as
    Array<{session_key:string;position_id:number;await_since:string;snapshot_json:string;node_key:string;recontact_inbound_id:string;step_index:number;trace_id:string}>;
  const insert=db.prepare(`INSERT OR IGNORE INTO recontact_anchors
    (trace_id,device_code,contact_id,account_id,position_id,mode_generation,provider,inbound_source,stage,created_at,delivered_at)
    VALUES (?,?,?,?,?,?,'agent',?,?,?,?)`);
  for (const row of rows) {
    const snapshot=parseDeviceData(row.snapshot_json);
    if (!Array.isArray(snapshot.nodes) || (snapshot.reply_mode_id ?? "")!==generation || !isDirectRecipient(account,row.session_key)) continue;
    const node=snapshot.nodes.find(n => n?.node_key===row.node_key);
    const stage=node?.recontact_stage;
    if ((stage!=="work_location" && stage!=="interview_invite") || !node.await_reply || !Array.isArray(node.parts)
      || !node.parts.length || row.step_index!==node.parts.length) continue;
    const delivered=stamp(row.await_since);
    if (!Number.isFinite(delivered) || delivered>now+5000) continue;
    insert.run(row.trace_id,device,row.session_key,account,row.position_id,generation,
      inboundEventSource(device,row.session_key,row.recontact_inbound_id),stage,Math.min(delivered,now),Math.min(delivered,now));
  }
}

export function finishRecontactAnchor(db:DatabaseSync,traceId:string,deviceCode:string,sessionKey:string,now=Date.now()) {
  db.prepare(`UPDATE recontact_anchors SET delivered_at=? WHERE trace_id=? AND device_code=? AND contact_id=?
    AND delivered_at IS NULL AND created_at>=?`).run(now,traceId,deviceCode,sessionKey,now-10*60_000);
  prepareRecontactAnchors(db,deviceCode,now);
}

function prepareRecontactAnchors(db:DatabaseSync,device:string,now:number) {
  const anchors=db.prepare(`SELECT a.*,m.id AS inbound_id,c.id AS conversation_id FROM recontact_anchors a
    JOIN agent_messages m ON m.source_event_id=a.inbound_source AND m.direction='inbound' AND m.device_code=a.device_code
    JOIN agent_conversations c ON c.device_code=m.device_code AND c.customer_id=m.customer_id AND c.external_conversation_id=a.contact_id
    WHERE a.device_code=? AND a.consumed=0 AND a.delivered_at>=? ORDER BY a.delivered_at LIMIT 30`)
    .all(device,now-10*60_000) as Array<{trace_id:string;conversation_id:number;account_id:string;position_id:number;mode_generation:string;
    provider:Provider;inbound_id:number;stage:RecontactStage;delivered_at:number}>;
  for (const a of anchors) {
    const target=recontactTarget(db,a.conversation_id,0,now);
    if (target && legacyWait(db,target)) continue;
    db.exec("SAVEPOINT recontact_anchor");
    try {
      const claimed=db.prepare("UPDATE recontact_anchors SET consumed=1 WHERE trace_id=? AND consumed=0").run(a.trace_id);
      if (claimed.changes && target && !target.reason && target.account_id===a.account_id && target.provider===a.provider
        && target.position_id===a.position_id && target.mode_generation===a.mode_generation && target.baseline_inbound_id===a.inbound_id) {
        const rule=ruleOf(db,target.position_id,a.stage);
        if (rule?.enabled) {
          let parts:RecontactPart[]=[];
          try { parts=parseRecontactParts(db,target.position_id,JSON.parse(rule.parts_json)); } catch { /* A rule can lose its asset. */ }
          if (parts.length) {
            const due=nextWindow(a.delivered_at+rule.wait_minutes*60_000,rule.start_minute,rule.end_minute);
            enqueueJob(db,target,parts,"auto:"+a.trace_id,"auto",a.stage,due,now);
          }
        }
      }
      db.exec("RELEASE recontact_anchor");
    } catch(error) {
      db.exec("ROLLBACK TO recontact_anchor; RELEASE recontact_anchor");
      throw error;
    }
  }
}

function timing(db:DatabaseSync, job:Job) {
  const rule = job.source === "auto" ? ruleOf(db,job.position_id,job.stage) : undefined;
  return { enabled:job.source === "batch" || rule?.enabled === 1, start:rule?.start_minute ?? SEND_START, end:rule?.end_minute ?? SEND_END };
}

function nextWindow(now:number,start:number,end:number):number {
  const midnight = Math.floor((now + ZONE_OFFSET)/DAY)*DAY - ZONE_OFFSET;
  if (now < midnight + start*60_000) return midnight + start*60_000;
  if (now >= midnight + end*60_000) return midnight + DAY + start*60_000;
  return now;
}

function currentReason(db:DatabaseSync,job:Job,now:number): string {
  const target = recontactTarget(db,job.conversation_id,0,now);
  if (!timing(db,job).enabled) return "复聊规则已停用";
  if (!target || target.account_id !== job.account_id || target.contact_id !== job.contact_id || target.tenant_id !== job.tenant_id
    || target.provider !== job.provider || target.mode_generation !== job.mode_generation || target.position_id !== job.position_id)
    return "账号、岗位或回复模式已切换";
  if (target.reason) return target.reason;
  if (target.baseline_inbound_id !== job.baseline_inbound_id) return "候选人已回复";
  if (legacyWait(db,target,job.source==="auto")) return "原画布仍在跟进该会话";
  return "";
}

function cancelJob(db:DatabaseSync,job:Job,reason:string) {
  db.prepare("UPDATE recontact_jobs SET status='cancelled',reason=? WHERE id=?").run(reason,job.id);
  db.prepare("UPDATE bridge_commands SET status='failed',error=? WHERE status='queued' AND id IN (SELECT command_id FROM recontact_steps WHERE job_id=?)").run(reason,job.id);
  db.prepare("UPDATE recontact_steps SET status='cancelled',reason=? WHERE job_id=? AND status IN ('pending','queued')").run(reason,job.id);
}

export function cancelInvalidRecontacts(db:DatabaseSync,filters:{device?:string;customerId?:number;positionId?:number;stage?:RecontactStage},now=Date.now()) {
  const rows=db.prepare(`SELECT j.* FROM recontact_jobs j WHERE
    (j.status='scheduled' OR (j.status='sending' AND EXISTS (
      SELECT 1 FROM recontact_steps s JOIN bridge_commands b ON b.id=s.command_id
      WHERE s.job_id=j.id AND s.status='queued' AND b.status='queued')))
    AND (?='' OR j.device_code=?) AND (?=0 OR j.customer_id=?)
    AND (?=0 OR j.position_id=?) AND (?='' OR (j.source='auto' AND j.stage=?))`)
    .all(filters.device??"",filters.device??"",filters.customerId??0,filters.customerId??0,
      filters.positionId??0,filters.positionId??0,filters.stage??"",filters.stage??"") as unknown as Job[];
  for (const row of rows) {
    const reason=currentReason(db,row,now);
    if (reason) cancelJob(db,row,reason);
  }
}

function advance(db:DatabaseSync,job:Job,seq:number,now:number) {
  const next = jobSteps(db,job.id).find(s => s.seq > seq && s.status === "pending");
  if (!next) {
    db.prepare("UPDATE recontact_jobs SET status='sent',reason='' WHERE id=?").run(job.id);
    return;
  }
  const due = now + next.delay_ms;
  db.prepare("UPDATE recontact_steps SET due_at=? WHERE job_id=? AND seq=?").run(due,job.id,next.seq);
  db.prepare("UPDATE recontact_jobs SET status='scheduled',due_at=?,reason='' WHERE id=?").run(due,job.id);
}

export function reconcileRecontact(db:DatabaseSync,device?:string,now=Date.now()): void {
  db.prepare("UPDATE bridge_commands SET status='unknown' WHERE kind='recontact' AND status='claimed' AND lease_until<=? AND (?='' OR device_code=?)")
    .run(now,device??"",device??"");
  const rows = db.prepare(`SELECT j.id,s.seq,b.status,b.simulated,b.message_id,b.error,b.receipt_at,j.contact_id
    FROM recontact_jobs j JOIN recontact_steps s ON s.job_id=j.id AND s.status IN ('queued','unknown')
    JOIN bridge_commands b ON b.id=s.command_id
    WHERE j.status IN ('sending','unknown') AND (?='' OR j.device_code=?) AND b.status IN ('succeeded','failed','unknown')`)
    .all(device ?? "",device ?? "") as Array<{id:number;seq:number;status:string;simulated:number;message_id:string;error:string;receipt_at:number|null;contact_id:string}>;
  for (const row of rows) {
    const job=getJob(db,row.id)!;
    const sent = row.status === "succeeded" && !row.simulated && row.message_id.startsWith(row.contact_id+":") && row.message_id.length>row.contact_id.length+1;
    const status = sent ? "sent" : row.status === "failed" ? "failed" : "unknown";
    const reason = sent ? "" : row.error || (status === "failed" ? "客户端报告发送失败" : "发送结果待核对");
    const confirmedAt = row.receipt_at ?? now;
    db.prepare("UPDATE recontact_steps SET status=?,reason=?,confirmed_at=? WHERE job_id=? AND seq=?")
      .run(status,reason,sent ? confirmedAt : null,row.id,row.seq);
    if (sent) {
      const step = jobSteps(db,job.id).find(item => item.seq === row.seq)!;
      const command = db.prepare("SELECT id FROM bridge_commands WHERE id=?").get(step.command_id);
      if (command && !db.prepare("SELECT 1 FROM bridge_outbound WHERE device_code=? AND event_id=?").get(job.device_code,row.message_id)) {
        const label = step.kind === "image" ? "[图片]" : step.kind === "video" ? "[视频]" : step.content;
        const event = "bridge-outbound:"+createHash("sha256").update(JSON.stringify([job.device_code,row.message_id])).digest("hex");
        db.prepare(`INSERT OR IGNORE INTO agent_messages (device_code,customer_id,direction,content,status,created_at,source_event_id,tenant_id)
          VALUES (?,?,'outbound',?,'sent',?,?,?)`).run(job.device_code,job.customer_id,label,new Date(confirmedAt).toISOString(),event,job.tenant_id);
      }
      advance(db,job,row.seq,confirmedAt);
    } else {
      const invalidated = status === "failed" ? currentReason(db,job,now) : "";
      if (invalidated) cancelJob(db,job,invalidated);
      else db.prepare("UPDATE recontact_jobs SET status=?,reason=? WHERE id=?").run(status,reason,row.id);
    }
  }
}

export function queueDueRecontact(db:DatabaseSync,device:string,now:number) {
  saveCanvasAnchors(db,device,now);
  prepareRecontactAnchors(db,device,now);
  reconcileRecontact(db,device,now);
  if (db.prepare("SELECT 1 FROM bridge_commands WHERE device_code=? AND status IN ('claimed','queued') AND kind='recontact' LIMIT 1").get(device)) return;
  const jobs=db.prepare("SELECT * FROM recontact_jobs WHERE device_code=? AND status='scheduled' AND due_at<=? ORDER BY due_at,id LIMIT 25")
    .all(device,now) as unknown as Job[];
  for (const job of jobs) {
    const reason = currentReason(db,job,now);
    if (reason) { cancelJob(db,job,reason); continue; }
    const {start,end}=timing(db,job);
    const step = jobSteps(db,job.id).find(s => s.status === "pending");
    if (!step) continue;
    const next = nextWindow(now,start,end);
    if (next !== now) {
      db.prepare("UPDATE recontact_jobs SET due_at=? WHERE id=?").run(next,job.id);
      db.prepare("UPDATE recontact_steps SET due_at=? WHERE job_id=? AND seq=?").run(next,job.id,step.seq);
      continue;
    }
    let payload = "";
    try { payload = resolveRecontactParts(db,job.position_id,[step])[0].payload; } catch { /* configuration changed */ }
    if (!payload || payload !== step.payload) { cancelJob(db,job,"地点或素材已变更，请重新确认"); continue; }
    const id = randomUUID();
    db.exec("SAVEPOINT recontact_command");
    try {
      db.prepare(`INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,created_at,kind)
        VALUES (?,?,?,?,?,?,?,'recontact')`).run(id,device,job.customer_id,job.contact_id,step.payload,"recontact:"+id,now);
      db.prepare("UPDATE recontact_steps SET status='queued',command_id=? WHERE job_id=? AND seq=?").run(id,job.id,step.seq);
      db.prepare("UPDATE recontact_jobs SET status='sending' WHERE id=?").run(job.id);
      db.exec("RELEASE recontact_command");
      return;
    } catch(error) {
      db.exec("ROLLBACK TO recontact_command; RELEASE recontact_command");
      throw error;
    }
  }
}

export function recontactCommandInfo(db:DatabaseSync,id:string) {
  const row = db.prepare(`SELECT s.kind,j.account_id,j.baseline_inbound_id FROM recontact_steps s
    JOIN recontact_jobs j ON j.id=s.job_id WHERE s.command_id=?`).get(id) as {kind:RecontactKind;account_id:string;baseline_inbound_id:number} | undefined;
  if (!row) return;
  const message = db.prepare("SELECT created_at,source_event_id FROM agent_messages WHERE id=?").get(row.baseline_inbound_id) as
    {created_at:string;source_event_id:string|null} | undefined;
  const source = message?.source_event_id;
  return {recontact_kind:row.kind,recontact_account_id:row.account_id,recontact_inbound_before_ms:message ? stamp(message.created_at) : 0,
    ...(source?.startsWith("bridge-inbound:") ? {recontact_inbound_source:source} : {})};
}

export function authorizeRecontactCommand(db:DatabaseSync,device:string,id:string,lease:string,now=Date.now()) {
  const command = db.prepare(`SELECT s.job_id,s.seq,b.status,b.lease_token,b.lease_until,b.content FROM recontact_steps s
    JOIN bridge_commands b ON b.id=s.command_id WHERE b.id=? AND b.device_code=? AND b.kind='recontact'`).get(id,device) as
    {job_id:number;seq:number;status:string;lease_token:string;lease_until:number;content:string} | undefined;
  if (!command || command.status !== "claimed" || !lease || lease !== command.lease_token || command.lease_until <= now)
    return {ok:false,reason:"发送任务已失效"};
  const job=getJob(db,command.job_id);
  if (!job || job.status !== "sending") return {ok:false,reason:"任务已停止"};
  const reason=currentReason(db,job,now);
  if (reason) return {ok:false,reason};
  const window=timing(db,job);
  if (nextWindow(now,window.start,window.end) !== now) return {ok:false,reason:"已超过可发送时段"};
  const step=jobSteps(db,job.id).find(item => item.seq===command.seq)!;
  try {
    if (resolveRecontactParts(db,job.position_id,[step])[0].payload !== command.content) return {ok:false,reason:"地点或素材已变更"};
  } catch { return {ok:false,reason:"地点或素材已失效"}; }
  return {ok:true};
}

export function recontactJobs(db:DatabaseSync,scope:UserScope,filters:{positionId?:number;deviceCode?:string;status?:string;q?:string}) {
  reconcileRecontact(db,filters.deviceCode);
  const tenant = recontactTenant(db,scope);
  const q = filters.q ?? "";
  return (db.prepare(`SELECT j.*,COALESCE(c.nickname,'') AS nickname FROM recontact_jobs j
    LEFT JOIN agent_conversations c ON c.id=j.conversation_id AND c.tenant_id=j.tenant_id
    WHERE j.tenant_id=? AND (?=0 OR j.position_id=?) AND (?='' OR j.device_code=?) AND (?='' OR j.status=?)
      AND (?='' OR instr(lower(COALESCE(c.nickname,'')),lower(?))>0 OR CAST(j.customer_id AS TEXT)=?)
    ORDER BY j.id DESC`).all(tenant,filters.positionId??0,filters.positionId??0,filters.deviceCode??"",filters.deviceCode??"",filters.status??"",filters.status??"",q,q,q) as unknown as Array<Job & { nickname:string }>)
    .filter(row => canAccessDevice(scope,row.device_code)).slice(0,250)
    .map(row => ({id:row.id,position_id:row.position_id,conversation_id:row.conversation_id,customer_id:row.customer_id,nickname:row.nickname,
      device_code:row.device_code,status:row.status,due_at:row.due_at,reason:row.reason,source:row.source,created_at:row.created_at,
      steps:jobSteps(db,row.id).map(({kind,content,status,reason,due_at,confirmed_at,seq}) => ({kind,content,status,reason,due_at,confirmed_at,seq}))}));
}

export function reviewRecontactJob(db:DatabaseSync,id:number,scope:UserScope,resolution:"sent"|"not_sent"|"cancel"):boolean {
  db.exec("SAVEPOINT recontact_review");
  try {
    const result=applyReview(db,id,scope,resolution);
    db.exec("RELEASE recontact_review");
    return result;
  } catch(error) {
    db.exec("ROLLBACK TO recontact_review; RELEASE recontact_review");
    throw error;
  }
}

function applyReview(db:DatabaseSync,id:number,scope:UserScope,resolution:"sent"|"not_sent"|"cancel"):boolean {
  const job=getJob(db,id);
  if (!job || job.tenant_id!==recontactTenant(db,scope) || !canAccessDevice(scope,job.device_code)) return false;
  const now=Date.now();
  if (resolution==="cancel" && ["scheduled","failed","unknown"].includes(job.status)) { cancelJob(db,job,"人工取消"); return true; }
  if (!["unknown","failed"].includes(job.status) || resolution==="cancel") return false;
  const step=jobSteps(db,id).find(s=>s.status==="unknown"||s.status==="failed");
  if (!step || (resolution==="sent" && step.status!=="unknown")) return false;
  const target=recontactTarget(db,job.conversation_id,0,now);
  if (target && activeJob(db,target,job.id)) return false;
  const reason=currentReason(db,job,now);
  if (resolution==="sent") {
    db.prepare("UPDATE recontact_steps SET status='sent',reason='人工核对已发送',confirmed_at=? WHERE job_id=? AND seq=?").run(now,id,step.seq);
    if (reason && jobSteps(db,job.id).some(s=>s.status==="pending")) cancelJob(db,job,reason);
    else advance(db,job,step.seq,now);
  } else {
    if (reason) { cancelJob(db,job,reason); return true; }
    db.prepare("UPDATE recontact_steps SET status='pending',reason='',command_id=NULL,due_at=? WHERE job_id=? AND seq=?").run(now,id,step.seq);
    db.prepare("UPDATE recontact_jobs SET status='scheduled',reason='',due_at=? WHERE id=?").run(now,id);
  }
  return true;
}

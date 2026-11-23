import { replyModeRow } from "../dify/reply-mode-transition.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { DeviceBridgeStore } from "../messaging/device-bridge.js";
import { devicePositionId } from "../../shared/device-factories.js";
import { deviceReplyProvider } from "../dify/dify-reply.js";

const NODE_TYPES = new Set(["text", "image", "video", "followup", "branch", "end"]);
const EDGE_TRIGGERS = new Set(["default", "any_reply", "timeout", "keyword", "giveup"]);
const PHASES = new Set(["idle", "running", "awaiting", "followup_due", "followup_sent", "replied", "expired", "held"]);
const PART_KINDS = new Set(["text", "image", "video"]);

type Json = Record<string, unknown>;
type FlowPart = { kind: string; body: string; media_name: string; delay_ms: number };
type FlowNode = {
  node_key: string; node_type: string; title: string; body: string; media_name: string;
  parts: FlowPart[]; delay_ms: number; await_reply: boolean; wait_minutes: number;
  max_times: number; x: number; y: number; status: string;
};
type FlowEdge = { from_key: string; to_key: string; trigger: string; condition_value: string; priority: number };

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finiteInt(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseObject(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
    } catch { return {}; }
  }
  return {};
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function normalizeParts(raw: unknown, nodeType: string): FlowPart[] {
  const parts = parseArray(raw);
  if (parts.length < 1 || parts.length > 6) throw new Error("每个节点必须有 1 到 6 条 parts");
  return parts.map((value, index) => {
    const item = parseObject(value);
    const kind = str(item.kind, nodeType === "image" ? "image" : nodeType === "video" ? "video" : "text");
    if (!PART_KINDS.has(kind)) throw new Error(`parts[${index}].kind 无效`);
    const body = str(item.body).trim();
    const mediaName = str(item.media_name || item.mediaName).trim();
    if (kind === "text" && !body) throw new Error(`parts[${index}] 文本不能为空`);
    if (body.length > 2000) throw new Error(`parts[${index}] 文本不能超过 2000 字`);
    if (kind !== "text" && !mediaName) throw new Error(`parts[${index}] 媒体名称不能为空`);
    if (mediaName && /[\\/:]|\.\./.test(mediaName)) throw new Error("媒体名称不能包含路径");
    return {
      kind,
      body,
      media_name: mediaName,
      delay_ms: finiteInt(item.delay_ms ?? item.delayMs, 2000, 0, 60_000),
    };
  });
}

function normalizeNodes(raw: unknown): FlowNode[] {
  const values = parseArray(raw);
  if (values.length < 1 || values.length > 500) throw new Error("nodes 必须有 1 到 500 个节点");
  const keys = new Set<string>();
  return values.map((value, index) => {
    const item = parseObject(value);
    const nodeKey = str(item.node_key || item.nodeKey).trim();
    if (!nodeKey || nodeKey.length > 100) throw new Error(`nodes[${index}].node_key 无效`);
    if (keys.has(nodeKey)) throw new Error(`节点 key 重复：${nodeKey}`);
    keys.add(nodeKey);
    const nodeType = str(item.node_type || item.nodeType, "text");
    if (!NODE_TYPES.has(nodeType)) throw new Error(`节点类型无效：${nodeType}`);
    const parts = nodeType === "branch" || nodeType === "end" ? [] : normalizeParts(item.parts, nodeType);
    if (nodeType === "followup" && (parts.length !== 1 || parts[0]?.kind !== "text")) {
      throw new Error("复聊只允许一条文本消息");
    }
    const awaitValue = item.await_reply ?? item.awaitReply ?? false;
    if (![true, false, 0, 1].includes(awaitValue as boolean | number)) throw new Error("await_reply 必须为布尔值");
    const awaitReply = Boolean(awaitValue);
    if ((nodeType === "followup" || nodeType === "branch" || nodeType === "end") && awaitReply) {
      throw new Error(`${nodeType} 节点不能 await_reply`);
    }
    return {
      node_key: nodeKey,
      node_type: nodeType,
      title: str(item.title).trim().slice(0, 200),
      body: str(item.body || parts[0]?.body).trim().slice(0, 20_000),
      media_name: str(item.media_name || item.mediaName || parts[0]?.media_name).trim().slice(0, 500),
      parts,
      delay_ms: finiteInt(item.delay_ms ?? item.delayMs, parts[0]?.delay_ms ?? 2000, 0, 60_000),
      await_reply: awaitReply,
      wait_minutes: finiteInt(item.wait_minutes ?? item.waitMinutes, 15, 1, 7 * 24 * 60),
      max_times: nodeType === "followup" ? 1 : finiteInt(item.max_times ?? item.maxTimes, 1, 0, 3),
      x: finiteNumber(item.x),
      y: finiteNumber(item.y),
      status: str(item.status, "enabled") === "disabled" ? "disabled" : "enabled",
    };
  });
}

function normalizeEdges(raw: unknown, nodes: FlowNode[]): FlowEdge[] {
  const keys = new Set(nodes.map((node) => node.node_key));
  const values = parseArray(raw);
  if (values.length > 2_000) throw new Error("edges 不能超过 2000 条");
  const seen = new Set<string>();
  return values.map((value, index) => {
    const item = parseObject(value);
    const from = str(item.from_key || item.fromKey).trim();
    const to = str(item.to_key || item.toKey).trim();
    const trigger = str(item.trigger, "default");
    if (!keys.has(from)) throw new Error(`edges[${index}] 起点不存在：${from}`);
    if (to && !keys.has(to)) throw new Error(`edges[${index}] 终点不存在：${to}`);
    if (!EDGE_TRIGGERS.has(trigger)) throw new Error(`边触发器无效：${trigger}`);
    if (trigger === "timeout" && !nodes.find((node) => node.node_key === from)?.await_reply) {
      throw new Error("timeout 边只能从 await_reply 节点发出");
    }
    if (trigger === "keyword" && !str(item.condition_value || item.conditionValue).trim()) {
      throw new Error("keyword 边必须填写 condition_value");
    }
    const edge = {
      from_key: from,
      to_key: to,
      trigger,
      condition_value: str(item.condition_value || item.conditionValue).trim().slice(0, 500),
      priority: finiteInt(item.priority, 0, -10_000, 10_000),
    };
    const signature = `${from}\u0000${to}\u0000${trigger}`;
    if (seen.has(signature)) throw new Error(`边重复：${from} -> ${to} (${trigger})`);
    seen.add(signature);
    return edge;
  }).sort((a, b) => b.priority - a.priority);
}

function validateGraph(nodes: FlowNode[], edges: FlowEdge[], entryKey: string): void {
  const enabled = nodes.filter(n => n.status === "enabled");
  const allByKey = new Map(nodes.map(n => [n.node_key,n]));
  const enabledByKey = new Map(enabled.map(n => [n.node_key,n]));
  if (!enabledByKey.has(entryKey)) throw new Error("入口不存在或已停用");
  for (const edge of edges) {
    const from = allByKey.get(edge.from_key);
    const to = allByKey.get(edge.to_key);
    if (!from || (edge.to_key && !to)) throw new Error("边连接的节点不存在");
    if (from.node_type === "end") throw new Error("end 节点不能有出边");
    if (edge.trigger === "timeout" && (!from.await_reply || to?.node_type !== "followup")) throw new Error("timeout 必须从等待节点指向 followup");
    if (to?.node_type === "followup" && edge.trigger !== "timeout") throw new Error("followup 只能通过 timeout 进入");
    if (from.await_reply && edge.trigger === "default") throw new Error("等待节点请使用 any_reply/keyword 边");
    if (!from.await_reply && ["any_reply","timeout"].includes(edge.trigger)) throw new Error("非等待节点不能设置回复/超时边");
  }
  for (const node of enabled) {
    const out = edges.filter(e => e.from_key === node.node_key);
    for (const trigger of ["default","any_reply","timeout","giveup"]) {
      if (out.filter(e => e.trigger === trigger).length > 1) throw new Error(`触发器重复：${node.node_key}/${trigger}`);
    }
    if (node.node_type === "followup") {
      const timeoutInputs = edges.filter(e => e.to_key === node.node_key && e.trigger === "timeout");
      if (node.node_key === entryKey || timeoutInputs.length !== 1 || enabledByKey.get(timeoutInputs[0]?.from_key)?.await_reply !== true) {
        throw new Error("followup 必须且只能挂一条来自启用等待节点的 timeout 边");
      }
    }
    if (node.node_type !== "end" && !out.length) throw new Error(`节点没有终态出口：${node.node_key}`);
    if (node.await_reply && !out.some(e => e.trigger === "any_reply")) throw new Error("等待节点必须有 any_reply 兜底");
    if (node.node_type === "branch" && !out.some(e => e.trigger === "default")) throw new Error("分支必须有 default 兜底");
    if (node.node_type === "followup" && out.some(e => e.to_key && enabledByKey.get(e.to_key)?.node_type !== "end")) throw new Error("复聊发送后必须结束，不能继续发送介绍");
    if (!node.await_reply && !["branch", "end"].includes(node.node_type) && !out.some(e => e.trigger === "default")) throw new Error("连续发送节点必须有 default 出口");
  }
  const reached = new Set<string>();
  const visiting = new Set<string>();
  function visit(key: string) {
    if (!key) return;
    if (visiting.has(key)) throw new Error("流程不能形成循环（防止重复发送）");
    if (reached.has(key)) return;
    visiting.add(key);reached.add(key);
    const node = allByKey.get(key)!;
    const outgoing = edges.filter(e => e.from_key === key);
    // Disabled nodes remain editable in the graph, but the client runner only
    // bypasses them through their continuous or any-reply primary exit.
    const traversed = node.status === "disabled"
      ? [outgoing.find(e => e.trigger === "default") ?? outgoing.find(e => e.trigger === "any_reply")].filter(Boolean)
      : outgoing;
    for (const edge of traversed) visit(edge!.to_key);
    visiting.delete(key);
  }
  visit(entryKey);
  if (enabled.some(n => !reached.has(n.node_key))) throw new Error("存在从入口不可达的孤儿节点");
}

function jsonObject(raw: unknown): Json {
  const value = parseObject(raw);
  return value;
}

export function readFlow(db: DatabaseSync, positionId: number) {
  const flow = db.prepare("SELECT * FROM agent_flow WHERE position_id=?").get(positionId) as Record<string, unknown> | undefined;
  if (!flow) return { position_id: positionId, version: 0, status: "disabled", entry_key: "", canvas: {}, nodes: [], edges: [] };
  const nodes = db.prepare("SELECT * FROM agent_flow_node WHERE flow_id=? ORDER BY id").all(Number(flow.id)) as Array<Record<string, unknown>>;
  const edges = db.prepare("SELECT * FROM agent_flow_edge WHERE flow_id=? ORDER BY priority DESC,id").all(Number(flow.id)) as Array<Record<string, unknown>>;
  return {
    position_id: positionId,
    version: Number(flow.version),
    status: String(flow.status),
    entry_key: str(jsonObject(flow.canvas_json).entry_key),
    canvas: { viewport: jsonObject(flow.canvas_json).viewport ?? {} },
    nodes: nodes.map((node) => ({
      node_key: node.node_key, node_type: node.node_type, title: node.title, body: node.body,
      media_name: node.media_name, parts: parseArray(node.parts_json), delay_ms: node.delay_ms,
      await_reply: Boolean(node.await_reply), wait_minutes: node.wait_minutes, max_times: node.max_times,
      x: node.x, y: node.y, status: node.status,
    })),
    edges: edges.map((edge) => ({
      from_key: edge.from_key, to_key: edge.to_key, trigger: edge.trigger,
      condition_value: edge.condition_value, priority: edge.priority,
    })),
  };
}

/** Explicit legacy compatibility mode; never change the default opening list. */
export function firstFlowSegment(db: DatabaseSync, positionId: number) {
  const flow = readFlow(db, positionId);
  if (flow.status !== "enabled") return [];
  const parts: FlowPart[] = [];
  const visited = new Set<string>();
  let key = flow.entry_key;
  while (key && !visited.has(key)) {
    visited.add(key);
    const node = flow.nodes.find(item => item.node_key === key && item.status === "enabled");
    if (!node || node.node_type === "end") break;
    parts.push(...node.parts as FlowPart[]);
    if (node.await_reply) break;
    key = str(flow.edges.find(edge => edge.from_key === key && edge.trigger === "default")?.to_key);
  }
  return parts.map((part, index) => ({seq:index + 1,kind:part.kind,content:part.body,media_name:part.media_name,delay_ms:part.delay_ms}));
}

function validateNumbers(db: DatabaseSync, positionId: number, nodes: FlowNode[]) {
  const row = db.prepare("SELECT data_json FROM service_positions WHERE id=?").get(positionId) as {data_json: string};
  const data = jsonObject(row.data_json);
  const factKeys = ["wage_text", "hours_text", "age_text", "welfare_text", "place", "interview_time",
    "interview_time_text", "interview_address", "interview_material", "basic_requirements", "onboarding_notes",
    "height_text", "tattoo_policy", "cert_text", "job_content"];
  const allowed = new Set(factKeys.flatMap(key => str(data[key]).match(/\d+(?:\.\d+)?/g) || []));
  for (const node of nodes.filter(item => item.status === "enabled")) {
    for (const part of node.parts.filter(item => item.kind === "text")) {
      const unverified = (part.body.match(/\d+(?:\.\d+)?/g) || []).filter(value => !allowed.has(value));
      if (unverified.length) throw new Error(`节点「${node.title || node.node_key}」数字未出现在本岗位事实中：${[...new Set(unverified)].join("、")}`);
    }
  }
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("时间字段必须是 ISO 时间");
  return new Date(value).toISOString();
}

const CONFIG_SYNC_STATES = new Set(["synced", "stale", "blocked", "error"]);
const CONFIG_SYNC_ERRORS = new Set(["", "auth", "network", "http", "invalid_response", "cache", "read", "write", "unknown", "timeout"]);

function configSyncBranch(value: unknown, flow: boolean): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置摘要必须为对象");
  const item = value as Json;
  const nullableInt = (raw: unknown, field: string): number | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new Error(`${field} 无效`);
    return raw;
  };
  const state = str(item.state);
  const error = item.error === null || item.error === undefined ? "" : str(item.error, "invalid");
  if (!CONFIG_SYNC_STATES.has(state)) throw new Error("state 无效");
  if (!CONFIG_SYNC_ERRORS.has(error)) throw new Error("error 必须为允许的短错误码");
  const version = flow ? nullableInt(item.version, "version") : item.version == null ? null : str(item.version).toLowerCase();
  if (!flow && version !== null && !/^[a-f0-9]{64}$/.test(String(version))) throw new Error("opening.version 无效");
  const result: Json = {
    position_id: nullableInt(item.position_id, "position_id"), version,
    synced_at: isoOrNull(item.synced_at), checked_at: isoOrNull(item.checked_at), state, error,
  };
  if (flow) {
    const status = item.status == null ? null : str(item.status);
    if (status !== null && !["enabled", "disabled"].includes(status)) throw new Error("flow.status 无效");
    result.status = status;
  }
  return result;
}

function normalizeConfigSync(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置摘要必须为对象");
  const body = value as Json;
  const commit = str(body.client_commit).toLowerCase();
  return {
    client_commit: /^[a-f0-9]{40}$/.test(commit) ? commit : null,
    flow: configSyncBranch(body.flow, true), opening: configSyncBranch(body.opening, false),
  };
}

export async function registerAgentFlowRoutes(app: FastifyInstance, db: DatabaseSync): Promise<void> {
  const deviceStore = new DeviceBridgeStore(db);
  const deviceAllowed = (request: import("fastify").FastifyRequest, code: string) =>
    Boolean(code && deviceStore.authenticate(code, (request.headers.authorization ?? "").replace(/^Bearer /, "")) && deviceStore.enabled(code));

  app.get<{ Querystring: { device_code?: string } }>("/api/v1/agent/config-sync", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const deviceCode = str(request.query.device_code).trim();
    if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?")
      .get(deviceCode) as { data_json: string } | undefined;
    const metadata = {
      device_code: deviceCode,
      reply_provider: row ? replyModeRow(db, deviceCode)?.effective ?? deviceReplyProvider(db, deviceCode) : null,
      bridge_state: row ? deviceStore.status(deviceCode)?.state ?? null : null,
    };
    const stored = parseObject(parseObject(row?.data_json).config_sync);
    if (!Object.keys(stored).length) return { available: false, ...metadata };
    try {
      const safe = normalizeConfigSync(stored);
      const serverReceivedAt = isoOrNull(stored.server_received_at);
      if (!serverReceivedAt) return { available: false, ...metadata };
      return { available: true, ...metadata, ...safe, server_received_at: serverReceivedAt };
    } catch {
      return { available: false, ...metadata };
    }
  });

  app.post<{ Body: Json }>("/api/v1/agent/config-sync", async (request, reply) => {
    const deviceCode = str(request.body?.device_code).trim();
    if (!deviceAllowed(request, deviceCode)) return reply.code(403).send({ detail: "Device token or scope invalid" });
    try {
      const safe = normalizeConfigSync(request.body);
      const serverReceivedAt = new Date().toISOString();
      db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.config_sync',json(?)) WHERE json_extract(data_json,'$.device_code')=?")
        .run(JSON.stringify({ ...safe, server_received_at: serverReceivedAt }), deviceCode);
      return { ok: true, server_received_at: serverReceivedAt };
    } catch (error) {
      return reply.code(422).send({ detail: error instanceof Error ? error.message : "配置摘要无效" });
    }
  });

  app.get<{ Querystring: { position_id?: string } }>("/api/v1/agent-flow", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const id = finiteInt(request.query.position_id, 0, 1);
    if (!id) return reply.code(422).send({ detail: "position_id is required" });
    return readFlow(db, id);
  });

  app.get<{ Querystring: { device_code?: string } }>("/api/v1/agent/flow", async (request, reply) => {
    const code = str(request.query.device_code).trim();
    if (!deviceAllowed(request, code)) return reply.code(403).send({ detail: "Device token or scope invalid" });
    const mode = replyModeRow(db, code);
    const reply_mode_id = mode?.phase === "applying" && !mode.rollback ? mode.id : mode?.generation || "";
    if (deviceReplyProvider(db, code) === "dify") return { ok: true, provider: "dify", reply_mode_id, version: 0, nodes: [], edges: [], status: "disabled" };
    const positionId = devicePositionId(db, code);
    if (!db.prepare("SELECT 1 FROM service_positions WHERE id=? AND status='enabled'").get(positionId)) {
      return { position_id: positionId, reply_mode_id, version: 0, nodes: [], edges: [], status: "disabled" };
    }
    const result = readFlow(db, positionId);
    // 停用只阻止新会话；在途会话使用本地持久化快照。
    return { ...result, ...(result.status === "enabled" ? {} : { nodes: [], edges: [] }), reply_mode_id };
  });

  app.post<{ Body: Json }>("/api/v1/agent-flow/migrate", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const positionId = finiteInt(request.body?.position_id, 0, 1);
    if (!positionId || !db.prepare("SELECT id FROM service_positions WHERE id=?").get(positionId)) return reply.code(422).send({detail:"岗位不存在"});
    const existing = readFlow(db, positionId);
    if (existing.version) return existing;
    const items = db.prepare("SELECT * FROM position_opening WHERE position_id=? AND status='enabled' ORDER BY seq,id").all(positionId) as Array<Record<string, unknown>>;
    if (!items.length) return reply.code(422).send({detail:"没有可迁移的开场"});
    // 保守迁移：每条都是等待闸门；运营显式调整分组后再启用。
    const nodes = items.map((item, i) => ({node_key:`opening_${item.id}`,node_type:"text",title:`开场 ${i+1}`,await_reply:true,
      parts:[{kind:item.kind,body:item.content,media_name:item.media_name,delay_ms:item.delay_ms}],x:80,y:40+i*180}));
    const edges = nodes.map((node,i) => ({from_key:node.node_key,to_key:nodes[i+1]?.node_key ?? "",trigger:"any_reply"}));
    const response = await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:{authorization:request.headers.authorization},
      payload:{position_id:positionId,entry_key:nodes[0].node_key,nodes,edges,status:"disabled"}});
    return reply.code(response.statusCode).send(response.json());
  });

  app.put<{ Body: Json }>("/api/v1/agent-flow", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    const body = request.body ?? {};
    const positionId = finiteInt(body.position_id ?? body.positionId, 0, 1);
    if (!positionId) return reply.code(422).send({ detail: "position_id is required" });
    if (!db.prepare("SELECT id FROM service_positions WHERE id=?").get(positionId)) return reply.code(422).send({ detail: "岗位不存在" });
    try {
      const nodes = normalizeNodes(body.nodes);
      const edges = normalizeEdges(body.edges, nodes);
      const existing = db.prepare("SELECT id,version FROM agent_flow WHERE position_id=?").get(positionId) as { id: number; version: number } | undefined;
      const entryKey = str(body.entry_key ?? body.entryKey, nodes[0]?.node_key ?? "");
      validateGraph(nodes, edges, entryKey);
      // Drafts preserve historical content for review; activation enforces facts.
      if (body.status !== "disabled") validateNumbers(db, positionId, nodes);
      for (const node of nodes) for (const part of node.parts) {
        if (part.kind !== "text") {
          const asset = db.prepare("SELECT kind,position_id FROM media_assets WHERE name=? AND status='enabled'").get(part.media_name) as {kind:string;position_id:number}|undefined;
          if (!asset || asset.kind !== part.kind || ![0,positionId].includes(Number(asset.position_id))) throw new Error(`媒体不存在或不属于本岗位：${part.media_name}`);
        }
      }
      if (body.version !== undefined && Number(body.version) !== (existing?.version ?? 0)) return reply.code(409).send({detail:"流程已被其他人修改，请重新载入"});
      const canvas = { viewport: jsonObject(body.canvas ?? body.canvas_json).viewport ?? {}, entry_key: entryKey };
      db.exec("BEGIN");
      try {
        let flowId: number;
        let version: number;
        if (existing) {
          flowId = existing.id; version = Number(existing.version) + 1;
          db.prepare("UPDATE agent_flow SET version=?,canvas_json=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(version, JSON.stringify(canvas), str(body.status, "enabled") === "disabled" ? "disabled" : "enabled", flowId);
          db.prepare("DELETE FROM agent_flow_edge WHERE flow_id=?").run(flowId);
          db.prepare("DELETE FROM agent_flow_node WHERE flow_id=?").run(flowId);
        } else {
          const inserted = db.prepare("INSERT INTO agent_flow(position_id,version,canvas_json,status) VALUES (?,1,?,?)")
            .run(positionId, JSON.stringify(canvas), str(body.status, "enabled") === "disabled" ? "disabled" : "enabled");
          flowId = Number(inserted.lastInsertRowid); version = 1;
        }
        const insertNode = db.prepare(`INSERT INTO agent_flow_node
          (flow_id,node_key,node_type,title,body,media_name,parts_json,delay_ms,await_reply,wait_minutes,max_times,x,y,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const node of nodes) insertNode.run(flowId, node.node_key, node.node_type, node.title, node.body, node.media_name,
          JSON.stringify(node.parts), node.delay_ms, node.await_reply ? 1 : 0, node.wait_minutes, node.max_times, node.x, node.y, node.status);
        const insertEdge = db.prepare(`INSERT INTO agent_flow_edge(flow_id,from_key,to_key,trigger,condition_value,priority) VALUES (?,?,?,?,?,?)`);
        for (const edge of edges) insertEdge.run(flowId, edge.from_key, edge.to_key, edge.trigger, edge.condition_value, edge.priority);
        db.exec("COMMIT");
        return { ...readFlow(db, positionId), version };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      return reply.code(422).send({ detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { device_code?: string; session_key?: string; summary?: string } }>("/api/v1/agent/state", async (request, reply) => {
    const deviceCode = str(request.query.device_code).trim();
    if (request.query.summary === "1") {
      if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
      if (!deviceCode) return reply.code(422).send({ detail: "device_code is required" });
      const items = db.prepare(`SELECT position_id,flow_version,node_key,phase,COUNT(*) AS count,
        strftime('%Y-%m-%dT%H:%M:%fZ', MAX(updated_at)) AS updated_at
        FROM agent_conversation_state WHERE device_code=?
        GROUP BY position_id,flow_version,node_key,phase ORDER BY updated_at DESC,position_id,flow_version,node_key,phase`)
        .all(deviceCode);
      return { device_code: deviceCode, items };
    }
    if (!deviceAllowed(request, deviceCode)) return reply.code(403).send({ detail: "Device token or scope invalid" });
    const rows = db.prepare("SELECT * FROM agent_conversation_state WHERE device_code=? ORDER BY updated_at DESC").all(deviceCode) as Array<Json>;
    return {device_code:deviceCode, items:rows.filter(row => !request.query.session_key || row.session_key === request.query.session_key)
      .map(row => ({...row, snapshot:jsonObject(row.snapshot_json), snapshot_json:undefined}))};
  });

  app.post<{ Body: Json }>("/api/v1/agent/state", async (request, reply) => {
    const body = request.body ?? {};
    const deviceCode = str(body.device_code).trim();
    if (!deviceAllowed(request, deviceCode)) return reply.code(403).send({ detail: "Device token or scope invalid" });
    if (!Array.isArray(body.items) || body.items.length > 200) return reply.code(422).send({detail:"items 必须为数组，最多 200 条"});
    try {
      const rows = body.items.map(value => {
        const item = jsonObject(value);
        if (!/^[SR]:.{1,118}$/.test(str(item.session_key)) || !PHASES.has(str(item.phase))) throw new Error("session_key 或 phase 无效");
        for (const key of ["position_id","flow_version","step_index","followup_round"]) {
          if (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || Number(item[key]) < 0) throw new Error(`${key} 无效`);
        }
        if (item.revision !== undefined && (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0)) throw new Error("revision 无效");
        if (Number(item.followup_round)>1) throw new Error("复聊最多一次");
        const snapshot = jsonObject(item.snapshot);
        if (JSON.stringify(snapshot).length > 500_000) throw new Error("流程快照过大");
        return {...item,await_since:isoOrNull(item.await_since),followup_sent_at:isoOrNull(item.followup_sent_at),snapshot_json:JSON.stringify(snapshot)};
      });
      db.exec("BEGIN");
      const rejected: string[] = [];
      try {
        const stmt = db.prepare(`INSERT INTO agent_conversation_state
          (session_key,device_code,position_id,flow_version,node_key,step_index,phase,await_since,followup_sent_at,followup_round,last_error,revision,snapshot_json,conv_name,wait_minutes,last_inbound_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(device_code,session_key) DO UPDATE SET position_id=excluded.position_id,flow_version=excluded.flow_version,
          node_key=excluded.node_key,step_index=excluded.step_index,phase=excluded.phase,await_since=excluded.await_since,
          followup_sent_at=excluded.followup_sent_at,followup_round=MAX(agent_conversation_state.followup_round,excluded.followup_round),
          last_error=excluded.last_error,revision=excluded.revision,snapshot_json=excluded.snapshot_json,conv_name=excluded.conv_name,
          wait_minutes=excluded.wait_minutes,last_inbound_at=excluded.last_inbound_at,updated_at=CURRENT_TIMESTAMP
          WHERE excluded.revision>agent_conversation_state.revision`);
        for (const raw of rows) {
          const item: Json = raw;
          const result = stmt.run(str(item.session_key),deviceCode,Number(item.position_id),Number(item.flow_version),str(item.node_key),Number(item.step_index),str(item.phase),
            item.await_since as string|null,item.followup_sent_at as string|null,Number(item.followup_round),str(item.last_error).slice(0,2000),finiteInt(item.revision,1,1),str(item.snapshot_json,"{}"),
            str(item.conv_name).slice(0,200),finiteInt(item.wait_minutes,15,1,10080),finiteNumber(item.last_inbound_at));
          if (!result.changes) rejected.push(str(item.session_key));
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return {ok:true, items:rows.length, stale:rejected};
    } catch (error) {return reply.code(422).send({detail:error instanceof Error?error.message:String(error)});}
  });
}

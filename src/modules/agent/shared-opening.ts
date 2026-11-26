import type { DatabaseSync } from "node:sqlite";
import { parseOpeningLocation, type OpeningLocation } from "../../shared/opening-location.js";
import { validFlowCoordinates } from "../../shared/flow-location.js";

export type SharedOpeningPart = { kind: string; body: string; media_name: string; delay_ms: number;
  opening_id?: number; location?: OpeningLocation | null };
type Part = SharedOpeningPart;
type Node = { node_key: string; node_type: string; status: string; await_reply: boolean; parts: Part[] };
type Edge = { from_key: string; to_key: string; trigger: string };
export type OpeningLayout = Array<{ key: string; count: number }>;
const SHARED_KINDS = new Set(["text", "image", "video"]);
export const SHARED_OPENING_LIMIT = 30;

export function storedOpeningLayout(raw: unknown): OpeningLayout {
  try {
    const value = JSON.parse(String(raw ?? "{}"));
    return Array.isArray(value.opening_layout) ? value.opening_layout : [];
  } catch { return []; }
}

export function openingNodes(entry: string, nodes: Node[], edges: Edge[], includeDisabled = false): Node[] {
  const path: Node[] = [];
  const seen = new Set<string>();
  let key = entry;
  while (key && !seen.has(key)) {
    seen.add(key);
    const node = nodes.find(candidate => candidate.node_key === key);
    if (!node || (!includeDisabled && node.status !== "enabled") || !SHARED_KINDS.has(node.node_type)) break;
    path.push(node);
    key = edges.find(edge => edge.from_key === key && edge.trigger === (node.await_reply ? "any_reply" : "default"))?.to_key ?? "";
  }
  return path;
}

export function sharedOpeningParts(db: DatabaseSync, positionId: number): Part[] {
  const rows = db.prepare(`SELECT id AS opening_id, kind, content AS body, media_name, delay_ms
    FROM position_opening WHERE position_id=? AND status='enabled' ORDER BY seq,id`).all(positionId) as Part[];
  return rows.map(part => part.kind === "location" ? { ...part, location: parseOpeningLocation(part.body) } : part);
}

export function openingLocationReply(location: OpeningLocation): string {
  return `${location.name || "地点"}：${location.address}\n导航：https://uri.amap.com/marker?position=${location.lng},${location.lat}`;
}

export function openingLayout(nodes: Node[]): OpeningLayout {
  return nodes.map(node => ({ key: node.node_key, count: node.parts.length }));
}

/** Adopt an existing pair only if the live send sequence stays the same. */
export function matchingOpeningLayout(nodes: Node[], list: Part[], enabled: boolean): OpeningLayout {
  if (!list.length) return [];
  let count = 0;
  const matched: Node[] = [];
  for (const node of nodes) {
    matched.push(node);
    count += node.parts.length;
    if (count >= list.length) break;
  }
  const parts = matched.flatMap(node => node.parts);
  const content = (value: string) => value.replace(/\r\n?/g, "\n").trim();
  return parts.length && parts.length === list.length && parts.every((part, i) => {
    const row = list[i];
    return part.kind === row.kind && content(part.body) === content(row.body) &&
      part.media_name === row.media_name && (!enabled || part.delay_ms === row.delay_ms);
  }) ? openingLayout(matched) : [];
}

/** Initialize one time per old graph, including graphs whose drafts must be preserved. */
export function initializeSharedOpenings(db: DatabaseSync): void {
  const flows = db.prepare(`SELECT id, position_id, status, canvas_json FROM agent_flow
    WHERE json_type(canvas_json,'$.opening_layout') IS NULL`).all();
  const update = db.prepare(`UPDATE agent_flow SET canvas_json=json_set(canvas_json,'$.opening_layout',json(?)),
    version=version+? WHERE id=?`);
  for (const flow of flows) {
    const nodes = db.prepare(`SELECT node_key,node_type,status,await_reply,parts_json FROM agent_flow_node WHERE flow_id=?`).all(flow.id);
    const edges = db.prepare(`SELECT from_key,to_key,trigger FROM agent_flow_edge WHERE flow_id=?`).all(flow.id) as Edge[];
    const entry = JSON.parse(String(flow.canvas_json)).entry_key;
    const path = openingNodes(entry, nodes.map(row => ({
      node_key: String(row.node_key), node_type: String(row.node_type), status: String(row.status),
      await_reply: Boolean(row.await_reply), parts: JSON.parse(String(row.parts_json)),
    })), edges);
    const id = Number(flow.position_id);
    const canonical = sharedOpeningParts(db, id);
    let layout = matchingOpeningLayout(path, canonical, flow.status === "enabled");
    // Shenzhen's stopped legacy draft has a withdrawn third message; its video
    // needs to run in the same turn as a verified text message.
    if (id === 22 && flow.status === "disabled" && isMetroPosition(db, id, "深圳_地铁安检员") &&
        nodes.length === 4 && path.map(node => node.node_key).join(",") === "opening_1,opening_2,opening_3,opening_7" &&
        edges.length === 4 && edges.every(edge => edge.trigger === "any_reply") &&
        canonical.map(part => part.kind).join(",") === "text,text,video") {
      db.prepare("DELETE FROM agent_flow_edge WHERE flow_id=? AND from_key IN ('opening_3','opening_7')").run(flow.id);
      db.prepare("UPDATE agent_flow_edge SET to_key='' WHERE flow_id=? AND from_key='opening_2'").run(flow.id);
      db.prepare("DELETE FROM agent_flow_node WHERE flow_id=? AND node_key IN ('opening_3','opening_7')").run(flow.id);
      layout = [{ key: "opening_1", count: 1 }, { key: "opening_2", count: canonical.length - 1 }];
    }
    update.run(JSON.stringify(layout), layout.length ? 1 : 0, flow.id);
    clearSharedNodeParts(db, Number(flow.id), layout);
  }
  if (isMetroPosition(db, 23, "广州_地铁安检员") &&
      !db.prepare("SELECT 1 FROM agent_flow WHERE position_id=23").get() && sharedOpeningParts(db, 23).length) {
    const canvas = { entry_key: "intro", opening_layout: [{ key: "intro", count: sharedOpeningParts(db, 23).length }] };
    const flowId = db.prepare("INSERT INTO agent_flow(position_id,status,canvas_json) VALUES (23,'disabled',?)").run(JSON.stringify(canvas)).lastInsertRowid;
    db.prepare("INSERT INTO agent_flow_node(flow_id,node_key,title,await_reply,x,y) VALUES (?,'intro','招聘介绍',1,80,64)").run(flowId);
    db.prepare("INSERT INTO agent_flow_edge(flow_id,from_key,to_key,trigger) VALUES (?,'intro','','any_reply')").run(flowId);
  }
}

function isMetroPosition(db: DatabaseSync, positionId: number, exactName: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM service_positions WHERE id=? AND position_name=?").get(positionId, exactName));
}

function clearSharedNodeParts(db: DatabaseSync, flowId: number, layout: OpeningLayout): void {
  const clear = db.prepare("UPDATE agent_flow_node SET parts_json='[]',body='',media_name='' WHERE flow_id=? AND node_key=?");
  for (const { key } of layout) clear.run(flowId, key);
}

/** Materialize the latest opening for older server binaries before a rollback. */
export function restoreLegacyFlowOpenings(db: DatabaseSync): number {
  const flows = db.prepare("SELECT id,position_id,canvas_json FROM agent_flow WHERE json_array_length(canvas_json,'$.opening_layout')>0").all();
  const update = db.prepare("UPDATE agent_flow_node SET parts_json=?,body=?,media_name=?,delay_ms=? WHERE flow_id=? AND node_key=?");
  const bump = db.prepare("UPDATE agent_flow SET version=version+1 WHERE id=?");
  for (const flow of flows) {
    const grouped = splitSharedOpening(storedOpeningLayout(flow.canvas_json), sharedOpeningParts(db, Number(flow.position_id)));
    for (const [key, items] of grouped) {
      const parts = items.map(({ opening_id: _id, location, ...part }) =>
        part.kind === "location" && location ? { ...part, kind: "text", body: openingLocationReply(location) } : part);
      const first = parts[0];
      update.run(JSON.stringify(parts), first?.body ?? "", first?.media_name ?? "", first?.delay_ms ?? 2000, flow.id, key);
    }
    bump.run(flow.id);
  }
  return flows.length;
}

export function unverifiedOpeningNumbers(facts: Record<string, unknown>, parts: Part[]): string[] {
  const factKeys = ["wage_text", "hours_text", "age_text", "welfare_text", "place", "interview_time",
    "interview_time_text", "interview_address", "interview_material", "basic_requirements", "onboarding_notes",
    "height_text", "tattoo_policy", "cert_text", "job_content"];
  const numbers = new Set(factKeys.flatMap(key => typeof facts[key] === "string" ? facts[key].match(/\d+(?:\.\d+)?/g) ?? [] : []));
  return [...new Set(parts.flatMap(part => part.kind === "text"
    ? (part.body.match(/\d+(?:\.\d+)?/g) ?? []).filter(value => !numbers.has(value)) : []))];
}

export function validateSharedOpening(db: DatabaseSync, positionId: number, parts: Part[], prior: Part[] = []): void {
  const row = db.prepare("SELECT data_json FROM service_positions WHERE id=?").get(positionId);
  let facts: Record<string, unknown> = {};
  try { facts = JSON.parse(String(row?.data_json ?? "{}")) || {}; } catch { /* no verified facts */ }
  const oldParts = new Map(prior.map(part => [part.opening_id, part]));
  const changed = parts.filter(part => oldParts.get(part.opening_id)?.body !== part.body || oldParts.get(part.opening_id)?.kind !== part.kind);
  const unverified = unverifiedOpeningNumbers(facts, changed);
  if (unverified.length) throw new Error(`开场数字未出现在本岗位事实中：${unverified.join("、")}`);
  if (!parts.length) throw new Error("启用流程需要至少一条共享开场消息");
  for (const part of parts) {
    if (part.kind === "text") continue;
    if (part.kind === "location") {
      if (!part.location || !validFlowCoordinates(part.location.lng, part.location.lat) || !part.location.address) {
        throw new Error("位置卡需要详细地址及有效经纬度");
      }
      continue;
    }
    const asset = db.prepare("SELECT 1 FROM media_assets WHERE name=? AND kind=? AND position_id IN (0,?) AND status='enabled'")
      .get(part.media_name, part.kind, positionId);
    if (!asset) throw new Error(`媒体不存在或不属于本岗位：${part.media_name}`);
  }
}

/** Each list operation must preserve the checks that apply to its executable graph. */
export function validatePositionOpeningUpdate(db: DatabaseSync, positionId: number, prior: Part[]): void {
  const flow = db.prepare("SELECT status,canvas_json FROM agent_flow WHERE position_id=?").get(positionId);
  const layout = storedOpeningLayout(flow?.canvas_json);
  if (!flow || !layout.length) return;
  const next = sharedOpeningParts(db, positionId);
  validateOpeningGroups([{ await_reply: false, parts: next }]);
  const groupById = new Map<number | undefined, number>();
  [...splitSharedOpening(layout, prior).values()].forEach((parts, group) => {
    for (const part of parts) groupById.set(part.opening_id, group);
  });
  const retained = new Set(next.map(part => part.opening_id));
  let layoutNow = layout;
  if (prior.some(part => !retained.has(part.opening_id)) || next.some(part => !groupById.has(part.opening_id))) {
    // Inserted captions inherit the following message's group. Appended items
    // join the last group. Removing a message must not move the wait boundary.
    layoutNow = layout.map(({ key }) => ({ key, count: 0 }));
    let group = layout.length - 1;
    for (let index = next.length - 1; index >= 0; index--) {
      group = groupById.get(next[index].opening_id) ?? group;
      layoutNow[group].count += 1;
    }
    db.prepare("UPDATE agent_flow SET canvas_json=json_set(canvas_json,'$.opening_layout',json(?)) WHERE position_id=?")
      .run(JSON.stringify(layoutNow), positionId);
  }
  if (flow.status === "enabled") {
    const grouped = splitSharedOpening(layoutNow, next);
    const nodes = db.prepare("SELECT node_key,await_reply,status FROM agent_flow_node WHERE flow_id=(SELECT id FROM agent_flow WHERE position_id=?)")
      .all(positionId);
    const groups = layoutNow.flatMap(({ key }) => {
      const node = nodes.find(item => item.node_key === key && item.status === "enabled");
      return node ? [{ await_reply: Boolean(node.await_reply), parts: grouped.get(key) ?? [] }] : [];
    });
    validateOpeningGroups(groups);
    validateSharedOpening(db, positionId, next, prior);
  }
}

export function validateOpeningGroups(groups: Array<{ await_reply: boolean; parts: Part[] }>): void {
  let hasText = false;
  for (const node of groups) {
    for (const part of node.parts) {
      if (part.kind === "text") {
        const body = part.body.trim();
        if (!body || body === "请填写此节点要发送的内容" || body === "请填写复聊内容") {
          throw new Error("请先填写实际开场话术");
        }
        hasText = true;
      }
      else if (!hasText) throw new Error("每段开场先安排一条文字，再发送素材或位置");
    }
    if (node.await_reply) {
      if (!node.parts.length && !hasText) throw new Error("等待回复前需要安排一条开场消息");
      hasText = false;
    }
  }
}

export function openingUsesSharedParts(db: DatabaseSync, positionId: number): boolean {
  const flow = db.prepare("SELECT canvas_json FROM agent_flow WHERE position_id=?").get(positionId);
  return storedOpeningLayout(flow?.canvas_json).length > 0;
}

export function splitSharedOpening(layout: OpeningLayout, list: Part[]): Map<string, Part[]> {
  let start = 0;
  return new Map(layout.map(({ key, count }, index) => {
    const end = start + count;
    const parts = list.slice(start, index === layout.length - 1 ? undefined : end);
    start = end;
    return [key, parts];
  }));
}

export function saveSharedOpening(db: DatabaseSync, positionId: number, parts: Part[]): void {
  const existing = db.prepare("SELECT id, status FROM position_opening WHERE position_id=? ORDER BY seq,id").all(positionId);
  const isShared = (row: typeof existing[number]) => row.status === "enabled";
  const ids = new Set(existing.filter(isShared).map(row => Number(row.id)));
  if (parts.length + existing.length - ids.size > SHARED_OPENING_LIMIT) throw new Error(`一个岗位最多 ${SHARED_OPENING_LIMIT} 条开场`);
  const update = db.prepare(`UPDATE position_opening SET seq=?,kind=?,content=?,media_name=?,delay_ms=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  const insert = db.prepare(`INSERT INTO position_opening(position_id,seq,kind,content,media_name,delay_ms) VALUES (?,?,?,?,?,?)`);
  let seq = 1;
  function write(part: Part) {
    const fields = [seq++, part.kind, part.body, part.media_name, part.delay_ms] as const;
    if (part.opening_id) {
      if (!ids.delete(part.opening_id)) throw new Error("开场条目不存在、重复或属于其他岗位");
      update.run(...fields, part.opening_id);
    } else insert.run(positionId, ...fields);
  }
  let index = 0;
  const resequence = db.prepare("UPDATE position_opening SET seq=? WHERE id=?");
  for (const row of existing) {
    if (!isShared(row)) resequence.run(seq++, row.id);
    else if (index < parts.length) write(parts[index++]);
  }
  while (index < parts.length) write(parts[index++]);
  const remove = db.prepare("DELETE FROM position_opening WHERE id=?");
  for (const id of ids) remove.run(id);
}

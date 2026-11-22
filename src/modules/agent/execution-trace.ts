import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ExecutionTraceStatus = "received" | "dry_run" | "succeeded" | "failed";

export interface ExecutionTraceInput {
  traceId?: string;
  sessionKey?: string;
  deviceCode?: string;
  customerId?: number;
  positionId: number;
  engine?: "agent" | "dify" | "unknown";
  flowVersion?: number;
  flowStatus?: string;
  stage?: string;
  nodeKey?: string;
  requestText: string;
  facts?: Record<string, string>;
  factSources?: Record<string, unknown>;
  scripts?: Array<Record<string, unknown>>;
  status: ExecutionTraceStatus;
  errorCode?: string;
  errorMessage?: string;
  model?: string;
  usage?: Record<string, unknown>;
  latencyMs?: number;
  reply?: Record<string, unknown>;
}

export function newExecutionTraceId(): string {
  return `agent-trace-${randomUUID()}`;
}

function json(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

export function writeExecutionTrace(db: DatabaseSync, input: ExecutionTraceInput): string {
  const traceId = input.traceId || newExecutionTraceId();
  db.prepare(
    `INSERT INTO agent_execution_trace(
       trace_id,session_key,device_code,customer_id,position_id,engine,
       flow_version,flow_status,stage,node_key,request_text,facts_json,
       fact_sources_json,scripts_json,status,error_code,error_message,model,
       usage_json,latency_ms,reply_json,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT(trace_id) DO UPDATE SET
       status=excluded.status,error_code=excluded.error_code,error_message=excluded.error_message,
       model=excluded.model,usage_json=excluded.usage_json,latency_ms=excluded.latency_ms,
       reply_json=excluded.reply_json,stage=excluded.stage,node_key=excluded.node_key,
       updated_at=CURRENT_TIMESTAMP`,
  ).run(
    traceId,
    String(input.sessionKey || "").slice(0, 120),
    String(input.deviceCode || "").slice(0, 120),
    Number(input.customerId || 0),
    Number(input.positionId || 0),
    input.engine || "agent",
    Number(input.flowVersion || 0),
    String(input.flowStatus || "").slice(0, 32),
    String(input.stage || "").slice(0, 200),
    String(input.nodeKey || "").slice(0, 120),
    String(input.requestText || "").slice(0, 2000),
    json(input.facts, "{}"),
    json(input.factSources, "{}"),
    json(input.scripts, "[]"),
    input.status,
    String(input.errorCode || "").slice(0, 80),
    String(input.errorMessage || "").slice(0, 1000),
    String(input.model || "").slice(0, 120),
    json(input.usage, "{}"),
    Math.max(0, Math.trunc(Number(input.latencyMs || 0))),
    json(input.reply, "{}"),
  );
  return traceId;
}

export function readExecutionTrace(db: DatabaseSync, traceId: string): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT * FROM agent_execution_trace WHERE trace_id=?").get(traceId) as Record<string, unknown> | undefined;
  return row ? serializeExecutionTrace(row) : undefined;
}

export function listExecutionTraces(
  db: DatabaseSync,
  filters: { traceId?: string; sessionKey?: string; deviceCode?: string; positionId?: number; limit?: number },
): Record<string, unknown>[] {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (filters.traceId) { where.push("trace_id=?"); values.push(filters.traceId); }
  if (filters.sessionKey) { where.push("session_key=?"); values.push(filters.sessionKey); }
  if (filters.deviceCode) { where.push("device_code=?"); values.push(filters.deviceCode); }
  if (filters.positionId && filters.positionId > 0) { where.push("position_id=?"); values.push(filters.positionId); }
  const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit || 50)));
  const rows = db.prepare(
    `SELECT * FROM agent_execution_trace${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(...values, limit) as Array<Record<string, unknown>>;
  return rows.map(serializeExecutionTrace);
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function serializeExecutionTrace(row: Record<string, unknown>): Record<string, unknown> {
  return {
    trace_id: String(row.trace_id || ""),
    session_key: String(row.session_key || ""),
    device_code: String(row.device_code || ""),
    customer_id: Number(row.customer_id || 0),
    position_id: Number(row.position_id || 0),
    engine: String(row.engine || "unknown"),
    flow_version: Number(row.flow_version || 0),
    flow_status: String(row.flow_status || ""),
    stage: String(row.stage || ""),
    node_key: String(row.node_key || ""),
    request_text: String(row.request_text || ""),
    facts: parseJson(row.facts_json, {}),
    fact_sources: parseJson(row.fact_sources_json, {}),
    scripts: parseJson(row.scripts_json, []),
    status: String(row.status || "received"),
    error_code: String(row.error_code || ""),
    error_message: String(row.error_message || ""),
    model: String(row.model || ""),
    usage: parseJson(row.usage_json, {}),
    latency_ms: Number(row.latency_ms || 0),
    reply: parseJson(row.reply_json, {}),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

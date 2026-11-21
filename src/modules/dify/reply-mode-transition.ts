import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ReplyProvider = "agent" | "dify";
type Phase = "idle" | "waiting" | "applying" | "completed" | "cancelled";
type ModeRow = {
  device_code: string; id: string; parent_id: string; generation: string; phase: Phase; effective: ReplyProvider; target: ReplyProvider;
  started_at: number; updated_at: number; client_at: number; client_ready: number; issue: string; rollback: number;
};
export function replyModeRow(db: DatabaseSync, code: string): ModeRow | undefined {
  return db.prepare("SELECT * FROM reply_mode_transition WHERE device_code=?").get(code) as ModeRow | undefined;
}
export function replyModePending(db: DatabaseSync, code: string): boolean {
  const phase = replyModeRow(db, code)?.phase;
  return phase === "waiting" || phase === "applying";
}
export function replyModeView(db: DatabaseSync, code: string, provider: ReplyProvider) {
  const row = replyModeRow(db, code);
  const now = Date.now();
  return {
    id: row?.id || "", generation: row?.generation || "",
    target_generation: row && !row.rollback && replyModePending(db, code) ? row.id : row?.generation || "", phase: row?.phase || "idle",
    effective: row?.effective || provider, target: row?.target || provider,
    supported: Boolean(row?.client_at), client_connected: Boolean(row?.client_at && now - row.client_at <= 60_000),
    started_at: row?.started_at || null, updated_at: row?.updated_at || null,
    client_ready: Boolean(row?.client_ready && now - row.client_at <= 60_000),
    client_at: row?.client_at || null, issue: row?.issue || "", rollback: Boolean(row?.rollback),
    server_time: now, elapsed_seconds: row?.started_at ? Math.floor(((row.phase === "completed" || row.phase === "cancelled" ? row.updated_at : now) - row.started_at) / 1000) : 0,
  };
}
export function beginReplyMode(db: DatabaseSync, code: string, target: ReplyProvider, rollback: boolean) {
  const now = Date.now();
  return db.prepare("UPDATE reply_mode_transition SET parent_id=id,id=?,phase='waiting',target=?,started_at=?,updated_at=?,issue='',rollback=?,client_ready=0 WHERE device_code=?")
    .run(randomUUID(), target, now, now, Number(rollback), code);
}

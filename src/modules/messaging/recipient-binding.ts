import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Status = "conflict" | "awaiting" | "verified" | "needs_confirmation";
export interface RecipientBinding {
  status: Status;
  remark: string;
}

type DeviceStatus = Exclude<Status, "awaiting">;
export type RecipientBindingReport = {
  account_id: string;
  conversation_id: string;
  status: DeviceStatus;
  remark: string;
};

export function isDirectRecipient(account: string, conversation: string): boolean {
  if (!account || !conversation.startsWith("S:")) return false;
  const members = conversation.slice(2);
  const prefix = `${account}_`;
  const suffix = `_${account}`;
  const peer = members.startsWith(prefix) ? members.slice(prefix.length)
    : members.endsWith(suffix) ? members.slice(0, -suffix.length) : "";
  return Boolean(peer && peer !== account);
}

export function recipientBindings(db: DatabaseSync, device: string, account: string) {
  return db.prepare(
    `SELECT conversation_id,status,coalesce(remark,'') AS remark FROM recipient_bindings
     WHERE device_code=? AND account_id=? ORDER BY conversation_id`,
  ).all(device, account) as unknown as Array<RecipientBinding & { conversation_id: string }>;
}

export function readRecipientBinding(db: DatabaseSync, device: string, account: string, conversation: string) {
  return db.prepare(
    `SELECT status,coalesce(remark,'') AS remark FROM recipient_bindings
     WHERE device_code=? AND account_id=? AND conversation_id=?`,
  ).get(device, account, conversation) as RecipientBinding | undefined;
}

export function issueRecipientRemark(db: DatabaseSync, device: string, account: string, conversation: string) {
  // Leave the issued code stable on repeat clicks. Renew only after invalidation.
  db.prepare(`UPDATE recipient_bindings SET status='awaiting',remark=?
    WHERE device_code=? AND account_id=? AND conversation_id=? AND status IN ('conflict','needs_confirmation')`)
    .run(`CR${randomBytes(8).toString("hex")}`, device, account, conversation);
  return readRecipientBinding(db, device, account, conversation);
}

export function reportRecipientBinding(db: DatabaseSync, device: string, report: RecipientBindingReport) {
  const { account_id: account, conversation_id: conversation, status, remark } = report;
  if (status === "conflict") {
    db.prepare(`INSERT INTO recipient_bindings(device_code,account_id,conversation_id,status)
      VALUES (?,?,?,'conflict') ON CONFLICT(device_code,account_id,conversation_id) DO NOTHING`)
      .run(device, account, conversation);
  } else {
    const previous = status === "verified" ? "awaiting" : "verified";
    const updated = db.prepare(`UPDATE recipient_bindings SET status=?
      WHERE device_code=? AND account_id=? AND conversation_id=? AND remark=? AND status IN (?,?)`)
      .run(status, device, account, conversation, remark, previous, status);
    if (!updated.changes) return undefined;
  }
  return readRecipientBinding(db, device, account, conversation);
}

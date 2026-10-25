import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MessageChannelProvider, OutboundMessageInput, OutboundMessageResult } from "./message-channel-provider.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class BridgeError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
interface BridgeDevice { device_code: string; account_id: string; state: string; heartbeat_at: number }
export interface BridgeCommand {
  id: string; device_code: string; customer_id: number; contact_id: string; content: string;
  status: string; lease_token: string; message_id: string; simulated: number; idempotency_key: string;
}

export class DeviceBridgeStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  enabled(code: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND status='enabled'").get(code));
  }
  pair(code: string): string {
    if (!this.enabled(code)) throw new BridgeError("Enabled device not found", 404);
    const token = randomBytes(32).toString("hex");
    this.db.prepare(`INSERT INTO bridge_devices(device_code,token_hash) VALUES (?,?)
      ON CONFLICT(device_code) DO UPDATE SET token_hash=excluded.token_hash,state='offline',heartbeat_at=0`).run(code, digest(token));
    // Rotating credentials cannot silently replay commands that may have been sent.
    this.db.prepare("UPDATE bridge_commands SET status=CASE WHEN status='claimed' THEN 'unknown' ELSE 'failed' END WHERE device_code=? AND status IN ('claimed','queued')").run(code);
    return token;
  }
  authenticate(code: string, token: string): boolean {
    const row = this.db.prepare("SELECT token_hash FROM bridge_devices WHERE device_code=?").get(code) as { token_hash: string } | undefined;
    return Boolean(row && timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(digest(token), "hex")));
  }
  status(code: string): BridgeDevice | null {
    const row = this.db.prepare("SELECT device_code,account_id,state,heartbeat_at FROM bridge_devices WHERE device_code=?").get(code) as unknown as BridgeDevice | undefined;
    if (!row) return null;
    return { ...row, state: row.state === "online" && this.now() - row.heartbeat_at > 60_000 ? "offline" : row.state };
  }
  heartbeat(code: string, state: "online" | "offline" | "scanning", accountId = ""): void {
    const device = this.status(code);
    if (!device) throw new BridgeError("Device not paired", 404);
    if (state === "online" && !accountId) throw new BridgeError("Logged-in account id is required", 422);
    if (accountId && device.account_id && accountId !== device.account_id) throw new BridgeError("Device is bound to a different account");
    this.db.prepare("UPDATE bridge_devices SET state=?,heartbeat_at=?,account_id=CASE WHEN ?<>'' THEN ? ELSE account_id END WHERE device_code=?")
      .run(state, this.now(), accountId, accountId, code);
  }
  contact(code: string, contactId: string, nickname: string): number {
    const existing = this.db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=? AND contact_id=?").get(code, contactId) as { customer_id: number } | undefined;
    if (existing) return existing.customer_id;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const customerId = Number((this.db.prepare(`SELECT MAX(value)+1 AS id FROM (
        SELECT COALESCE(MAX(customer_id),0) value FROM agent_conversations UNION ALL
        SELECT COALESCE(MAX(customer_id),0) FROM bridge_contacts UNION ALL SELECT 0)`)
        .get() as { id: number }).id);
      this.db.prepare("INSERT INTO bridge_contacts(device_code,contact_id,customer_id,nickname) VALUES (?,?,?,?)").run(code, contactId, customerId, nickname);
      this.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname) VALUES (?,?,?)").run(code, customerId, nickname);
      this.db.exec("COMMIT");
      return customerId;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  inboundEvent(code: string, eventId: string, contactId: string, content: string): string {
    const hash = digest(JSON.stringify([contactId, content]));
    const old = this.db.prepare("SELECT content_hash FROM bridge_inbound WHERE device_code=? AND event_id=?").get(code, eventId) as { content_hash: string } | undefined;
    if (old && old.content_hash !== hash) throw new BridgeError("Inbound event id was reused with different content");
    this.db.prepare("INSERT OR IGNORE INTO bridge_inbound(device_code,event_id,content_hash) VALUES (?,?,?)").run(code, eventId, hash);
    return `bridge-inbound:${digest(JSON.stringify([code, eventId]))}`;
  }
  enqueue(input: OutboundMessageInput): BridgeCommand {
    const old = this.db.prepare("SELECT * FROM bridge_commands WHERE device_code=? AND idempotency_key=?").get(input.deviceCode, input.idempotencyKey) as unknown as BridgeCommand | undefined;
    if (old) {
      if (old.customer_id !== input.customerId || old.content !== input.content) throw new BridgeError("Bridge idempotency conflict");
      return old;
    }
    if (!this.enabled(input.deviceCode) || this.status(input.deviceCode)?.state !== "online") throw new BridgeError("Message device is offline");
    const mapping = this.db.prepare("SELECT contact_id FROM bridge_contacts WHERE device_code=? AND customer_id=?").get(input.deviceCode, input.customerId) as { contact_id: string } | undefined;
    if (!mapping) throw new BridgeError("Contact mapping required");
    const id = randomUUID();
    this.db.prepare("INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.deviceCode, input.customerId, mapping.contact_id, input.content, input.idempotencyKey, this.now());
    return this.command(id)!;
  }
  command(id: string): BridgeCommand | null {
    return this.db.prepare("SELECT * FROM bridge_commands WHERE id=?").get(id) as unknown as BridgeCommand ?? null;
  }
  claim(code: string): BridgeCommand | null {
    this.db.prepare("UPDATE bridge_commands SET status='unknown' WHERE device_code=? AND status='claimed' AND lease_until<=?").run(code, this.now());
    if (this.status(code)?.state !== "online") return null;
    const next = this.db.prepare("SELECT id FROM bridge_commands WHERE device_code=? AND status='queued' ORDER BY created_at,rowid LIMIT 1").get(code) as { id: string } | undefined;
    if (!next) return null;
    const claimed = this.db.prepare("UPDATE bridge_commands SET status='claimed',lease_token=?,lease_until=? WHERE id=? AND status='queued'")
      .run(randomBytes(24).toString("hex"), this.now() + 60_000, next.id);
    return claimed.changes ? this.command(next.id) : null;
  }
  receipt(code: string, id: string, lease: string, status: "succeeded" | "failed" | "unknown", messageId = "", simulated = false): void {
    const command = this.command(id);
    if (!command || command.device_code !== code || !lease || command.lease_token !== lease) throw new BridgeError("Invalid command receipt", 403);
    if (status === "succeeded" && !messageId.trim()) throw new BridgeError("Successful receipt requires message_id", 422);
    if (["succeeded", "failed"].includes(command.status)) {
      if (command.status !== status || command.message_id !== messageId) throw new BridgeError("Conflicting receipt");
    }
    this.db.prepare("UPDATE bridge_commands SET status=?,message_id=?,simulated=?,receipt_at=COALESCE(receipt_at,?) WHERE id=?").run(status, messageId, simulated ? 1 : 0, this.now(), id);
    if (status === "succeeded") {
      // Reconcile late receipts even after the original HTTP request timed out.
      const delivery = this.db.prepare("SELECT id FROM message_deliveries WHERE event_id=?").get(command.idempotency_key) as { id: number } | undefined;
      if (!delivery) return;
      const sourceEvent = command.idempotency_key.endsWith(":reply")
        ? command.idempotency_key.slice(0, -6) + ":outbound" : command.idempotency_key + ":outbound";
      this.db.prepare("UPDATE message_deliveries SET status='succeeded',provider_message_id=?,last_error=NULL,next_retry_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(messageId, delivery.id);
      this.db.prepare("INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,source_event_id) VALUES (?,?,'outbound',?,?,?)")
        .run(code, command.customer_id, command.content, simulated ? "simulated" : "sent", sourceEvent);
      this.db.prepare("UPDATE agent_messages SET status=? WHERE source_event_id=?").run(simulated ? "simulated" : "sent", sourceEvent);
      const stamp = (this.db.prepare("SELECT receipt_at FROM bridge_commands WHERE id=?").get(id) as { receipt_at: number }).receipt_at;
      this.db.prepare("UPDATE agent_conversations SET last_msg=?,last_msg_at=?,updated_at=CURRENT_TIMESTAMP WHERE device_code=? AND customer_id=? AND (last_msg_at IS NULL OR julianday(last_msg_at)<=julianday(?))")
        .run(command.content, new Date(stamp).toISOString(), code, command.customer_id, new Date(stamp).toISOString());
      const activation = /^activation-send:(\d+):(\d+)$/.exec(command.idempotency_key);
      if (activation) this.db.prepare("UPDATE activation_records SET status='sent',tier=?,script=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tier=? AND status IN ('pending_send','pending_review')")
        .run(Number(activation[2]), command.content, Number(activation[1]), Number(activation[2])-1);
    }
  }
}

export class DeviceBridgeChannelProvider implements MessageChannelProvider {
  constructor(private readonly store: DeviceBridgeStore, private readonly timeoutMs = 30_000) {}
  async sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult> {
    let command: BridgeCommand;
    try { command = this.store.enqueue(input); }
    catch (error) { return { success: false, error: error instanceof BridgeError ? error.message : "Bridge enqueue failed" }; }
    const deadline = Date.now() + this.timeoutMs;
    do {
      const current = this.store.command(command.id)!;
      if (current.status === "succeeded") return { success: true, message_id: current.message_id, ...(current.simulated ? { simulated: true } : {}) };
      if (["failed", "unknown"].includes(current.status)) return { success: false, error: `Device delivery ${current.status}; inspect command ${command.id}` };
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    const final = this.store.command(command.id)!;
    if (final.status === "succeeded") return { success: true, message_id: final.message_id, ...(final.simulated ? { simulated: true } : {}) };
    return { success: false, error: `Device receipt pending; retry with the same idempotency key (${command.id})` };
  }
}

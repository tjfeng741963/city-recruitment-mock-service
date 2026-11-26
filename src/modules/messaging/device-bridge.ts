import { replyModePending } from "../dify/reply-mode-transition.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DIFY_GROUP_NOTIFICATION_PREFIX, deviceInviteGroupBinding, ensureGroupConversation, resolveDeviceInviteGroup } from "../../shared/invite-group.js";
import type { MessageChannelProvider, OutboundMessageInput, OutboundMessageResult } from "./message-channel-provider.js";
import { NOOP_NOTIFIER, type StreamNotifier } from "./stream-events.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class BridgeError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
interface BridgeDevice { device_code: string; account_id: string; state: string; heartbeat_at: number }
export interface BridgeCommand {
  id: string; device_code: string; customer_id: number; contact_id: string; content: string;
  status: string; lease_token: string; message_id: string; simulated: number; idempotency_key: string;
  created_at: number;
  /** message（默认，发消息）| refresh_login_qr（让客户端刷新登录二维码） */
  kind: string;
}
const commandSource = (command: BridgeCommand) => command.idempotency_key.endsWith(":reply")
  ? command.idempotency_key.slice(0, -6) + ":outbound" : command.idempotency_key + ":outbound";
const normalizedText = (text: string) => text.replace(/\r\n?/g, "\n").trim();
const isDifyReminder = (command: BridgeCommand) => command.idempotency_key.startsWith("followup:") && command.idempotency_key.endsWith(":dify");

export class DeviceBridgeStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now,
    private readonly notifier: StreamNotifier = NOOP_NOTIFIER) {}

  enabled(code: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND status='enabled'").get(code));
  }
  pair(code: string): string {
    if (!this.enabled(code)) throw new BridgeError("Enabled device not found", 404);
    const token = randomBytes(32).toString("hex");
    const pending = this.db.prepare("SELECT * FROM bridge_commands WHERE device_code=? AND status IN ('claimed','queued')").all(code) as unknown as BridgeCommand[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO bridge_devices(device_code,token_hash) VALUES (?,?)
        ON CONFLICT(device_code) DO UPDATE SET token_hash=excluded.token_hash,state='offline',heartbeat_at=0`).run(code, digest(token));
      this.db.prepare("UPDATE reply_mode_transition SET client_at=0,client_ready=0 WHERE device_code=?").run(code);
      this.db.prepare("DELETE FROM windows_runtime_health WHERE device_code=?").run(code);
      // Rotating credentials cannot silently replay commands that may have been sent.
      for (const command of pending) {
        command.status = command.status === "claimed" ? "unknown" : "failed";
        this.db.prepare("UPDATE bridge_commands SET status=? WHERE id=?").run(command.status, command.id);
        this.applyUnconfirmed(command, command.status as "unknown" | "failed");
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    for (const command of pending) this.notifyUnconfirmed(command);
    return token;
  }
  expireClaims(code: string): void {
    const expired = this.db.prepare("SELECT * FROM bridge_commands WHERE device_code=? AND status='claimed' AND lease_until<=?")
      .all(code, this.now()) as unknown as BridgeCommand[];
    if (!expired.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const command of expired) {
        this.db.prepare("UPDATE bridge_commands SET status='unknown' WHERE id=?").run(command.id);
        this.applyUnconfirmed(command, "unknown");
        command.status = "unknown";
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    for (const command of expired) this.notifyUnconfirmed(command);
  }
  private notifyUnconfirmed(command: BridgeCommand): void {
    this.notifier.commandUpdated(command.device_code, {
      id: command.id, customer_id: command.customer_id, status: command.status,
      error: command.status === "unknown" ? "Device outcome unknown; manual review required" : "Device reported delivery failure",
    });
  }
  private applyUnconfirmed(command: BridgeCommand, status: "unknown" | "failed"): void {
    this.db.prepare("UPDATE agent_messages SET status=? WHERE source_event_id=? AND direction='outbound'").run(status, commandSource(command));
    this.db.prepare("UPDATE message_deliveries SET status=?,last_error=?,next_retry_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE event_id=?")
      .run(status === "unknown" ? "sending" : "failed",
        status === "unknown" ? "Device outcome unknown; manual review required" : "Device reported delivery failure", command.idempotency_key);
  }
  private refreshConversationPreview(code: string, customerId: number): void {
    // A late observation can correct a receipt's provisional send time backwards.
    const latest = this.db.prepare("SELECT content,created_at FROM agent_messages WHERE device_code=? AND customer_id=? ORDER BY julianday(created_at) DESC,id DESC LIMIT 1")
      .get(code, customerId) as { content: string; created_at: string } | undefined;
    if (latest) this.db.prepare("UPDATE agent_conversations SET last_msg=?,last_msg_at=?,updated_at=CURRENT_TIMESTAMP WHERE device_code=? AND customer_id=? AND (last_msg IS NOT ? OR last_msg_at IS NOT ?)")
      .run(latest.content, latest.created_at, code, customerId, latest.content, latest.created_at);
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
  runtimeHealth(code: string) {
    const row = this.db.prepare("SELECT * FROM windows_runtime_health WHERE device_code=?").get(code) as {
      observed_at: number; wecom_available: number; reply_ready: number; reason: string; sync_state: string; backlog: number;
    } | undefined;
    if (!row) return null;
    const connected = this.now() - row.observed_at <= 60_000;
    return {
      connected, wecom_available: connected && Boolean(row.wecom_available),
      reply_ready: connected && Boolean(row.reply_ready),
      reason: connected ? row.reason : "heartbeat_timeout",
      sync: connected ? row.sync_state : "unknown", backlog: row.backlog,
    };
  }

  clearRuntimeHealth(code: string) {
    this.db.prepare("DELETE FROM windows_runtime_health WHERE device_code=?").run(code);
  }

  updateRuntimeHealth(code: string, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    const reasons = ["ready", "starting", "loop_stalled", "authorization", "wechat_login",
      "wechat_unavailable", "desktop_unavailable", "reply_paused", "auto_send_failed"];
    const reason = typeof data.reason === "string" && reasons.includes(data.reason) ? data.reason : "reply_paused";
    const sync = typeof data.sync === "string" && ["unknown", "current", "catching_up", "error"].includes(data.sync) ? data.sync : "unknown";
    const backlog = typeof data.backlog === "number" && Number.isSafeInteger(data.backlog)
      ? Math.max(0, Math.min(1_000_000, data.backlog)) : 0;
    const old = this.runtimeHealth(code);
    const available = data.wecom_available === true;
    const ready = available && data.reply_ready === true && reason === "ready";
    this.db.prepare("INSERT INTO windows_runtime_health VALUES (?,?,?,?,?,?,?) ON CONFLICT(device_code) DO UPDATE SET observed_at=excluded.observed_at,wecom_available=excluded.wecom_available,reply_ready=excluded.reply_ready,reason=excluded.reason,sync_state=excluded.sync_state,backlog=excluded.backlog")
      .run(code, this.now(), Number(available), Number(ready), reason, sync, backlog);
    if (old && old.reply_ready !== ready) {
      const state = ready ? "online" : "offline";
      const transition = ready ? "reply_ready" : reason;
      this.db.prepare("INSERT INTO device_events(device_code,event_type,reason,created_at) VALUES (?,?,?,?)")
        .run(code, state, transition, new Date(this.now()).toISOString());
      this.notifier.deviceUpdated(code, state, transition);
    }
  }

  heartbeat(code: string, state: "online" | "offline" | "scanning", accountId = ""): void {
    const device = this.status(code);
    if (!device) throw new BridgeError("Device not paired", 404);
    if (state === "online" && !accountId) throw new BridgeError("Logged-in account id is required", 422);
    // 绑定以客户端实时上报为准（2026-11-15 业务口径）。
    // 原来「账号不一致就 409」把设备钉死在首次登录的账号上：客户端换号后
    // 每次心跳都被拒（实测 Device is bound to a different account），
    // 设备被判离线，看板/会话同步整段断流。现在改成跟随客户端并留一条
    // 审计事件，运营仍能查到「这台设备什么时候换过号」。
    const previousAccount = device.account_id ?? "";
    const rebound = Boolean(accountId && previousAccount && accountId !== previousAccount);
    // status() 返回的是生效状态（超时的 online 已折算成 offline），所以这里
    // 的“变化”与路由层观察到的一致：设备重复上报同一状态时既不落流水也不推送。
    const changed = device.state !== state;
    this.db.prepare("UPDATE bridge_devices SET state=?,heartbeat_at=?,account_id=CASE WHEN ?<>'' THEN ? ELSE account_id END WHERE device_code=?")
      .run(state, this.now(), accountId, accountId, code);
    if (rebound) {
      this.db.prepare("INSERT INTO device_events(device_code,event_type,reason,created_at) VALUES (?,?,?,?)")
        .run(code, "account_rebound", `${previousAccount}->${accountId}`, new Date(this.now()).toISOString());
      this.db.prepare("DELETE FROM device_group_chats WHERE device_code=?").run(code);
      this.db.prepare("UPDATE device_group_snapshots SET synced_at=0 WHERE device_code=?").run(code);
    }
    if (changed) {
      // 掉线事件流水：推送节流以它为基准，重启不丢。
      this.db.prepare("INSERT INTO device_events(device_code,event_type,reason,created_at) VALUES (?,?,?,?)")
        .run(code, state, "reported", new Date(this.now()).toISOString());
      this.notifier.deviceUpdated(code, state, "reported");
    }
    // The admin UI (GET /api/v1/agent/devices) reads online/last_online from
    // agent_devices.data_json, not from bridge_devices — mirror each heartbeat
    // there so the Vue device dot follows the bridge state.
    this.syncAgentDevice(code, state === "online");
  }

  /**
   * 心跳超时清扫：把 `state='online'` 且超过 60s 没有心跳的设备条件 UPDATE 成
   * offline。只有 rowcount>0 的行才落 device_events(reason='heartbeat_timeout')
   * 并计入返回列表——重复扫描天然幂等，不会重复推送。调用方（server.ts 定时器）
   * 负责对扫到的设备逐个 notifier.deviceUpdated(code, "offline")。
   */
  sweepStale(): string[] {
    const cutoff = this.now() - 60_000;
    const stale = this.db.prepare("SELECT device_code FROM bridge_devices WHERE state='online' AND heartbeat_at<?")
      .all(cutoff) as unknown as Array<{ device_code: string }>;
    if (!stale.length) return [];
    const swept: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { device_code } of stale) {
        const flipped = this.db.prepare("UPDATE bridge_devices SET state='offline' WHERE device_code=? AND state='online' AND heartbeat_at<?")
          .run(device_code, cutoff);
        if (flipped.changes) {
          swept.push(device_code);
          this.db.prepare("INSERT INTO device_events(device_code,event_type,reason,created_at) VALUES (?,'offline','heartbeat_timeout',?)")
            .run(device_code, new Date(this.now()).toISOString());
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    for (const code of swept) this.syncAgentDevice(code, false);
    return swept;
  }

  private syncAgentDevice(code: string, online: boolean): void {
    const row = this.db.prepare("SELECT id,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as { id: number; data_json: string } | undefined;
    if (!row) return;
    const data = JSON.parse(row.data_json || "{}") as Record<string, unknown>;
    data.online = online;
    if (online) data.last_online = new Date(this.now()).toISOString();
    this.db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(data), row.id);
  }

  /**
   * 保存企微登录二维码截图（每个设备只留最新一张）。
   *
   * 为什么按 device_code 覆盖而不是追加：二维码约 2 分钟刷新一次，历史帧对
   * 扫码者毫无用处；一张 PNG base64 几百 KB，留着会让 SQLite 迅速膨胀。
   */
  saveLoginQr(code: string, imageB64: string, width: number, height: number, capturedAt: string): void {
    if (!this.enabled(code)) throw new BridgeError("Enabled device not found", 404);
    this.db.prepare(`INSERT INTO device_login_qr(device_code,image_b64,width,height,captured_at,updated_at)
      VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(device_code) DO UPDATE SET image_b64=excluded.image_b64,width=excluded.width,
        height=excluded.height,captured_at=excluded.captured_at,updated_at=CURRENT_TIMESTAMP`)
      .run(code, imageB64, Math.max(0, Math.trunc(width)), Math.max(0, Math.trunc(height)), capturedAt);
  }

  /** 读最新二维码；没有返回 null（网页据此显示「正在等设备上传」）。 */
  loginQr(code: string): { image_b64: string; width: number; height: number; captured_at: string; updated_at: string } | null {
    const row = this.db.prepare("SELECT image_b64,width,height,captured_at,updated_at FROM device_login_qr WHERE device_code=?")
      .get(code) as { image_b64: string; width: number; height: number; captured_at: string; updated_at: string } | undefined;
    return row ?? null;
  }

  /** 登录恢复后清掉残留二维码，避免网页继续显示已经失效的旧图。 */
  clearLoginQr(code: string): void {
    this.db.prepare("DELETE FROM device_login_qr WHERE device_code=?").run(code);
  }

  /** 分配一个新的客户编号。
   *
   * 只统计整数 customer_id：群聊会话的 customer_id 是字符串（如「预约报名群」），
   * 一旦混进来，SQLite 的 MAX() 会返回文本（TEXT 类型排序高于 INTEGER），
   * 再 +1 得到 1，与已有客户撞 UNIQUE(device_code,customer_id)，整条上报 500。
   * 2026-11-26 生产上 64 条消息就是这样卡了两天（客户端遇 500 会 break 整个队列）。
   */
  private allocateCustomerId(): number {
    const row = this.db.prepare(`SELECT MAX(value) AS id FROM (
      SELECT MAX(customer_id) value FROM agent_conversations WHERE typeof(customer_id)='integer' UNION ALL
      SELECT MAX(customer_id) FROM bridge_contacts WHERE typeof(customer_id)='integer' UNION ALL
      SELECT 0)`).get() as { id: number | null } | undefined;
    return Number(row?.id ?? 0) + 1;
  }

  contact(code: string, contactId: string, nickname: string): number {
    const existing = this.db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=? AND contact_id=?").get(code, contactId) as { customer_id: number } | undefined;
    if (existing) {
      // 老会话的 external_conversation_id 是空的，顺手补上：8090 推档案要靠它定位
      this.db.prepare("UPDATE agent_conversations SET external_conversation_id=? WHERE device_code=? AND customer_id=? AND (external_conversation_id IS NULL OR external_conversation_id='')")
        .run(contactId, code, existing.customer_id);
      return existing.customer_id;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const customerId = this.allocateCustomerId();
      this.db.prepare("INSERT INTO bridge_contacts(device_code,contact_id,customer_id,nickname) VALUES (?,?,?,?)").run(code, contactId, customerId, nickname);
      this.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES (?,?,?,?)").run(code, customerId, nickname, contactId);
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
  observeOutbound(code: string, eventId: string, contactId: string, content: string, nickname: string, sentAt?: string) {
    const hash = digest(JSON.stringify([contactId, content, sentAt ?? null]));
    const old = this.db.prepare("SELECT content_hash,source_event_id FROM bridge_outbound WHERE device_code=? AND event_id=?")
      .get(code, eventId) as { content_hash: string; source_event_id: string } | undefined;
    if (old && old.content_hash !== hash) throw new BridgeError("Outbound event id was reused with different content");
    const customerId = this.contact(code, contactId, nickname);
    if (old) return { customer_id: customerId, source_event_id: old.source_event_id, created: false };

    const command = this.db.prepare("SELECT * FROM bridge_commands WHERE device_code=? AND message_id=? AND status='succeeded' AND simulated=0")
      .get(code, eventId) as unknown as BridgeCommand | undefined;
    if (command && (command.contact_id !== contactId || normalizedText(command.content) !== normalizedText(content))) throw new BridgeError("Observed message conflicts with command receipt");
    const sourceEventId = command ? commandSource(command) : `bridge-outbound:${digest(JSON.stringify([code, eventId]))}`;
    const stamp = sentAt ?? new Date(this.now()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO bridge_outbound(device_code,event_id,contact_id,content_hash,source_event_id) VALUES (?,?,?,?,?)")
        .run(code, eventId, contactId, hash, sourceEventId);
      const inserted = this.db.prepare("INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?,'outbound',?,'sent',?,?)")
        .run(code, customerId, content, stamp, sourceEventId);
      if (command && sentAt) {
        this.db.prepare("UPDATE agent_messages SET created_at=? WHERE source_event_id=? AND direction='outbound'").run(stamp, sourceEventId);
        this.refreshConversationPreview(code, customerId);
      } else this.db.prepare("UPDATE agent_conversations SET last_msg=?,last_msg_at=?,updated_at=CURRENT_TIMESTAMP WHERE device_code=? AND customer_id=? AND (last_msg_at IS NULL OR julianday(last_msg_at)<=julianday(?))")
        .run(content, stamp, code, customerId, stamp);
      this.db.exec("COMMIT");
      return { customer_id: customerId, source_event_id: sourceEventId, created: Number(inserted.changes) === 1 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  enqueue(input: OutboundMessageInput, { queueWhileOffline = false } = {}): BridgeCommand {
    const old = this.db.prepare("SELECT * FROM bridge_commands WHERE device_code=? AND idempotency_key=?").get(input.deviceCode, input.idempotencyKey) as unknown as BridgeCommand | undefined;
    if (old) {
      if (old.customer_id !== input.customerId || old.content !== input.content) throw new BridgeError("Bridge idempotency conflict");
      return old;
    }
    if (!this.enabled(input.deviceCode) || (!queueWhileOffline && this.status(input.deviceCode)?.state !== "online")) throw new BridgeError("Message device is offline");
    const mapping = this.db.prepare("SELECT contact_id FROM bridge_contacts WHERE device_code=? AND customer_id=?").get(input.deviceCode, input.customerId) as { contact_id: string } | undefined;
    if (!mapping) throw new BridgeError("Contact mapping required");
    const id = randomUUID();
    this.db.prepare("INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.deviceCode, input.customerId, mapping.contact_id, input.content, input.idempotencyKey, this.now());
    return this.command(id)!;
  }
  /**
   * 登录二维码刷新指令（2026-11-23）。
   *
   * 网页点「刷新二维码」时调用：写一条无正文、无联系人的指令，客户端领到后
   * 点企微登录窗的「刷新」，再立即截一帧新码上传。
   *
   * 为什么需要 kind：这条指令不发给任何客户，不能走 enqueue（它要求
   * bridge_contacts 映射）。kind 让客户端明确分支，也避免老客户端把空
   * content 当消息发出去。
   *
   * 幂等窗口默认 60 秒：同一设备一分钟内重复点只入队一条，防止连点把
   * 指令队列刷满。
   */
  enqueueRefreshQr(code: string, windowMs = 60_000): { command: BridgeCommand; created: boolean } {
    if (!this.enabled(code)) throw new BridgeError("Device disabled");
    const key = `refresh-qr:${Math.floor(this.now() / windowMs)}`;
    const find = () =>
      this.db.prepare("SELECT * FROM bridge_commands WHERE device_code=? AND idempotency_key=?")
        .get(code, key) as unknown as BridgeCommand | undefined;
    const old = find();
    if (old) return { command: old, created: false };
    const id = randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,kind,created_at)
         VALUES (?,?,0,'','',?, 'refresh_login_qr',?)`,
      ).run(id, code, key, this.now());
    } catch {
      // 并发点两次：唯一约束会挡下第二条，直接读回第一条
      const raced = find();
      if (raced) return { command: raced, created: false };
      throw new BridgeError("Failed to enqueue refresh command");
    }
    return { command: this.command(id)!, created: true };
  }
  command(id: string): BridgeCommand | null {
    return this.db.prepare("SELECT * FROM bridge_commands WHERE id=?").get(id) as unknown as BridgeCommand ?? null;
  }

  /** 给客户设置备注（2026-11-25）。
   *
   * 走同一条指令队列，客户端领到后按 kind=set_remark 执行界面操作，
   * 与消息发送串行，不会抢焦点。payload 里带 name/remark，
   * conversation_id 用于回读校验（从 S:自己_对方 里取对方 id）。
   */
  enqueueSetRemark(code: string, payload: Record<string, unknown>): BridgeCommand {
    if (!this.enabled(code)) throw new BridgeError("Enabled device not found", 404);
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,kind,created_at)
       VALUES (?,?,0,'',?,?, 'set_remark',?)`,
    ).run(id, code, JSON.stringify(payload), `set-remark:${id}`, this.now());
    return this.command(id)!;
  }
  /** 设备上报的群聊清单整体替换（device_group_chats 表）。 */
  saveGroups(code: string, groups: Array<{ conv_id: string; name: string }>, accountId?: string): number {
    const device = this.status(code);
    if (accountId !== undefined && (!accountId || device?.account_id !== accountId || device.state !== "online")) {
      throw new BridgeError("Group snapshot does not match the current logged-in account");
    }
    if (accountId === undefined && this.groupSnapshot(code)) {
      throw new BridgeError("An account-bound group snapshot is required");
    }
    // Older clients cannot distinguish an empty group list from a failed read.
    if (!groups.length && accountId === undefined) return this.listGroups(code).length;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM device_group_chats WHERE device_code=?").run(code);
      const stamp = this.now();
      const insert = this.db.prepare("INSERT INTO device_group_chats(device_code,conv_id,name,updated_at) VALUES (?,?,?,?)");
      for (const group of groups) {
        insert.run(code, group.conv_id, group.name, stamp);
      }
      if (accountId !== undefined) {
        this.db.prepare(`INSERT INTO device_group_snapshots(device_code,account_id,synced_at) VALUES (?,?,?)
          ON CONFLICT(device_code) DO UPDATE SET account_id=excluded.account_id,synced_at=excluded.synced_at`)
          .run(code, accountId, stamp);
      }
      this.db.exec("COMMIT");
      return groups.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  groupSnapshot(code: string): { account_id: string; synced_at: number } | undefined {
    return this.db.prepare("SELECT account_id,synced_at FROM device_group_snapshots WHERE device_code=?")
      .get(code) as { account_id: string; synced_at: number } | undefined;
  }

  groupSync(code: string) {
    const snapshot = this.groupSnapshot(code);
    if (!snapshot) {
      return { sync_state: this.listGroups(code).length ? "legacy" : "waiting", synced_at: null };
    }
    const current = this.status(code);
    if (!snapshot.synced_at || snapshot.account_id !== current?.account_id) {
      return { sync_state: "waiting", synced_at: null };
    }
    return { sync_state: current.state === "online" && this.now() - snapshot.synced_at <= 120_000 ? "synced" : "stale",
      synced_at: new Date(snapshot.synced_at).toISOString() };
  }

  listGroups(code: string): Array<{ conv_id: string; name: string }> {
    return this.db.prepare(`SELECT conv_id,name FROM device_group_chats g WHERE g.device_code=?
      AND g.updated_at >= COALESCE((
        SELECT unixepoch(created_at,'subsec')*1000 FROM device_events
        WHERE device_code=g.device_code AND event_type='account_rebound' ORDER BY created_at DESC LIMIT 1
      ),0) ORDER BY name`).all(code) as Array<{ conv_id: string; name: string }>;
  }

  private queueDueDifyReminder(code: string, account: string, now: number) {
    if (!account) return;
    const due = this.db.prepare(`SELECT r.archive_key, r.interview_date, r.interview_time, r.interview_address, c.customer_id
      FROM dify_interview_reminders r
      JOIN agent_archive a ON a.session_key=r.archive_key AND a.dify_device_code=r.device_code
      JOIN service_positions p ON p.id=a.position_id AND p.status='enabled'
      JOIN agent_conversations c ON c.id=a.dify_conversation_row_id AND c.device_code=r.device_code
      JOIN bridge_contacts b ON b.device_code=r.device_code AND b.customer_id=c.customer_id AND b.contact_id=a.dify_external_session
      WHERE r.device_code=? AND a.dify_account_id=? AND r.command_id IS NULL AND r.suppressed=0
        AND r.due_at<=? AND r.expires_at>? AND a.interview_confirmed=1 AND COALESCE(a.arrival_status,'')=''
        AND c.external_conversation_id=a.dify_external_session AND COALESCE(c.takeover,0)=0
        AND a.interview_date=r.interview_date AND a.interview_time=r.interview_time AND a.interview_address=r.interview_address
      ORDER BY r.due_at,r.archive_key LIMIT 1`);
    if (!due.get(code,account,now,now)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = due.get(code,account,now,now) as {archive_key:string;customer_id:number;interview_date:string;interview_time:string;interview_address:string} | undefined;
      if (task) {
        const address = task.interview_address.replace(/[【】]/g, c => c === "【" ? "〔" : "〕");
        const command = this.enqueue({deviceCode:code,customerId:task.customer_id,
          idempotencyKey:`followup:${code}:${task.customer_id}:${task.interview_date}:dify`,
          content:`提醒一下，今天的面试时间是${task.interview_time}，地点在${address}。到了给我发个消息。`,
        });
        this.db.prepare("UPDATE dify_interview_reminders SET command_id=? WHERE archive_key=?").run(command.id,task.archive_key);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 领一条指令。
   *
   * `onlyKind` 给登录态用：二维码过期时设备在服务端是 offline，消息指令本来
   * 也发不出去；客户端只要 `refresh_login_qr`，不能去碰消息队列（碰了会把
   * 真实待发消息白占 60 秒租约）。
   */
  claim(code: string, onlyKind = ""): (BridgeCommand & { nickname: string }) | null {
    this.expireClaims(code);
    const device = this.status(code);
    if (!this.enabled(code) || replyModePending(this.db, code)) return null;
    const heartbeatFresh = Boolean(device?.heartbeat_at && this.now() - device.heartbeat_at <= 60_000);
    // 刷新指令和备注指令允许在 offline（健康检查未通过）下领取，只要心跳新鲜：
    // 设置备注走的是「点通讯录改备注」，跟「能不能发消息」没有关系，用发送就绪
    // 当门槛会让它永久卡在队列里（2026-11-26：窗口黑掉时一条备注都领不出来，
    // 网页上点了也没反应）。消息指令仍要求 online，与原来一致。
    const offlineAllowed = onlyKind === "refresh_login_qr" || onlyKind === "set_remark";
    if (device?.state !== "online" && !(offlineAllowed && heartbeatFresh)) return null;
    const now = this.now();
    // Dify 提醒只在正常回复态排队；登录态只领刷新指令，不碰消息队列。
    if (!onlyKind && device?.state === "online" && this.db.prepare("SELECT 1 FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND json_extract(data_json,'$.reply_provider')='dify'").get(code)) {
      this.queueDueDifyReminder(code, device?.account_id ?? "", now);
    }
    const pending = onlyKind
      ? this.db.prepare(`SELECT c.*, NULL AS reminder_expires_at FROM bridge_commands c
          WHERE c.device_code=? AND c.status='queued' AND c.kind=? ORDER BY c.created_at,c.rowid LIMIT 1`)
      : this.db.prepare(`SELECT c.*,r.expires_at AS reminder_expires_at FROM bridge_commands c
          LEFT JOIN dify_interview_reminders r ON r.command_id=c.id
          WHERE c.device_code=? AND c.status='queued' AND (r.command_id IS NULL OR r.due_at<=?) ORDER BY c.created_at,c.rowid LIMIT 1`);
    type PendingCommand = BridgeCommand & {reminder_expires_at: number | null};
    const nextQueued = () =>
      (onlyKind ? pending.get(code, onlyKind) : pending.get(code, now)) as unknown as PendingCommand | undefined;
    let next = nextQueued();
    while (next) {
      // 刷新二维码：超 5 分钟没人领就作废（客户端可能关机了，再刷也没意义）。
      // 它不参与 dify 提醒/群通知的过滤，直接交给下面领走。
      if (next.kind === "refresh_login_qr") {
        if (this.now() - Number(next.created_at) > 5 * 60_000) {
          this.db.prepare("UPDATE bridge_commands SET status='failed' WHERE id=? AND status='queued'").run(next.id);
          next = nextQueued();
          continue;
        }
        break;
      }
      if (isDifyReminder(next)) {
        const valid = next.reminder_expires_at !== null && next.reminder_expires_at > now && this.db.prepare(`SELECT 1 FROM dify_interview_reminders r
          JOIN agent_archive a ON a.session_key=r.archive_key
          JOIN service_positions p ON p.id=a.position_id AND p.status='enabled'
          JOIN agent_devices d ON json_extract(d.data_json,'$.device_code')=a.dify_device_code AND d.status='enabled'
          JOIN agent_conversations c ON c.id=a.dify_conversation_row_id AND c.device_code=a.dify_device_code
          WHERE r.command_id=? AND r.suppressed=0 AND a.dify_device_code=? AND a.dify_account_id=? AND a.dify_external_session=?
            AND c.external_conversation_id=a.dify_external_session AND c.customer_id=? AND COALESCE(c.takeover,0)=0
            AND a.interview_confirmed=1 AND COALESCE(a.arrival_status,'')=''
            AND a.interview_date=r.interview_date AND a.interview_time=r.interview_time AND a.interview_address=r.interview_address
            AND json_extract(d.data_json,'$.reply_provider')='dify'`)
          .get(next.id,code,device?.account_id ?? "",next.contact_id,next.customer_id);
        if (valid) break;
      } else if (next.idempotency_key.startsWith("group-notify:")) {
        const group = resolveDeviceInviteGroup(this.db, code, deviceInviteGroupBinding(this.db, code));
        const switched = this.db.prepare(`SELECT 1 FROM device_events
          WHERE device_code=? AND event_type='account_rebound' AND created_at>=? LIMIT 1`)
          .get(code, new Date(Number(next.created_at) || 0).toISOString());
        if (group && group.conv_id === next.contact_id && !switched) {
          ensureGroupConversation(this.db, code, group.conv_id, group.name);
          break;
        }
      } else if (!next.idempotency_key.startsWith(DIFY_GROUP_NOTIFICATION_PREFIX)) {
        break;
      } else {
        const archiveKey = next.idempotency_key.slice(DIFY_GROUP_NOTIFICATION_PREFIX.length);
        const archive = this.db.prepare(`SELECT dify_account_id FROM agent_archive WHERE session_key=?
          AND dify_device_code=? AND interview_confirmed=1`).get(archiveKey, code) as { dify_account_id: string } | undefined;
        const group = resolveDeviceInviteGroup(this.db, code, deviceInviteGroupBinding(this.db, code));
        if (archive?.dify_account_id === device?.account_id && group?.conv_id === next.contact_id) {
          ensureGroupConversation(this.db, code, group.conv_id, group.name);
          break;
        }
      }
      if (next.idempotency_key.startsWith("group-notify:")) {
        this.db.prepare("UPDATE bridge_commands SET status='failed',error=? WHERE id=? AND status='queued'")
          .run("通知群无法核对，消息未发送。请核对群绑定后处理这条登记。", next.id);
      } else {
        this.db.prepare("UPDATE bridge_commands SET status='failed' WHERE id=? AND status='queued'").run(next.id);
      }
      next = nextQueued();
    }
    if (!next) return null;
    // 回复就绪检查只针对「发消息」。登录二维码刷新恰恰发生在未登录、不可能
    // reply_ready 的时候；设置备注也只是点通讯录改备注，不需要发送就绪。
    // 用同一条 health 门槛会把这两类指令永久卡在队列里。
    if (next.kind !== "refresh_login_qr" && next.kind !== "set_remark") {
      const health = this.runtimeHealth(code);
      if (health && !health.reply_ready && health.reason !== "auto_send_failed") return null;
    }
    const claimed = this.db.prepare("UPDATE bridge_commands SET status='claimed',lease_token=?,lease_until=? WHERE id=? AND status='queued'")
      .run(randomBytes(24).toString("hex"), Math.min(now + 60_000, next.reminder_expires_at ?? Infinity), next.id);
    if (!claimed.changes) return null;
    const command = this.command(next.id);
    if (!command) return null;
    // The device sends by typing the conversation name into the WeCom search
    // box, so the claimed payload must carry the nickname — contact_id is an
    // opaque internal id that is useless for keyboard automation.
    const conversation = this.db.prepare("SELECT nickname FROM agent_conversations WHERE device_code=? AND customer_id=?")
      .get(code, command.customer_id) as { nickname?: string } | undefined;
    return { ...command, nickname: conversation?.nickname ?? "" };
  }
  receipt(code: string, id: string, lease: string, status: "succeeded" | "failed" | "unknown", messageId = "", simulated = false, error = ""): void {
    const command = this.command(id);
    if (!command || command.device_code !== code || !lease || command.lease_token !== lease) throw new BridgeError("Invalid command receipt", 403);
    // 刷新二维码没有 message_id 可回：它不产生客户消息，回执成功不要求 message_id。
    const isRefresh = command.kind === "refresh_login_qr";
    if (status === "succeeded" && !isRefresh && !messageId.trim()) throw new BridgeError("Successful receipt requires message_id", 422);
    const groupNotice = command.idempotency_key.startsWith(DIFY_GROUP_NOTIFICATION_PREFIX)
      || (command.idempotency_key.startsWith("group-notify:") && command.contact_id.startsWith("R:"));
    if (status === "succeeded" && !simulated && !isRefresh && (groupNotice || isDifyReminder(command))) {
      const prefix = command.contact_id + ":";
      if (!messageId.startsWith(prefix) || !messageId.slice(prefix.length).trim()) {
        throw new BridgeError("Receipt does not match the target conversation", 422);
      }
    }
    if (["succeeded", "failed"].includes(command.status)) {
      if (command.status !== status || command.message_id !== messageId || Boolean(command.simulated) !== simulated) throw new BridgeError("Conflicting receipt");
      return;
    }
    // 刷新二维码不产生任何客户消息：只落指令状态和失败原因，不进消息/投递/会话表。
    // 走 applyReceipt 会去查 message_deliveries、bridge_outbound 和会话预览，
    // 对一个无正文指令全是无意义查询，还多一条误改风险。
    if (isRefresh) {
      this.db.prepare("UPDATE bridge_commands SET status=?,error=?,receipt_at=COALESCE(receipt_at,?) WHERE id=? AND status='claimed'")
        .run(status, String(error || "").slice(0, 500), this.now(), id);
      return;
    }
    // A real database message can arrive before its HTTP receipt. Reconcile by
    // the exact device message id, never by text alone.
    const observed = status === "succeeded" && !simulated ? this.db.prepare(`SELECT o.source_event_id,o.contact_id,m.content
      FROM bridge_outbound o JOIN agent_messages m ON m.source_event_id=o.source_event_id
      WHERE o.device_code=? AND o.event_id=?`).get(code, messageId) as { source_event_id: string; contact_id: string; content: string } | undefined : undefined;
    if (observed && (observed.contact_id !== command.contact_id || normalizedText(observed.content) !== normalizedText(command.content))) throw new BridgeError("Receipt conflicts with observed message");
    if (status === "succeeded" && !simulated && this.db.prepare("SELECT id FROM bridge_commands WHERE device_code=? AND message_id=? AND status='succeeded' AND id<>?").get(code, messageId, id)) throw new BridgeError("Message id already belongs to another command");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.applyReceipt(command, status, messageId, simulated, observed?.source_event_id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private applyReceipt(command: BridgeCommand, status: "succeeded" | "failed" | "unknown", messageId: string, simulated: boolean, observedSource?: string): void {
    const code = command.device_code, id = command.id;
    this.db.prepare("UPDATE bridge_commands SET status=?,message_id=?,simulated=?,receipt_at=COALESCE(receipt_at,?) WHERE id=?").run(status, messageId, simulated ? 1 : 0, this.now(), id);
    // A reply command's idempotency key is the outbound event id; the local
    // message row is `<event id>:outbound`.
    const sourceEvent = commandSource(command);
    if (status !== "succeeded") {
      this.applyUnconfirmed(command, status);
      return;
    }
    if (status === "succeeded") {
      // Reconcile late receipts even after the original HTTP request timed out.
      const delivery = this.db.prepare("SELECT id FROM message_deliveries WHERE event_id=?").get(command.idempotency_key) as { id: number } | undefined;
      if (!delivery) return;
      this.db.prepare("UPDATE message_deliveries SET status='succeeded',provider_message_id=?,last_error=NULL,next_retry_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(messageId, delivery.id);
      const observedTime = observedSource ? this.db.prepare("SELECT created_at FROM agent_messages WHERE source_event_id=?").get(observedSource) as { created_at: string } | undefined : undefined;
      const queuedTime = this.db.prepare("SELECT created_at FROM agent_messages WHERE source_event_id=?").get(sourceEvent) as { created_at: string } | undefined;
      // A delayed HTTP receipt gives no send time. Keep the queued timestamp
      // until observation supplies it, so the receipt cannot promote old text.
      const stamp = observedTime?.created_at ?? queuedTime?.created_at ?? new Date(this.now()).toISOString();
      this.db.prepare("INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?,'outbound',?,?,?,?)")
        .run(code, command.customer_id, command.content, simulated ? "simulated" : "sent", stamp, sourceEvent);
      this.db.prepare("UPDATE agent_messages SET status=?,created_at=? WHERE source_event_id=?").run(simulated ? "simulated" : "sent", stamp, sourceEvent);
      if (observedSource && observedSource !== sourceEvent) {
        // Preserve the larger id: agent_messages uses INTEGER PRIMARY KEY
        // without AUTOINCREMENT, and clients use after_id as their cursor.
        const canonical = this.db.prepare("SELECT id FROM agent_messages WHERE source_event_id=?").get(sourceEvent) as { id: number };
        const observed = this.db.prepare("SELECT id FROM agent_messages WHERE source_event_id=?").get(observedSource) as { id: number };
        if (observed.id > canonical.id) {
          this.db.prepare("DELETE FROM agent_messages WHERE id=?").run(canonical.id);
          this.db.prepare("UPDATE agent_messages SET source_event_id=? WHERE id=?").run(sourceEvent, observed.id);
        } else {
          this.db.prepare("DELETE FROM agent_messages WHERE id=?").run(observed.id);
        }
        this.db.prepare("UPDATE bridge_outbound SET source_event_id=? WHERE device_code=? AND event_id=?").run(sourceEvent, code, messageId);
      }
      this.refreshConversationPreview(code, command.customer_id);
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

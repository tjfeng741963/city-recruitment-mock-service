import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WeComConfig } from './wecom-config.js';

export const wecomEventId = (corp: string, kf: string, id: string) => 'wecom:' + createHash('sha256').update(JSON.stringify([corp,kf,id])).digest('hex');
export interface WeComConnection { cursor: string; generation: number; processed_generation: number; sync_token: string; token_expires_at: number; reply_after: number; last_sync_at: number; next_sync_at: number; last_error: string | null }
export class WeComStore {
  constructor(readonly db: DatabaseSync, readonly config: WeComConfig) {}
  ensureConnection(): void {
    const c = this.config;
    const device = this.db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(c.deviceCode) as { data_json: string } | undefined;
    if (device) {
      const data = JSON.parse(device.data_json);
      if (data.channel !== 'wecom-kf' || data.corp_id !== c.corpId || data.open_kfid !== c.openKfId) throw new Error('WeCom device code is already bound to another channel/account');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!device) this.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)")
        .run('微信客服', JSON.stringify({ device_code: c.deviceCode, channel: 'wecom-kf', corp_id: c.corpId, open_kfid: c.openKfId }));
      this.db.prepare('INSERT OR IGNORE INTO wecom_connections(corp_id,open_kfid,device_code,reply_after) VALUES (?,?,?,?)')
        .run(c.corpId,c.openKfId,c.deviceCode,Math.floor(Date.now()/1000)-5);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  connection(): WeComConnection { return this.db.prepare('SELECT * FROM wecom_connections WHERE corp_id=? AND open_kfid=?').get(this.config.corpId,this.config.openKfId) as unknown as WeComConnection; }
  notify(hash: string, token: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const added = this.db.prepare('INSERT OR IGNORE INTO wecom_callback_events VALUES (?,?)').run(hash,Date.now()).changes;
      if (added) this.db.prepare('UPDATE wecom_connections SET generation=generation+1,sync_token=?,token_expires_at=?,next_sync_at=0 WHERE corp_id=? AND open_kfid=?')
        .run(token,Date.now()+600000,this.config.corpId,this.config.openKfId);
      this.db.exec('COMMIT'); return Boolean(added);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  contact(external: string, msgid = '', time = 0): number {
    const c = this.config;
    let row = this.db.prepare('SELECT customer_id FROM wecom_contacts WHERE corp_id=? AND open_kfid=? AND external_userid=?').get(c.corpId,c.openKfId,external) as { customer_id: number } | undefined;
    if (!row) {
      const id = (this.db.prepare('SELECT COALESCE(MAX(value),0)+1 AS id FROM (SELECT COALESCE(MAX(customer_id),0) AS value FROM agent_conversations UNION ALL SELECT COALESCE(MAX(customer_id),0) AS value FROM wecom_contacts)').get() as { id: number }).id;
      this.db.prepare('INSERT INTO wecom_contacts(corp_id,open_kfid,external_userid,device_code,customer_id) VALUES (?,?,?,?,?)').run(c.corpId,c.openKfId,external,c.deviceCode,id);
      this.db.prepare('INSERT INTO agent_conversations(device_code,customer_id,nickname) VALUES (?,?,?)').run(c.deviceCode,id,'微信客服客户');
      row = { customer_id: id };
    }
    if (msgid) this.db.prepare('UPDATE wecom_contacts SET last_customer_at=?,last_customer_msgid=? WHERE customer_id=? AND last_customer_at<=?')
      .run(time*1000,msgid,row.customer_id,time*1000);
    return row.customer_id;
  }
  acceptPage(messages: Record<string, any>[], cursor: string): void {
    const c = this.config;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const msg of messages) {
        if (typeof msg.msgid !== 'string' || !msg.msgid || (msg.corp_id && msg.corp_id !== c.corpId) || (msg.open_kfid && msg.open_kfid !== c.openKfId) || (msg.event?.open_kfid && msg.event.open_kfid !== c.openKfId)) throw new Error('WeCom message identity mismatch');
        const exists = this.db.prepare('SELECT 1 FROM wecom_inbox WHERE corp_id=? AND open_kfid=? AND msgid=?').get(c.corpId,c.openKfId,msg.msgid);
        if (exists) continue;
        const text = msg.msgtype === 'text' && typeof msg.text?.content === 'string' ? msg.text.content : '';
        const customerId = [3,5].includes(msg.origin) && typeof msg.external_userid === 'string' && msg.external_userid
          ? this.contact(msg.external_userid,msg.origin === 3 ? msg.msgid : '', Number(msg.send_time)||0) : null;
        const fresh = Number(msg.send_time) >= this.connection().reply_after;
        const status = customerId && msg.origin === 3 && text.trim() && fresh ? 'queued' : 'ignored';
        this.db.prepare('INSERT INTO wecom_inbox(corp_id,open_kfid,msgid,customer_id,payload_json,status,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(c.corpId,c.openKfId,msg.msgid,customerId,JSON.stringify(msg),status,Date.now());
        if (msg.origin === 5 && customerId && text) {
          this.db.prepare("INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,source_event_id) VALUES (?,?,'outbound',?,'sent',?)")
            .run(c.deviceCode,customerId,text,wecomEventId(c.corpId,c.openKfId,msg.msgid)+':staff');
          if (fresh) this.db.prepare('UPDATE agent_conversations SET takeover=1 WHERE device_code=? AND customer_id=?').run(c.deviceCode,customerId);
        }
        if (msg.msgtype === 'event') this.applyEvent(msg.event ?? {});
      }
      this.db.prepare('UPDATE wecom_connections SET cursor=?,last_sync_at=?,last_error=NULL WHERE corp_id=? AND open_kfid=?').run(cursor,Date.now(),c.corpId,c.openKfId);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private applyEvent(event: Record<string, any>): void {
    const c = this.config;
    if (event.event_type === 'session_status_change' && typeof event.external_userid === 'string') {
      const id = this.contact(event.external_userid);
      this.db.prepare('UPDATE agent_conversations SET takeover=1 WHERE device_code=? AND customer_id=?').run(c.deviceCode,id);
    }
    if (event.event_type !== 'msg_send_fail' || typeof event.fail_msgid !== 'string') return;
    const row = this.db.prepare('SELECT idempotency_key,customer_id FROM wecom_outbox WHERE corp_id=? AND open_kfid=? AND msgid=?')
      .get(c.corpId,c.openKfId,event.fail_msgid) as { idempotency_key: string; customer_id: number } | undefined;
    if (!row) return;
    const reason = `WeCom send failure event ${Number.isInteger(event.fail_type) ? event.fail_type : 'unknown'}`;
    this.db.prepare("UPDATE wecom_outbox SET status='failed',last_error=?,updated_at=? WHERE corp_id=? AND open_kfid=? AND msgid=?")
      .run(reason,Date.now(),c.corpId,c.openKfId,event.fail_msgid);
    this.db.prepare("UPDATE message_deliveries SET status='failed',last_error=? WHERE event_id=?").run(reason,row.idempotency_key);
    const source = row.idempotency_key.endsWith(':reply') ? row.idempotency_key.slice(0,-6)+':outbound' : row.idempotency_key+':outbound';
    this.db.prepare("UPDATE agent_messages SET status='failed' WHERE source_event_id=? AND device_code=? AND customer_id=?").run(source,c.deviceCode,row.customer_id);
  }
}

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MessageChannelProvider, OutboundMessageInput, OutboundMessageResult } from '../messaging/message-channel-provider.js';
import type { WeComConfig } from './wecom-config.js';
import { WeComApiError, WeComClient } from './wecom-client.js';
import { WeComStore } from './wecom-store.js';

interface Outbox { id: number; status: string; content: string; msgid: string; external_userid: string; customer_id: number }
export class WeComKfChannel implements MessageChannelProvider {
  readonly store: WeComStore;
  private readonly customerLocks = new Map<number, Promise<void>>();
  constructor(readonly db: DatabaseSync, readonly config: WeComConfig, readonly client = new WeComClient(config)) {
    this.store = new WeComStore(db,config); this.store.ensureConnection();
  }
  async sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult> {
    const previous = this.customerLocks.get(input.customerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const chain = previous.then(() => current);
    this.customerLocks.set(input.customerId, chain);
    await previous;
    try { return await this.sendMessageLocked(input); }
    finally { release(); if (this.customerLocks.get(input.customerId) === chain) this.customerLocks.delete(input.customerId); }
  }

  private async sendMessageLocked(input: OutboundMessageInput): Promise<OutboundMessageResult> {
    const c = this.config;
    if (input.deviceCode !== c.deviceCode) return { success: false, error: 'WeCom device mapping required' };
    const contact = this.db.prepare('SELECT external_userid,last_customer_at,last_customer_msgid FROM wecom_contacts WHERE corp_id=? AND open_kfid=? AND customer_id=?')
      .get(c.corpId,c.openKfId,input.customerId) as { external_userid: string; last_customer_at: number; last_customer_msgid: string } | undefined;
    if (!contact) return { success: false, error: 'WeCom customer identity is not mapped' };
    let row = this.db.prepare('SELECT * FROM wecom_outbox WHERE corp_id=? AND open_kfid=? AND idempotency_key=?').get(c.corpId,c.openKfId,input.idempotencyKey) as unknown as Outbox | undefined;
    if (row && (row.content !== input.content || row.customer_id !== input.customerId)) return { success: false, error: 'WeCom idempotency conflict' };
    if (row?.status === 'api_accepted') return { success: true, accepted: true, message_id: row.msgid };
    if (row && row.status !== 'queued') return { success: false, error: `WeCom delivery is ${row.status}; inspect before another attempt` };
    if (!row) {
      const msgid = createHash('sha256').update(JSON.stringify([c.corpId,c.openKfId,input.idempotencyKey])).digest('hex').slice(0,32);
      this.db.prepare("INSERT OR IGNORE INTO wecom_outbox(corp_id,open_kfid,device_code,customer_id,external_userid,idempotency_key,msgid,content,window_msgid,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)")
        .run(c.corpId,c.openKfId,c.deviceCode,input.customerId,contact.external_userid,input.idempotencyKey,msgid,input.content,contact.last_customer_msgid,Date.now(),Date.now());
      row = this.db.prepare('SELECT * FROM wecom_outbox WHERE corp_id=? AND open_kfid=? AND idempotency_key=?').get(c.corpId,c.openKfId,input.idempotencyKey) as unknown as Outbox | undefined;
      if (!row) return { success: false, error: 'WeCom outbox record could not be created' };
    }
    const block = (reason: string) => { this.db.prepare("UPDATE wecom_outbox SET status='blocked',last_error=?,updated_at=? WHERE id=? AND status='queued'").run(reason,Date.now(),row!.id); return { success: false, error: reason }; };
    if (!input.content.trim() || Buffer.byteLength(input.content,'utf8') > 2048) return block('WeCom text must contain 1 to 2048 UTF-8 bytes');
    if (!contact.last_customer_at || Date.now()-contact.last_customer_at >= 48*3600000) return block('WeCom 48-hour reply window expired');
    if (!this.db.prepare("SELECT 1 FROM agent_devices WHERE status='enabled' AND json_extract(data_json,'$.device_code')=?").get(c.deviceCode)) return block('WeCom device disabled');
    const existingCount = (this.db.prepare("SELECT COUNT(*) n FROM wecom_outbox WHERE corp_id=? AND open_kfid=? AND customer_id=? AND window_msgid=? AND id<>? AND status IN ('queued','sending','api_accepted','unknown')")
      .get(c.corpId,c.openKfId,input.customerId,contact.last_customer_msgid,row.id) as { n: number }).n;
    if (existingCount >= 5) return block('WeCom five-message reply allowance exhausted');
    try {
      const state = await this.client.call('kf/service_state/get',{ open_kfid:c.openKfId, external_userid:contact.external_userid });
      if (![0,1].includes(state.service_state)) return block(`WeCom session state ${Number.isInteger(state.service_state) ? state.service_state : 'unknown'} does not permit API replies`);
      const takeover = this.db.prepare('SELECT takeover FROM agent_conversations WHERE device_code=? AND customer_id=?').get(c.deviceCode,input.customerId) as { takeover: number } | undefined;
      if (takeover?.takeover && !input.idempotencyKey.startsWith('manual-reply:')) return block('Human takeover before WeCom send');
      const claimed = this.db.prepare("UPDATE wecom_outbox SET status='sending',updated_at=? WHERE id=? AND status='queued'").run(Date.now(),row.id);
      if (!claimed.changes) return { success:false, error:'WeCom send is already pending' };
      const result = await this.client.call('kf/send_msg',{ touser:contact.external_userid,open_kfid:c.openKfId,msgid:row.msgid,msgtype:'text',text:{content:input.content} });
      if (result.errcode !== 0 || result.msgid !== row.msgid) throw new WeComApiError('WeCom send receipt did not confirm the stored message id',undefined,true);
      this.db.prepare("UPDATE wecom_outbox SET status='api_accepted',last_error=NULL,updated_at=? WHERE id=? AND status='sending'").run(Date.now(),row.id);
      return { success:true, accepted:true, message_id:row.msgid };
    } catch(error) {
      const e = error instanceof WeComApiError ? error : new WeComApiError('WeCom send failed',undefined,true);
      const transient = !e.uncertain && [-1,45009].includes(e.code ?? 0);
      this.db.prepare('UPDATE wecom_outbox SET status=?,last_error=?,updated_at=? WHERE id=? AND status IN (\'queued\',\'sending\')')
        .run(e.uncertain?'unknown':transient?'queued':'failed',e.message,Date.now(),row.id);
      return { success:false,error:e.message };
    }
  }
}
const channels = new WeakMap<DatabaseSync,WeComKfChannel>();
export function getWeComChannel(db: DatabaseSync, config: WeComConfig): WeComKfChannel {
  let channel = channels.get(db);
  if (!channel) { channel = new WeComKfChannel(db,config); channels.set(db,channel); }
  return channel;
}

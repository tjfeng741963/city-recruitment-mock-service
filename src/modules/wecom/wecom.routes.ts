import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { MessageEventService } from '../messaging/message-events.js';
import { MessageAutomationService } from '../messaging/message-automation.js';
import { createMessageChannelProvider } from '../messaging/message-channel-provider.js';
import { createDifyProvider, difyProviderMode } from '../dify/create-provider.js';
import { deviceDifyConfig } from '../dify/dify-provider.js';
import { readWeComConfig, wecomConfigurationStatus } from './wecom-config.js';
import { WeComClient, WeComApiError } from './wecom-client.js';
import { WeComStore } from './wecom-store.js';
import { WeComCrypto, parseCallbackXml } from './wecom-crypto.js';

type Query = { msg_signature?: string; timestamp?: string; nonce?: string; echostr?: string };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown) => typeof value === 'string' ? value : '';

function rawBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return '';
}

export function registerWeComRoutes(app: FastifyInstance, db: DatabaseSync): void {
  // Fastify has no built-in XML parser. Keep the encrypted envelope opaque until
  // the signature and AES frame have been checked.
  if (!app.hasContentTypeParser('application/xml')) {
    app.addContentTypeParser('application/xml', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    app.addContentTypeParser('text/xml', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  }

  app.get<{ Querystring: Query }>('/api/v1/channels/wecom-kf/callback', async (request, reply) => {
    const status = wecomConfigurationStatus();
    if (!status.enabled || status.missing.length) return reply.code(503).send({ detail: 'WeCom callback is not configured' });
    const config = readWeComConfig()!;
    try {
      const value = new WeComCrypto(config.token, config.aesKey, config.corpId).decrypt(
        text(request.query.echostr), text(request.query.msg_signature), text(request.query.timestamp), text(request.query.nonce),
      );
      return reply.type('text/plain').send(value);
    } catch { return reply.code(403).send({ detail: 'Invalid WeCom callback signature' }); }
  });

  // syncRunning/runSync/triggerSync 提到回调路由之前声明，因为回调收到通知后要立即
  // 触发同一个同步函数——不新建一条平行的拉取逻辑，避免两条路径各自维护游标状态。
  let syncRunning: Promise<{ pages: number; received: number; processed: number; cursor: string }> | null = null;
  const runSync = async (limitInput = 1000) => {
    const status = wecomConfigurationStatus();
    if (!status.enabled || status.missing.length) throw new Error('WeCom is not configured');
    const config = readWeComConfig()!;
    const store = new WeComStore(db, config); store.ensureConnection();
    const client = new WeComClient(config);
    const connection = store.connection();
    let cursor = connection.cursor;
    let token = connection.sync_token;
    let pages = 0;
    let received = 0;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(limitInput || 1000))));
    do {
      const body: Record<string, unknown> = { open_kfid: config.openKfId, limit };
      if (cursor) body.cursor = cursor;
      if (token && connection.token_expires_at > Date.now()) body.token = token;
      const result = await client.call('kf/sync_msg', body);
      if (typeof result.next_cursor !== 'string' || typeof result.has_more !== 'number' || !Array.isArray(result.msg_list)) throw new Error('WeCom sync response is invalid');
      store.acceptPage(result.msg_list as Record<string, any>[], result.next_cursor);
      cursor = result.next_cursor; token = '';
      pages += 1; received += result.msg_list.length;
      if (!result.has_more) break;
    } while (pages < 20);
    const processed = await processInbox(db, config);
    return { pages, received, processed, cursor };
  };
  // 回调触发用：不阻塞企微的 ack 响应（企微要求回调快速返回 success，否则会重试
  // 回调本身），所以这里不 await。若已有同步在跑就不重复触发，交给那一次收尾。
  // syncRunning 本身仍会在失败时 reject——不在这里吞掉，只在这个脱钩引用上单独
  // 挂一个空 catch 消音"unhandled rejection"，这样谁 await 这同一个 promise
  // （比如下面 /run 里"加入已有同步"的分支）仍能看到真实的失败结果。
  const triggerSync = () => {
    if (syncRunning) return;
    const promise = runSync(1000);
    syncRunning = promise;
    promise.finally(() => { if (syncRunning === promise) syncRunning = null; });
    promise.catch(() => {});
  };

  app.post<{ Querystring: Query; Body: unknown }>('/api/v1/channels/wecom-kf/callback', async (request, reply) => {
    const status = wecomConfigurationStatus();
    if (!status.enabled || status.missing.length) return reply.code(503).send({ detail: 'WeCom callback is not configured' });
    const config = readWeComConfig()!;
    const raw = rawBody(request.body);
    try {
      const envelope = parseCallbackXml(raw);
      const cipher = envelope.Encrypt;
      if (!cipher) throw new Error('Missing Encrypt');
      const plain = new WeComCrypto(config.token, config.aesKey, config.corpId).decrypt(
        cipher, text(request.query.msg_signature), text(request.query.timestamp), text(request.query.nonce),
      );
      const event = parseCallbackXml(plain);
      if (event.ToUserName && event.ToUserName !== config.corpId) throw new Error('Callback enterprise mismatch');
      if (event.OpenKfId && event.OpenKfId !== config.openKfId) throw new Error('Callback customer service mismatch');
      const store = new WeComStore(db, config);
      store.ensureConnection();
      const isNew = store.notify(sha256(raw), text(event.Token));
      // 回调本身不带消息正文（企微协议限制），只带"有新消息了"的通知；
      // 真正拉取内容要靠 kf/sync_msg。这里收到通知后立即触发，不等 15 秒轮询。
      if (isNew) triggerSync();
      return reply.type('text/plain').send('success');
    } catch (error) {
      // 不要只回 403：验签、解密、入库任何一步失败都会走到这里，
      // 不留日志的话排查只能靠猜（曾经因为一条 INSERT 少了列名，
      // 表面症状一直是"验签失败"）。
      request.log.warn({ err: error }, 'wecom callback rejected');
      return reply.code(403).send({ detail: 'Invalid WeCom callback signature or payload' });
    }
  });

  app.get('/api/v1/channels/wecom-kf/status', async (request, reply) => {
    if (request.auth?.role !== 'admin') return reply.code(403).send({ detail: 'Admin required' });
    const status = wecomConfigurationStatus();
    if (!status.enabled || status.missing.length) return { enabled: false, missing: status.missing };
    const config = readWeComConfig()!;
    const store = new WeComStore(db, config); store.ensureConnection();
    const connection = store.connection();
    const { sync_token, ...safeConnection } = connection;
    void sync_token;
    const blocked = replyBlockReason(db, config.deviceCode);
    return {
      enabled: true, corp_id: config.corpId, open_kfid: config.openKfId, device_code: config.deviceCode, connection: safeConnection,
      dify_provider: difyProviderMode(), auto_reply_ready: blocked === null, auto_reply_blocked_reason: blocked,
    };
  });

  app.post<{ Body: { limit?: number } }>('/api/v1/channels/wecom-kf/run', async (request, reply) => {
    if (request.auth?.role !== 'admin') return reply.code(403).send({ detail: 'Admin required' });
    const status = wecomConfigurationStatus();
    if (!status.enabled || status.missing.length) return reply.code(503).send({ detail: 'WeCom is not configured', missing: status.missing });
    // 若回调已经抢先触发了同步（见上面的 triggerSync），不要另开一轮——
    // 加入那一轮等它的结果，避免同一批消息被两条并发路径各处理一半。
    const inFlight = syncRunning;
    const promise = inFlight ?? runSync(request.body?.limit);
    if (!inFlight) syncRunning = promise;
    try { return await promise; }
    catch (error) { return reply.code(502).send({ detail: error instanceof Error ? error.message : 'WeCom sync failed' }); }
    finally { if (syncRunning === promise) syncRunning = null; }
  });

  if (process.env.REA_WECOM_WORKER_ENABLED === 'true') {
    let running: Promise<unknown> | null = null;
    const timer = setInterval(() => {
      if (running || syncRunning) return;
      syncRunning = runSync(1000);
      running = syncRunning.catch(() => undefined).finally(() => { running = null; syncRunning = null; });
    }, 15_000);
    app.addHook('onClose', async () => { clearInterval(timer); await running; });
  }
}

/** 返回不能自动回复的原因；能回复时返回 null。/status 和 processInbox 共用这一处判断。 */
function replyBlockReason(db: DatabaseSync, deviceCode: string): string | null {
  const mode = difyProviderMode();
  if (mode === 'mock') return 'REA_DIFY_PROVIDER 未设为 http 或 chatflow，当前是 Mock，不会给企微客户发回复';
  const device = db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND status='enabled' LIMIT 1")
    .get(deviceCode) as { data_json: string } | undefined;
  if (!device) return `没有启用状态、设备编码为 ${deviceCode} 的设备`;
  if (mode === 'chatflow') return null;
  let data: Record<string, unknown>;
  try { data = JSON.parse(device.data_json || '{}') as Record<string, unknown>; }
  catch { return `设备 ${deviceCode} 的配置不是合法 JSON`; }
  if (deviceDifyConfig(data).baseUrl.startsWith('mock://')) return `设备 ${deviceCode} 没有配置 Dify 地址，服务器也没有设 REA_DIFY_BASE_URL`;
  return null;
}

async function processInbox(db: DatabaseSync, config: ReturnType<typeof readWeComConfig> & object): Promise<number> {
  const events = new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? 'local-webhook-secret' });
  // 与 activation.jobs.ts / message-automation.ts 用同一套工厂，不再自己二选一。
  // MessageAutomationService.handleInbound 内部已经用 deviceDifyConfig(deviceData) 读
  // 该设备自己配置的 dify_url/dify_key，所以企微这条线换成这个工厂后就自动吃到设备级配置。
  const dify = createDifyProvider();
  const channel = createMessageChannelProvider(undefined, db);
  const automation = new MessageAutomationService(db, events, dify, channel, undefined, { observeOnly: !process.env.REA_DIFY_PROVIDER });
  const rows = db.prepare("SELECT msgid,customer_id,payload_json FROM wecom_inbox WHERE status='queued' AND next_attempt_at<=? ORDER BY created_at LIMIT 50").all(Date.now()) as Array<{ msgid: string; customer_id: number; payload_json: string }>;
  // 企微面对的是真实客户。Dify 没真正接上时宁可不回，也不能把 Mock 文本发出去。
  // 消息留在 queued，配好后下一次同步会自动补回。
  const blocked = rows.length ? replyBlockReason(db, config.deviceCode) : null;
  if (blocked) {
    for (const row of rows) {
      db.prepare("UPDATE wecom_inbox SET last_error=?,next_attempt_at=? WHERE msgid=? AND open_kfid=? AND corp_id=? AND status='queued'")
        .run(blocked, Date.now() + 60_000, row.msgid, config.openKfId, config.corpId);
    }
    return 0;
  }
  let processed = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { text?: { content?: string } };
    const content = text(payload.text?.content);
    if (!content || !row.customer_id) {
      db.prepare("UPDATE wecom_inbox SET status='ignored' WHERE msgid=? AND open_kfid=? AND corp_id=?").run(row.msgid, config.openKfId, config.corpId);
      continue;
    }
    const claimed = db.prepare("UPDATE wecom_inbox SET status='processing',attempts=attempts+1 WHERE msgid=? AND open_kfid=? AND corp_id=? AND status='queued'").run(row.msgid, config.openKfId, config.corpId);
    if (!claimed.changes) continue;
    const eventId = `wecom:${sha256(JSON.stringify([config.corpId, config.openKfId, row.msgid]))}`;
    try {
      const result = await automation.handleInbound({ eventId, deviceCode: config.deviceCode, customerId: row.customer_id, content });
      if (result.reply_status === 'failed') throw new Error(result.error ?? 'WeCom message processing failed');
      if (result.reply_status === 'pending') {
        db.prepare("UPDATE wecom_inbox SET status='queued',last_error=?,next_attempt_at=? WHERE msgid=? AND open_kfid=? AND corp_id=?")
          .run('Another worker is still processing this WeCom message', Date.now() + 60_000, row.msgid, config.openKfId, config.corpId);
        continue;
      }
      db.prepare("UPDATE wecom_inbox SET status='done',last_error=NULL WHERE msgid=? AND open_kfid=? AND corp_id=?").run(row.msgid, config.openKfId, config.corpId);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'WeCom message processing failed';
      db.prepare("UPDATE wecom_inbox SET status='failed',last_error=?,next_attempt_at=? WHERE msgid=? AND open_kfid=? AND corp_id=?")
        .run(message, Date.now() + 60_000, row.msgid, config.openKfId, config.corpId);
    }
  }
  return processed;
}

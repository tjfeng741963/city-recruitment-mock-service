import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCipheriv, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const aes = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
const fakeSecret = 'fixture-application-secret';
function callback(message: string) {
  const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(message));
  const frame = Buffer.concat([Buffer.alloc(16), length, Buffer.from(message), Buffer.from('ww-fixture')]);
  const pad = 32 - frame.length % 32;
  const crypt = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16)); crypt.setAutoPadding(false);
  const cipher = Buffer.concat([crypt.update(Buffer.concat([frame, Buffer.alloc(pad, pad)])), crypt.final()]).toString('base64');
  const query = new URLSearchParams({ timestamp: '100', nonce: 'nonce', msg_signature: createHash('sha1').update(['fixture-token', '100', 'nonce', cipher].sort().join('')).digest('hex') });
  return { cipher, query };
}
describe('WeCom customer service end to end through official-shaped HTTP APIs', () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  let app: FastifyInstance, server: Server, admin: Record<string, string>;
  let pages: any[], sent: any[], difyCalls: number, syncCalls: any[], sendMode: string, takeoverDuringAi: boolean;
  const customer = () => ({ msgid: 'in-1', open_kfid: 'wk-fixture', external_userid: 'wm-customer', send_time: Math.floor(Date.now()/1000), origin: 3, msgtype: 'text', text: { content: '广州有什么工作？' } });
  beforeEach(async () => {
    pages = []; sent = []; difyCalls = 0; syncCalls = []; sendMode = 'ok'; takeoverDuringAi = false;
    server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let result: any = { errcode: 0 };
      if (req.url?.startsWith('/cgi-bin/gettoken')) result = { access_token: 'fixture-access-token', expires_in: 7200 };
      else if (req.url?.startsWith('/cgi-bin/kf/sync_msg')) { syncCalls.push(body); result = pages.shift() ?? { errcode: 0, next_cursor: 'final', has_more: 0, msg_list: [] }; }
      else if (req.url?.startsWith('/cgi-bin/kf/service_state/get')) result = { errcode: 0, service_state: 1 };
      else if (req.url?.startsWith('/cgi-bin/kf/send_msg')) {
        sent.push(body);
        if (sendMode === 'lost') { req.socket.destroy(); return; }
        result = { errcode: 0, msgid: body.msgid };
      } else if (req.url === '/v1/chat-messages') {
        difyCalls++;
        if (takeoverDuringAi) app.db.prepare('UPDATE agent_conversations SET takeover=1').run();
        result = { answer: '可以先了解广州白班岗位。', message_id: 'dify-id', conversation_id: 'dify-conversation' };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    globalThis.fetch = ((input, init) => {
      const url = new URL(String(input));
      return originalFetch(url.hostname === 'qyapi.weixin.qq.com' ? origin + url.pathname + url.search : input, init);
    }) as typeof fetch;
    Object.assign(process.env, { REA_DATABASE_PATH: ':memory:', REA_WECOM_ENABLED: 'true', REA_WECOM_WORKER_ENABLED: 'false',
      REA_WECOM_CORP_ID: 'ww-fixture', REA_WECOM_APP_SECRET: fakeSecret, REA_WECOM_CALLBACK_TOKEN: 'fixture-token',
      REA_WECOM_ENCODING_AES_KEY: aes.toString('base64').replace(/=+$/, ''), REA_WECOM_OPEN_KFID: 'wk-fixture', REA_WECOM_DEVICE_CODE: 'wecom-test',
      REA_DIFY_PROVIDER: 'http', REA_DIFY_BASE_URL: origin + '/v1', REA_DIFY_API_KEY: 'fixture-dify-key', REA_MESSAGE_CHANNEL_PROVIDER: 'mock' });
    app = buildServer(); await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'local-admin', password: 'local-demo-only' } });
    admin = { authorization: 'Bearer ' + login.json().access_token };
  });
  afterEach(async () => {
    await app?.close(); globalThis.fetch = originalFetch;
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env).filter(k => k.startsWith('REA_'))) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });
  const notify = async () => {
    const { cipher, query } = callback('<xml><ToUserName><![CDATA[ww-fixture]]></ToUserName><MsgType>event</MsgType><Event>kf_msg_or_event</Event><Token>fixture-sync-token</Token><OpenKfId>wk-fixture</OpenKfId></xml>');
    return app.inject({ method: 'POST', url: '/api/v1/channels/wecom-kf/callback?' + query, headers: { 'content-type': 'application/xml' }, payload: `<xml><Encrypt><![CDATA[${cipher}]]></Encrypt></xml>` });
  };
  const run = () => app.inject({ method: 'POST', url: '/api/v1/channels/wecom-kf/run', headers: admin, payload: {} });

  it('verifies public callback URL with encryption, while status and sync require admin', async () => {
    const { cipher, query } = callback('plain-echo'); query.set('echostr', cipher);
    const verified = await app.inject({ url: '/api/v1/channels/wecom-kf/callback?' + query });
    expect(verified.statusCode).toBe(200); expect(verified.body).toBe('plain-echo');
    query.set('msg_signature', '0'.repeat(40));
    expect((await app.inject({ url: '/api/v1/channels/wecom-kf/callback?' + query })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/channels/wecom-kf/status' })).statusCode).toBe(403);
    const status = await app.inject({ url: '/api/v1/channels/wecom-kf/status', headers: admin });
    expect(status.statusCode).toBe(200); expect(status.body).not.toContain(fakeSecret);
  });

  it('takes an encrypted callback through sync, real HTTP Dify and send_msg, deduplicating all stages', async () => {
    pages.push({ errcode: 0, next_cursor: 'one', has_more: 0, msg_list: [customer()] });
    expect((await notify()).body).toBe('success'); expect((await notify()).body).toBe('success');
    expect((await run()).statusCode).toBe(200);
    expect(difyCalls).toBe(1); expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ touser: 'wm-customer', open_kfid: 'wk-fixture', text: { content: '可以先了解广州白班岗位。' } });
    expect(sent[0].msgid).toMatch(/^[a-zA-Z0-9_-]{1,32}$/);
    expect(app.db.prepare('SELECT status FROM wecom_outbox').get()).toMatchObject({ status: 'api_accepted' });
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE direction='outbound' AND customer_id=(SELECT customer_id FROM wecom_contacts)").get()).toMatchObject({ status: 'api_accepted' });
    pages.push({ errcode: 0, next_cursor: 'two', has_more: 0, msg_list: [customer()] }); await notify(); await run();
    expect(difyCalls).toBe(1); expect(sent).toHaveLength(1);
  });

  it('continues empty has_more pages and durably retains the final cursor', async () => {
    pages.push({ errcode: 0, next_cursor: 'empty-but-more', has_more: 1, msg_list: [] }, { errcode: 0, next_cursor: 'complete', has_more: 0, msg_list: [customer()] });
    await notify(); await run();
    expect(syncCalls[1].cursor).toBe('empty-but-more');
    expect(app.db.prepare('SELECT cursor FROM wecom_connections').get()).toMatchObject({ cursor: 'complete' });
    expect(sent).toHaveLength(1);
  });

  it('stops an AI reply if a recruiter takes over while Dify is generating', async () => {
    takeoverDuringAi = true; pages.push({ errcode: 0, next_cursor: 'one', has_more: 0, msg_list: [customer()] });
    await notify(); await run(); expect(difyCalls).toBe(1); expect(sent).toHaveLength(0);
  });

  it('leaves a timed-out physical send unknown and never blindly repeats it', async () => {
    sendMode = 'lost'; pages.push({ errcode: 0, next_cursor: 'one', has_more: 0, msg_list: [customer()] });
    await notify(); await run();
    expect(app.db.prepare('SELECT status FROM wecom_outbox').get()).toMatchObject({ status: 'unknown' });
    await notify(); await run(); expect(sent).toHaveLength(1);
  });

  it('reconciles official send-failure events instead of claiming delivery succeeded forever', async () => {
    pages.push({ errcode: 0, next_cursor: 'one', has_more: 0, msg_list: [customer()] }); await notify(); await run();
    const id = sent[0].msgid;
    pages.push({ errcode: 0, next_cursor: 'two', has_more: 0, msg_list: [{ msgid: 'event-fail', origin: 4, msgtype: 'event', event: { event_type: 'msg_send_fail', open_kfid: 'wk-fixture', external_userid: 'wm-customer', fail_msgid: id, fail_type: 10 } }] });
    await notify(); await run();
    expect(app.db.prepare('SELECT status FROM wecom_outbox').get()).toMatchObject({ status: 'failed' });
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE direction='outbound' AND customer_id=(SELECT customer_id FROM wecom_contacts)").get()).toMatchObject({ status: 'failed' });
    expect(sent).toHaveLength(1);
  });

  it('blocks the sixth reply in one customer message window', async () => {
    pages.push({ errcode: 0, next_cursor: 'one', has_more: 0, msg_list: [customer()] }); await notify(); await run();
    const contact = app.db.prepare('SELECT customer_id,last_customer_msgid FROM wecom_contacts').get() as { customer_id: number; last_customer_msgid: string };
    for (let i = 0; i < 4; i++) app.db.prepare("INSERT INTO wecom_outbox(corp_id,open_kfid,device_code,customer_id,external_userid,idempotency_key,msgid,content,window_msgid,status,created_at,updated_at) VALUES ('ww-fixture','wk-fixture','wecom-test',?,'wm-customer',?,?,?,?,'api_accepted',?,?)")
      .run(contact.customer_id, `fixture-${i}`, `fixture-msg-${i}`, 'already sent', contact.last_customer_msgid, Date.now(), Date.now());
    const response = await app.inject({ method: 'POST', url: '/api/v1/agent/manual-reply', headers: { ...admin, 'idempotency-key': 'manual-sixth' }, payload: { device_code: 'wecom-test', customer_id: contact.customer_id, content: '第六条' } });
    expect(response.statusCode).toBe(502); expect(sent).toHaveLength(1);
  });
});

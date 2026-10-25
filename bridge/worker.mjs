import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Persist before performing an irreversible send; an interrupted part is never replayed automatically. */
export class DeviceWorker {
  constructor({ databasePath, driver, request, identity = 'test', now = Date.now }) {
    this.db = new DatabaseSync(databasePath);
    this.driver = driver;
    this.request = request;
    this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS sends (
      command_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT, acked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS parts (
        command_id TEXT NOT NULL, part INTEGER NOT NULL, state TEXT NOT NULL, message_id TEXT,
        PRIMARY KEY(command_id,part));
      CREATE TABLE IF NOT EXISTS inbox (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, done INTEGER DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL)');
    const owner = this.db.prepare('SELECT owner FROM identity WHERE id=1').get();
    if (owner && owner.owner !== identity) { this.db.close(); throw new Error('Device journal belongs to another gateway/device'); }
    this.db.prepare('INSERT OR IGNORE INTO identity(id,owner) VALUES(1,?)').run(identity);
  }
  receive(message) {
    if (!message.event_id || !message.contact_id || !message.content) return;
    this.db.prepare('INSERT OR IGNORE INTO inbox(event_id,payload) VALUES (?,?)').run(message.event_id, JSON.stringify(message));
  }
  async flushInbox() {
    const item = this.db.prepare('SELECT event_id,payload,attempts FROM inbox WHERE done=0 AND next_attempt_at<=? ORDER BY rowid LIMIT 1').get(this.now());
    if (!item) return;
    try {
      const result = await this.request('inbound', JSON.parse(item.payload));
      if (result.reply_status === 'pending' || result.reply_status === 'failed') throw new Error('Application reply still pending');
      this.db.prepare('UPDATE inbox SET done=1 WHERE event_id=?').run(item.event_id);
    } catch (error) {
      const permanent = error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429;
      const retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(item.attempts, 6));
      this.db.prepare('UPDATE inbox SET attempts=attempts+1,done=CASE WHEN ? THEN -1 ELSE 0 END,next_attempt_at=? WHERE event_id=?').run(permanent ? 1 : 0, retryAt, item.event_id);
      throw error;
    }
  }
  async execute(command) {
    const contentHash = hash(JSON.stringify([command.contact_id, command.content]));
    const existing = this.db.prepare('SELECT content_hash,receipt FROM sends WHERE command_id=?').get(command.id);
    if (existing && existing.content_hash !== contentHash) throw new Error('Conflicting command content');
    if (existing?.receipt) {
      await this.request('receipts', { ...JSON.parse(existing.receipt), lease_token: command.lease_token });
      this.db.prepare('UPDATE sends SET acked=1 WHERE command_id=?').run(command.id);
      return;
    }
    this.db.prepare('INSERT OR IGNORE INTO sends(command_id,content_hash,command) VALUES (?,?,?)').run(command.id, contentHash, JSON.stringify(command));
    const ids = [];
    let status = 'succeeded';
    // Media sentinels need a separate media adapter; never send their source syntax as plain text.
    const media = /###(?:图片|文件)[（(]/.test(command.content);
    if (media) status = 'failed';
    else for (const [index, text] of command.content.split('###').map(x => x.trim()).filter(Boolean).entries()) {
      const part = this.db.prepare('SELECT state,message_id FROM parts WHERE command_id=? AND part=?').get(command.id, index);
      if (part?.state === 'done') { ids.push(part.message_id); continue; }
      if (part) { status = 'unknown'; break; }
      this.db.prepare("INSERT INTO parts(command_id,part,state) VALUES (?,?,'executing')").run(command.id, index);
      try {
        const id = await this.driver.send(command.contact_id, text);
        if (typeof id !== 'string' || !id) throw new Error('Driver did not return a message id');
        this.db.prepare("UPDATE parts SET state='done',message_id=? WHERE command_id=? AND part=?").run(id, command.id, index);
        ids.push(id);
      } catch {
        status = 'unknown';
        break;
      }
    }
    if (status === 'succeeded' && !ids.length) status = 'failed';
    const receipt = {
      command_id: command.id, status,
      lease_token: command.lease_token,
      message_id: status === 'succeeded' ? ids.length === 1 ? ids[0] : JSON.stringify(ids) : '',
      simulated: this.driver.simulated === true,
    };
    this.db.prepare('UPDATE sends SET receipt=? WHERE command_id=?').run(JSON.stringify(receipt), command.id);
    await this.request('receipts', receipt);
    this.db.prepare('UPDATE sends SET acked=1 WHERE command_id=?').run(command.id);
  }
  async flushReceipts() {
    // Reconcile receipts lost after the physical send without asking WeChat to send again.
    for (const row of this.db.prepare('SELECT command_id,command FROM sends WHERE acked=0').all()) {
      try { await this.execute(JSON.parse(row.command)); }
      catch (error) {
        if ([403,409,422].includes(error.statusCode)) {
          this.db.prepare('UPDATE sends SET acked=-1 WHERE command_id=?').run(row.command_id);
          console.error('Receipt needs manual reconciliation:', row.command_id);
        } else console.error('Receipt pending:', row.command_id);
      }
    }
  }
  close() { this.db.close(); }
}

export function createGatewayRequest({ baseUrl, code, token }) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Gateway connection requires HTTPS or a loopback SSH tunnel');
  }
  return async (action, payload = {}) => {
    const response = await fetch(`${url.origin}/api/v1/bridge/devices/${encodeURIComponent(code)}/${action}`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(100_000),
    });
    if (!response.ok) {
      const error = new Error(`Gateway ${action}: HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return response.json();
  };
}

async function main() {
  const code = process.env.REA_DEVICE_CODE;
  const token = process.env.REA_DEVICE_TOKEN;
  const baseUrl = process.env.REA_GATEWAY_URL;
  if (!code || !token || !baseUrl) throw new Error('Set REA_DEVICE_CODE, REA_DEVICE_TOKEN and REA_GATEWAY_URL');
  const dataPath = path.resolve(process.env.REA_DEVICE_DATA_DIR ?? path.join('过程文件', `device-${hash(baseUrl + '/' + code).slice(0,16)}`));
  mkdirSync(dataPath, { recursive: true });
  const request = createGatewayRequest({ baseUrl, code, token });
  const { createWechatyDriver } = await import('./wechaty-driver.mjs');
  const driver = await createWechatyDriver({
    name: path.join(dataPath, 'wechat-session'),
    puppet: process.env.WECHATY_PUPPET ?? 'wechaty-puppet-wechat',
    qrFile: path.join(dataPath, 'login.png'),
  });
  const worker = new DeviceWorker({ databasePath: path.join(dataPath, 'journal.sqlite'), driver, request, identity: `${baseUrl}/${code}` });
  let stopped = false;
  let online = false;
  let heartbeatBusy = false;
  let accountId = '';
  let approvedAccount = '';
  let desiredState = 'offline';
  let generation = 0;
  driver.onInbound(message => {
    if (approvedAccount && message.account_id === approvedAccount && message.account_id === accountId) worker.receive(message);
    else console.error('Inbound ignored: account has not been confirmed by the gateway');
  });
  driver.onState(async (state, account) => {
    const change = ++generation;
    desiredState = state;
    online = false;
    accountId = account ?? accountId;
    try {
      await request('heartbeat', { state, account_id: accountId });
      if (change === generation) {
        online = state === 'online';
        if (online) approvedAccount = accountId;
      }
    }
    catch (error) { online = false; console.error('Device heartbeat failed:', Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : 'network or timeout'); }
  });
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    const change = generation;
    try {
      await request('heartbeat', { state: desiredState, account_id: accountId });
      if (change === generation) {
        online = desiredState === 'online';
        if (online) approvedAccount = accountId;
      }
    }
    catch (error) { if (change === generation) online = false; console.error('Gateway heartbeat failed:', Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : 'network or timeout'); }
    finally { heartbeatBusy = false; }
  }, 15_000);
  try { await driver.start(); }
  catch (error) {
    clearInterval(heartbeat);
    await driver.stop().catch(() => {});
    worker.close();
    throw error;
  }
  const inboxLoop = (async () => {
    while (!stopped) {
      try { if (online) await worker.flushInbox(); }
      catch { console.error('Inbound pending; will retry with the same event id'); }
      await pause(1000);
    }
  })();
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      try {
        if (online) {
          await worker.flushReceipts();
          const { command } = await request('claim');
          if (command) await worker.execute(command);
        }
      } catch { console.error('Command pending or gateway unavailable; check journal and gateway status'); }
      await pause(500);
    }
  } finally {
    clearInterval(heartbeat);
    await inboxLoop;
    await request('heartbeat', { state: 'offline', account_id: accountId }).catch(() => {});
    await driver.stop(); worker.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Device failed to start. Check bridge/.env, pairing token and Wechaty puppet availability.'); process.exitCode = 1; });
}

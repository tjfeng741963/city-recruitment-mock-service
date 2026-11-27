import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { noteRecontactCapability } from "../src/modules/recontact/recontact.js";

const base = "/api/v1/recontact";
const device = "recontact-test-device";
const part = { kind: "text", value: "还想了解这个岗位吗？", delay_ms: 0 };
const rule = { enabled: true, wait_minutes: 30, start_minute: 540, end_minute: 1260, parts: [part] };

describe("recontact management API", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;

  function setDevice(headers: Record<string, string>, enabled: boolean) {
    return app.inject({ method: "PUT", url: `${base}/devices/${device}`, headers, payload: { enabled } });
  }

  async function login(username: string) {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } });
    expect(response.statusCode).toBe(200);
    return { authorization: `Bearer ${response.json().access_token}` };
  }

  beforeEach(async () => {
    vi.stubEnv("REA_DATABASE_PATH", ":memory:");
    vi.stubEnv("REA_SEED_FIXTURES", "1");
    app = buildServer();
    admin = await login("local-admin");
    const data = { device_code: device, position_id: 101, agent_position_id: 101, reply_provider: "agent" };
    app.db.prepare("INSERT INTO service_positions(id,position_name,city_id,data_json) VALUES (101,'复聊测试岗位',3,?)")
      .run(JSON.stringify({ work_address: "园区一号门", work_coordinates: "23.17,113.32" }));
    app.db.prepare("INSERT INTO agent_devices(device_name,data_json) VALUES ('复聊测试设备',?)").run(JSON.stringify(data));
    app.db.prepare("INSERT INTO bridge_devices(device_code,token_hash,account_id,state,heartbeat_at) VALUES (?,'hash','100','online',?)")
      .run(device, Date.now());
    app.db.prepare(`INSERT INTO windows_runtime_health(device_code,observed_at,wecom_available,reply_ready,reason,sync_state,backlog)
      VALUES (?,?,1,1,'ready','current',0)`).run(device, Date.now());
    for (const id of [101, 102]) {
      app.db.prepare(`INSERT INTO agent_conversations(id,device_code,customer_id,nickname,external_conversation_id,last_msg_at)
        VALUES (?,?,?,?,?,datetime('now','-4 days'))`).run(id, device, id, `候选人 ${id}`, `S:100_${id}`);
      app.db.prepare("INSERT INTO bridge_contacts(device_code,contact_id,customer_id) VALUES (?,?,?)").run(device, `S:100_${id}`, id);
      app.db.prepare(`INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at)
        VALUES (?,?,'inbound','了解了',datetime('now','-4 days'))`).run(device, id);
    }
    noteRecontactCapability(app.db,device,"100",Date.now());
  });

  afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it("round-trips rules and their ordered parts using the configured position", async () => {
    const options = await app.inject({ method: "GET", url: `${base}/options`, headers: admin });
    expect(options.statusCode).toBe(200);
    expect(options.json().locations).toEqual(expect.arrayContaining([
      { position_id: 101, name: "岗位工作地点", key: "@work_address", address: "园区一号门", mappable: true },
    ]));
    const ordered = [{ kind: "location", value: "@work_address", delay_ms: 0 }, { ...part, delay_ms: 4500 }];
    const url = `${base}/rules/101/work_location`;
    const payload = { ...rule, parts: ordered };
    const saved = await app.inject({ method: "PUT", url, headers: admin, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().item).toMatchObject({ ...payload, position_id: 101, stage: "work_location" });
    const loaded = await app.inject({ method: "GET", url: `${base}/rules?position_id=101`, headers: admin });
    expect(loaded.json().items).toEqual([expect.objectContaining({ ...payload, stage: "work_location" })]);
    expect((await app.inject({ method: "PUT", url, headers: admin, payload: { ...payload, start_minute: 539 } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url, headers: admin, payload: { ...payload, parts: [{ kind: "video", value: "missing.mp4", delay_ms: 0 }] } })).statusCode).toBe(422);
  });

  it("requires an accessible position and a recruiting user", async () => {
    const recruiter = await login("local-recruiter");
    const customer = await login("local-customer");
    expect((await app.inject({ method: "GET", url: `${base}/options`, headers: customer })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `${base}/rules/101/work_location`, headers: recruiter, payload: rule })).statusCode).toBe(403);
    app.db.prepare(`INSERT OR IGNORE INTO user_scope_assignments(user_id,scope_type,scope_id)
      SELECT id,'device',? FROM users WHERE username='local-recruiter'`).run(device);
    expect((await app.inject({ method: "GET", url: `${base}/rules?position_id=101`, headers: recruiter })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `${base}/rules/101/work_location`, headers: recruiter, payload: rule })).statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: `${base}/candidates?position_id=101&days=3`, headers: recruiter });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 101, nickname: "候选人 101" })]));
    expect(list.json().items[0]).not.toHaveProperty("contact_id");
    expect(list.json().items[0]).not.toHaveProperty("account_id");
  });

  it("preserves the previewed batch, skips new inbound, and confirms only once", async () => {
    expect((await setDevice(admin, true)).statusCode).toBe(200);
    const template = await app.inject({ method: "POST", url: `${base}/templates`, headers: admin,
      payload: { name: "岗位问候", position_id: 101, parts: [part] } });
    expect(template.statusCode).toBe(200);
    const templates = await app.inject({ method: "GET", url: `${base}/templates`, headers: admin });
    expect(templates.json().items).toEqual([template.json().item]);
    const preview = await app.inject({ method: "POST", url: `${base}/batches/preview`, headers: admin,
      payload: { conversation_ids: [101, 102], template_ids: { 101: template.json().item.id }, days: 3 } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ token: expect.any(String), items: [
      { id: 101, parts: [part], reason: "" }, { id: 102, parts: [part], reason: "" },
    ] });
    expect((app.db.prepare("SELECT count(*) AS n FROM recontact_jobs").get() as { n: number }).n).toBe(0);
    app.db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content) VALUES (?,101,'inbound','我再想想')").run(device);
    const payload = { token: preview.json().token };
    const sent = await app.inject({ method: "POST", url: `${base}/batches`, headers: admin, payload });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ created: 1, skipped: [{ id: 101, reason: "候选人已回复" }] });
    const repeated = await app.inject({ method: "POST", url: `${base}/batches`, headers: admin, payload });
    expect(repeated.json()).toEqual(sent.json());
    const jobs = await app.inject({ method: "GET", url: `${base}/jobs?position_id=101`, headers: admin });
    expect(jobs.json().items).toEqual([expect.objectContaining({ conversation_id: 102, source: "batch" })]);
    const searched = await app.inject({ method: "GET", url: `${base}/jobs?q=101`, headers: admin });
    expect(searched.json().items).toEqual([]);
  });

  it("keeps preview tokens user-bound and checks changes to the displayed location", async () => {
    expect((await setDevice(admin, true)).statusCode).toBe(200);
    const template = await app.inject({ method: "POST", url: `${base}/templates`, headers: admin, payload: {
      name: "地点问候", position_id: 101, parts: [{ kind: "location", value: "@work_address", delay_ms: 0 }],
    } });
    expect(template.statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", url: `${base}/batches/preview`, headers: admin,
      payload: { conversation_ids: [101], template_id: template.json().item.id } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().items[0].parts[0].value).toContain("园区一号门");
    const payload = { token: preview.json().token };
    const recruiter = await login("local-recruiter");
    expect((await app.inject({ method: "POST", url: `${base}/batches`, headers: recruiter, payload })).statusCode).toBe(404);
    app.db.prepare("UPDATE service_positions SET data_json=json_set(data_json,'$.work_address','园区二号门') WHERE id=101").run();
    const result = await app.inject({ method: "POST", url: `${base}/batches`, headers: admin, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ created: 0, skipped: [{ id: 101, reason: "模板引用的素材或地点已变化" }] });
  });

  it("opens only the current available WeCom account and allows its recruiter to pause it", async () => {
    const recruiter = await login("local-recruiter");
    expect((await setDevice(recruiter, true)).statusCode).toBe(403);
    const original = await app.inject({ method: "GET", url: `${base}/options`, headers: admin });
    expect(original.json()).toMatchObject({ can_edit_rules: true, devices: expect.arrayContaining([
      expect.objectContaining({ code: device, recontact_enabled: false, recontact_account_ready: true }),
    ]) });
    const enabled = await setDevice(admin, true);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ enabled: true });
    app.db.prepare("UPDATE bridge_devices SET account_id='999' WHERE device_code=?").run(device);
    expect((await setDevice(admin, true)).statusCode).toBe(409);
    const switched = await app.inject({ method: "GET", url: `${base}/options`, headers: admin });
    expect(switched.json().devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: device, recontact_enabled: false, recontact_account_ready: false }),
    ]));
    app.db.prepare(`INSERT OR IGNORE INTO user_scope_assignments(user_id,scope_type,scope_id)
      SELECT id,'device',? FROM users WHERE username='local-recruiter'`).run(device);
    app.db.prepare("UPDATE bridge_devices SET state='offline' WHERE device_code=?").run(device);
    const paused = await setDevice(recruiter, false);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ enabled: false });
    const scoped = await app.inject({ method: "GET", url: `${base}/options`, headers: recruiter });
    expect(scoped.json()).toMatchObject({ can_edit_rules: false, devices: expect.arrayContaining([
      expect.objectContaining({ code: device, recontact_enabled: false }),
    ]) });
  });
});

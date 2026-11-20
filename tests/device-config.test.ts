import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 契约：docs/对齐-配置分发与按设备话术.md §1/§2
// config 下发接口 + device_scripts 三路由（upsert 按 device_code+stage+city 去重）
describe("device config distribution", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const saved = { ...process.env };
  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    expect(pair.statusCode).toBe(200);
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });
  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const configOf = (code: string, headers: Record<string, string> = device) =>
    app.inject({ method: "GET", url: `/api/v1/bridge/devices/${code}/config`, headers });

  it("serves contract §1 structure with defaults for a device without params", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: admin, payload: { device_code: "dev-empty", device_name: "无参数设备" } });
    expect(created.statusCode).toBe(200);
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/dev-empty/pair", headers: admin });
    const emptyToken = { authorization: `Bearer ${pair.json().device_token}` };
    const res = await configOf("dev-empty", emptyToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ interval_seconds: 20, cooldown: 8, merge_delay_seconds: 0, scripts: [] });
    // 无话术时 version 来自 agent_devices.updated_at（设备存在即有值；无数据设备才是空串）
    expect(typeof body.version).toBe("string");
    expect(body.version).not.toBe("");
    expect(body.scripts).toEqual([]);
  });

  it("returns configured params, scripts and the newer of the two updated_at stamps as version", async () => {
    app.db.prepare("UPDATE agent_devices SET data_json=?, updated_at='2026-11-10 12:00:00' WHERE json_extract(data_json,'$.device_code')='local-device-001'")
      .run(JSON.stringify({ device_code: "local-device-001", interval_seconds: 35, cooldown: 12 }));
    app.db.prepare(`INSERT INTO device_scripts(device_code,city,stage,title,content,status,created_at,updated_at)
      VALUES ('local-device-001','深圳','send_info','龙华厂标准介绍','您好，龙华电子厂…','enabled','2026-11-09T08:00:00Z','2026-11-09T08:00:00Z')`).run();
    const res = await configOf("local-device-001");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: "2026-11-10 12:00:00",
      command_queue: { queued: 0, claimed: 0, unknown: 0 },
      interval_seconds: 35,
      cooldown: 12,
      merge_delay_seconds: 0,
      takeover_sessions: [],
      abandoned_sessions: [],
      factory_name: "",
      // 多厂绑定：未绑定时回空数组（消费方按「不限」处理）
      factory_ids: [],
      factories: [],
      city: "",
      // 知识库 v3：品类/招工方 id，未绑定时回 0
      vertical_id: 0,
      employer_id: 0,
      scripts: [{ stage: "send_info", city: "深圳", title: "龙华厂标准介绍", content: "您好，龙华电子厂…" }],
      // 契约 §5：岗位话术是新增字段，本设备没配时下发空数组（不是 undefined）
      position_scripts: [],
    });
    // 话术更新时间更晚 → version 取较新者
    app.db.prepare("UPDATE device_scripts SET updated_at='2026-11-11T00:00:00Z' WHERE device_code='local-device-001'").run();
    expect((await configOf("local-device-001")).json().version).toBe("2026-11-11T00:00:00Z");
  });

  it("counts the entire device command queue without claiming or expiring tasks", async () => {
    const before = (await configOf("local-device-001")).json();
    expect(before.command_queue).toEqual({ queued: 0, claimed: 0, unknown: 0 });
    const insert = app.db.prepare(`INSERT INTO bridge_commands
      (id,device_code,customer_id,contact_id,content,idempotency_key,status,lease_token,lease_until,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 61; i++) {
      insert.run(`queued-${i}`, "local-device-001", 9001, "S:test", "test", `queued-${i}`, "queued", "", 0, i);
    }
    for (const status of ["claimed", "unknown", "succeeded", "failed"]) {
      insert.run(status, "local-device-001", 9001, "S:test", "test", status, status, "preserve-lease", 1, 100);
    }
    insert.run("other", "other-device", 9002, "S:other", "test", "other", "queued", "", 0, 101);
    const snapshot = app.db.prepare("SELECT * FROM bridge_commands ORDER BY id").all();
    for (let i = 0; i < 2; i++) {
      const after = (await configOf("local-device-001")).json();
      expect(after.command_queue).toEqual({ queued: 61, claimed: 1, unknown: 1 });
      expect(after.version).toBe(before.version);
      expect(app.db.prepare("SELECT * FROM bridge_commands ORDER BY id").all()).toEqual(snapshot);
    }
    app.db.prepare("UPDATE bridge_commands SET status='succeeded' WHERE id='queued-0'").run();
    const changed = (await configOf("local-device-001")).json();
    expect(changed.command_queue.queued).toBe(60);
    expect(changed.version).toBe(before.version);
  });

  // 契约：docs/对齐-设备工厂绑定与资料导入.md §1
  // config 下发设备绑定的 factory_name/city（透传 agent_devices.data_json，缺失回空串）
  it("serves bound factory_name and city from data_json, empty strings when absent", async () => {
    app.db.prepare("UPDATE agent_devices SET data_json=? WHERE json_extract(data_json,'$.device_code')='local-device-001'")
      .run(JSON.stringify({ device_code: "local-device-001", factory_name: "松下万宝(广州)压缩机有限公司", city: "广州" }));
    expect(await configOf("local-device-001").then((r) => r.json()))
      .toMatchObject({ factory_name: "松下万宝(广州)压缩机有限公司", city: "广州" });

    // 没绑的设备：空串 = 通用/不限，绝不回 undefined/null
    const created = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: admin, payload: { device_code: "dev-unbound" } });
    expect(created.statusCode).toBe(200);
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/dev-unbound/pair", headers: admin });
    const unbound = { authorization: `Bearer ${pair.json().device_token}` };
    const body = (await configOf("dev-unbound", unbound)).json();
    expect(body.factory_name).toBe("");
    expect(body.city).toBe("");
  });

  // R4：人工接管名单随 /config 下发。客户端 drain 命中就跳过，避免人与 AI 同时发言。
  it("serves takeover_sessions for conversations under human takeover", async () => {
    app.db.prepare(`INSERT INTO bridge_contacts(device_code,contact_id,customer_id,nickname)
      VALUES ('local-device-001','S:alice',9001,'Alice')`).run();
    app.db.prepare(`INSERT INTO agent_conversations(device_code,customer_id,nickname,takeover,external_conversation_id)
      VALUES ('local-device-001',9001,'Alice',1,'S:alice')`).run();
    app.db.prepare(`INSERT INTO agent_conversations(device_code,customer_id,nickname,takeover,external_conversation_id)
      VALUES ('local-device-001',9002,'Bob',0,'S:bob')`).run();
    app.db.prepare(`INSERT INTO agent_conversations(device_code,customer_id,nickname,takeover,external_conversation_id)
      VALUES ('other-device',9003,'Carol',1,'S:carol')`).run();

    const body = (await configOf("local-device-001")).json();
    expect(body.takeover_sessions).toEqual(["S:alice"]);

    // 空 external_conversation_id 的历史行不能出现在名单里（客户端拿它匹配不上任何会话）
    app.db.prepare(`INSERT INTO agent_conversations(device_code,customer_id,nickname,takeover)
      VALUES ('local-device-001',9004,'Legacy',1)`).run();
    expect((await configOf("local-device-001")).json().takeover_sessions).toEqual(["S:alice"]);
  });

  it("bumps version when a conversation is put under takeover", async () => {
    // 设备自身的 updated_at 固定成较早时间，否则它（当前时间）会盖过接管时间戳，
    // 版本号的变化就测不出来——这里要验的正是「接管也会推动 version」。
    app.db.prepare("UPDATE agent_devices SET updated_at='2026-11-10 12:00:00' WHERE json_extract(data_json,'$.device_code')='local-device-001'").run();
    app.db.prepare(`INSERT INTO agent_conversations(device_code,customer_id,nickname,takeover,external_conversation_id,updated_at)
      VALUES ('local-device-001',9010,'Dave',0,'S:dave','2026-11-10 12:00:00')`).run();
    const before = (await configOf("local-device-001")).json();
    expect(before.takeover_sessions).toEqual([]);

    // 网页点「接管」：只改 agent_conversations，不动 agent_devices
    app.db.prepare("UPDATE agent_conversations SET takeover=1, updated_at='2026-11-12 09:30:00' WHERE device_code=? AND customer_id=?").run("local-device-001", 9010);
    const after = (await configOf("local-device-001")).json();
    expect(after.takeover_sessions).toEqual(["S:dave"]);
    expect(after.version).not.toBe(before.version);
    expect(after.version).toBe("2026-11-12 09:30:00");
  });

  it("authenticates with the bridge device token like other /bridge routes", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/bridge/devices/local-device-001/config" })).statusCode).toBe(401);
    expect((await configOf("local-device-001", { authorization: "Bearer wrong-token" })).statusCode).toBe(401);
    expect((await configOf("missing-device")).statusCode).toBe(401);
    expect((await configOf("local-device-001")).statusCode).toBe(200);
  });
});

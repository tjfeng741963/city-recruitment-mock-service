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
      interval_seconds: 35,
      cooldown: 12,
      merge_delay_seconds: 0,
      scripts: [{ stage: "send_info", city: "深圳", title: "龙华厂标准介绍", content: "您好，龙华电子厂…" }],
    });
    // 话术更新时间更晚 → version 取较新者
    app.db.prepare("UPDATE device_scripts SET updated_at='2026-11-11T00:00:00Z' WHERE device_code='local-device-001'").run();
    expect((await configOf("local-device-001")).json().version).toBe("2026-11-11T00:00:00Z");
  });

  it("authenticates with the bridge device token like other /bridge routes", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/bridge/devices/local-device-001/config" })).statusCode).toBe(401);
    expect((await configOf("local-device-001", { authorization: "Bearer wrong-token" })).statusCode).toBe(401);
    expect((await configOf("missing-device")).statusCode).toBe(401);
    expect((await configOf("local-device-001")).statusCode).toBe(200);
  });

  it("upserts device scripts by (device_code, stage, city) and supports list/delete", async () => {
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/v1/agent/device-scripts", headers: admin, payload });
    const first = await post({ device_code: "local-device-001", stage: "send_info", city: "深圳", title: "v1", content: "第一版话术" });
    expect(first.statusCode).toBe(200);
    const id = first.json().id;
    expect(id).toBeGreaterThan(0);
    // 同键再次 POST 是更新，不是新增
    const second = await post({ device_code: "local-device-001", stage: "send_info", city: "深圳", title: "v2", content: "第二版话术" });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(id);
    expect(app.db.prepare("SELECT COUNT(*) n FROM device_scripts").get()).toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT title,content,updated_at IS NOT NULL fresh FROM device_scripts WHERE id=?").get(id))
      .toMatchObject({ title: "v2", content: "第二版话术", fresh: 1 });

    await post({ device_code: "local-device-001", stage: "send_info", city: "广州", content: "广州话术" });
    await post({ device_code: "other-device", stage: "send_info", city: "深圳", content: "别家设备" });
    const listed = await app.inject({ method: "GET", url: "/api/v1/agent/device-scripts?device_code=local-device-001", headers: admin });
    expect(listed.json().items).toHaveLength(2);
    const byCity = await app.inject({ method: "GET", url: "/api/v1/agent/device-scripts?device_code=local-device-001&city=%E5%B9%BF%E5%B7%9E", headers: admin });
    expect(byCity.json().items).toHaveLength(1);
    expect(byCity.json().items[0]).toMatchObject({ city: "广州", content: "广州话术", status: "enabled" });

    expect((await app.inject({ method: "DELETE", url: `/api/v1/agent/device-scripts/${id}`, headers: admin })).json()).toMatchObject({ ok: true });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/agent/device-scripts/${id}`, headers: admin })).statusCode).toBe(404);
    expect(app.db.prepare("SELECT COUNT(*) n FROM device_scripts").get()).toMatchObject({ n: 2 });

    expect((await post({ stage: "send_info", content: "缺 device_code" })).statusCode).toBe(422);
    expect((await post({ device_code: "local-device-001", stage: "bogus", content: "非法 stage" })).statusCode).toBe(422);
    // 用户鉴权沿用现有：匿名访问被 preHandler 拦截
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/device-scripts" })).statusCode).toBe(403);
  });
});

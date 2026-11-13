import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 一个微信号只做一个板块（2026-11-13 与 HR 对齐）：
// 「a工厂对应a账号，a地铁会对应a账号……大方向已经定死了，不会乱来」。
// 所以 vertical_id 是设备的必填项，没有「什么都招」的综合号。
describe("device must belong to one vertical", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const verticalIdOf = (code: string) => {
    const row = app.db.prepare("SELECT id FROM vertical WHERE code=?").get(code) as { id: number } | undefined;
    return row?.id;
  };

  const createDevice = async (code: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: code, device_name: code },
    });
    expect(res.statusCode).toBe(200);
    return Number(res.json().id);
  };

  const put = (id: number, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/v1/agent/devices/${id}`, headers: admin, payload });

  it("exposes the five business boards", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/verticals", headers: admin });
    expect(res.statusCode).toBe(200);
    const codes = (res.json().items as Array<{ code: string }>).map((v) => v.code);
    for (const code of ["factory", "subway", "logistics", "rpo", "daily"]) {
      expect(codes).toContain(code);
    }
  });

  it("accepts a valid vertical_id and persists it into data_json", async () => {
    const id = await createDevice("pc-v-01");
    const subwayId = verticalIdOf("subway");
    const res = await put(id, { vertical_id: subwayId, factory_name: "", city: "广州" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.json().data_json) as Record<string, unknown>;
    expect(data.vertical_id).toBe(subwayId);
    expect(data.city).toBe("广州");
  });

  it("rejects zero / null vertical_id when the field is submitted", async () => {
    const id = await createDevice("pc-v-02");
    expect((await put(id, { vertical_id: 0 })).statusCode).toBe(422);
    expect((await put(id, { vertical_id: null })).statusCode).toBe(422);
  });

  it("rejects an unknown vertical_id", async () => {
    const id = await createDevice("pc-v-03");
    expect((await put(id, { vertical_id: 999999 })).statusCode).toBe(422);
  });

  it("still allows editing other fields without touching vertical_id", async () => {
    // 老客户端只改名字时不带 vertical_id，不能因此被挡
    const id = await createDevice("pc-v-04");
    const res = await put(id, { device_name: "改个名字" });
    expect(res.statusCode).toBe(200);
  });

  it("keeps vertical_id across unrelated updates", async () => {
    const id = await createDevice("pc-v-05");
    const factoryId = verticalIdOf("factory");
    await put(id, { vertical_id: factoryId });
    // 第二次只改城市，vertical_id 不该丢（PUT 做的是浅合并）
    const res = await put(id, { city: "深圳" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.json().data_json) as Record<string, unknown>;
    expect(data.vertical_id).toBe(factoryId);
    expect(data.city).toBe("深圳");
  });

  it("serves vertical ids to the client config endpoint", async () => {
    // 客户端 /config 拿到的品类决定发哪套岗位卡
    const id = await createDevice("pc-v-06");
    const subwayId = verticalIdOf("subway");
    await put(id, { vertical_id: subwayId, city: "广州" });
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-v-06/pair", headers: admin });
    const device = { authorization: `Bearer ${pair.json().device_token}` };
    const res = await app.inject({ method: "GET", url: "/api/v1/bridge/devices/pc-v-06/config", headers: device });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vertical_id: subwayId, city: "广州" });
  });
});

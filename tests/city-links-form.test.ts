import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("Vue city links save contract", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let intercity: number;
  const save = (payload: unknown, headers = admin) => app.inject({ method: "POST", url: "/api/v1/city-links/batch", headers, payload });
  const read = async () => (await app.inject({ method: "GET", url: "/api/v1/city-links", headers: admin })).json();
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "city-form-regression";
    app = buildServer();
    await app.ready();
    const login = async (username: string) => ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } })).json().access_token}` });
    admin = await login("local-admin"); customer = await login("local-customer");
    intercity = Number(app.db.prepare("INSERT INTO cities(city_name,province) VALUES ('广东城际','广东')").run().lastInsertRowid);
    app.db.prepare("UPDATE cities SET data_json=json_set(data_json,'$.custom_note','保留其他配置') WHERE id=1").run();
  });
  afterAll(async () => { delete process.env.REA_PROFILE_TOKEN; await app.close(); });

  it("persists the browser's city-name payload, districts, and existing unrelated settings", async () => {
    const response = await save({ links: [
      { source_city: "广州", target_cities: ["深圳", "广东城际", "广东城际"], districts: ["白云区", "番禺区"] },
      { source_city: "深圳", target_cities: ["东莞"], districts: ["南山区"] },
    ] });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ saved: 3 });
    expect(await read()).toMatchObject({ links: { 广州: ["广东城际", "深圳"], 深圳: ["东莞"] }, districts: { 广州: ["白云区", "番禺区"], 深圳: ["南山区"] } });
    const row = app.db.prepare("SELECT data_json FROM cities WHERE id=1").get() as { data_json: string };
    expect(JSON.parse(row.data_json).custom_note).toBe("保留其他配置");
  });

  it("rejects an invalid later row without losing an earlier city's existing links", async () => {
    const before = await read();
    for (const invalid of [
      { source_city: "不存在", target_cities: [] },
      { source_city: "深圳", target_cities: ["不存在"] },
      { source_city: "深圳", target_cities: ["深圳"] },
      { source_city: "深圳", target_cities: [], districts: "错误类型" },
    ]) {
      expect((await save({ links: [{ source_city: "广州", target_cities: [], districts: [] }, invalid] })).statusCode).toBe(422);
      expect(await read()).toEqual(before);
    }
    expect((await save({})).statusCode).toBe(422);
    expect((await save({ links: "错误类型" })).statusCode).toBe(422);
  });

  it("rejects cities outside the account scope before any partial update", async () => {
    const before = await read();
    expect((await save({ links: [{ source_city: "广州", target_cities: [], districts: [] }, { source_city: "深圳", target_cities: [] }] }, customer)).statusCode).toBe(403);
    expect(await read()).toEqual(before);
    expect((await save({ links: [{ source_city: "广州", target_cities: ["广东城际"] }] }, customer)).statusCode).toBe(403);
  });
  it("retains the numeric API and supports explicitly clearing a city's neighbors", async () => {
    expect((await save({ city_id: 1, linked_city_ids: [2] })).statusCode).toBe(201);
    expect((await read()).links.广州).toEqual(["深圳"]);
    expect((await save({ links: [{ source_city: "广州", target_cities: [], districts: [] }] })).json()).toEqual({ saved: 0 });
    expect((await read()).links.广州).toBeUndefined();
    expect((await read()).districts.广州).toEqual([]);
    expect((await read()).links.深圳).toEqual(["东莞"]);
  });
});

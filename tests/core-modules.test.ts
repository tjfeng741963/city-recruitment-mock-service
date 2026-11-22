import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("core CRUD modules", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    token = login.json().access_token;
  });
  afterAll(async () => { await app.close(); });

  it("lists cities with items and creates a city", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/cities?page=1&page_size=100", headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ city_name: "广州" })]));
    expect(list.json().items[0]).not.toHaveProperty("data_json");
    // "深圳"/"东莞" 是种子数据，"佛山"/"南昌"/"南宁" 由 029 回填写入，
    // 用一个谁都不占的名字，避免 UNIQUE(city_name) 撞车。
    const created = await app.inject({ method: "POST", url: "/api/v1/cities", headers: { authorization: `Bearer ${token}` }, payload: { city_name: "测试城市甲", province: "广东" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ city_name: "测试城市甲", province: "广东" });
  });

  it("lists factories and service positions with filter fields", async () => {
    const factories = await app.inject({ method: "GET", url: "/api/v1/factories", headers: { authorization: `Bearer ${token}` } });
    expect(factories.statusCode).toBe(200);
    expect(factories.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ factory_name: "本地示例工厂" })]));
    expect(typeof factories.json().items[0].is_active).toBe("boolean");
    expect(factories.json().items[0]).not.toHaveProperty("data_json");
    const positions = await app.inject({ method: "GET", url: "/api/v1/service-positions?page_size=1000&city_name=广州", headers: { authorization: `Bearer ${token}` } });
    expect(positions.statusCode).toBe(200);
    expect(positions.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ position_name: "本地示例岗位" })]));
    expect(typeof positions.json().items[0].is_featured).toBe("boolean");
    expect(positions.json().items[0]).not.toHaveProperty("featured");
  });

  it("distinguishes an offline enabled account from a disabled account and respects legacy position status", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const account = app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?)");
    account.run("离线启用账号", "enabled", JSON.stringify({ device_code: "city-reception-enabled" }));
    account.run("停用账号", "disabled", JSON.stringify({ device_code: "city-reception-disabled" }));
    const deviceList = await app.inject({ url: "/api/v1/agent/devices", headers });
    expect(deviceList.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ device_code: "city-reception-enabled", online: false, is_enabled: true }),
      expect.objectContaining({ device_code: "city-reception-disabled", online: false, is_enabled: false }),
    ]));
    const legacy = app.db.prepare("INSERT INTO service_positions(position_name,city_id,status,data_json) VALUES (?,1,'disabled','{}')")
      .run("旧停用岗位");
    const position = await app.inject({ url: `/api/v1/service-positions/${legacy.lastInsertRowid}`, headers });
    expect(position.json()).toMatchObject({ is_active: false });
  });

  it("edits city basics without overwriting newer recruitment defaults or legacy data", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const city = await app.inject({
      method: "POST", url: "/api/v1/cities", headers,
      payload: { city_name: "基础信息验收城", province: "原省份", salary: { raw: "22元/小时" }, legacy_metadata: { keep: true } },
    });
    expect(city.statusCode).toBe(200);
    const cityId = city.json().id;
    const defaultUpdate = await app.inject({
      method: "PUT", url: `/api/v1/dify/cities/${cityId}/materials`, headers,
      payload: { salary: { raw: "24元/小时" }, interview_site_name: "统一面试点", available_lines: ["1号线"] },
    });
    expect(defaultUpdate.statusCode).toBe(200);
    const edit = await app.inject({
      method: "PATCH", url: `/api/v1/cities/${cityId}`, headers,
      payload: { city_name: "基础信息验收城", province: "新省份", districts: [" 甲区 ", "甲区"] },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({
      province: "新省份", districts: ["甲区"], salary: { raw: "24元/小时" },
      interview_site_name: "统一面试点", available_lines: ["1号线"],
    });
    const saved = app.db.prepare("SELECT data_json FROM cities WHERE id=?").get(cityId) as { data_json: string };
    expect(JSON.parse(saved.data_json)).toMatchObject({ legacy_metadata: { keep: true } });
    const invalid = await app.inject({
      method: "PATCH", url: `/api/v1/cities/${cityId}`, headers, payload: { salary: { raw: "" } },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("creates a position bound to a factory and returns factory_id", async () => {
    const city = await app.inject({ method: "POST", url: "/api/v1/cities", headers: { authorization: `Bearer ${token}` }, payload: { city_name: "测试城市乙", province: "广东" } });
    const cityId = city.json().id;
    const factory = await app.inject({ method: "POST", url: "/api/v1/factories", headers: { authorization: `Bearer ${token}` }, payload: { factory_name: "测试厂区", city_id: cityId } });
    expect(factory.statusCode).toBe(200);
    const factoryId = factory.json().id;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/service-positions",
      headers: { authorization: `Bearer ${token}` },
      payload: { position_name: "测试岗位", store_name: "测试厂区", city_id: cityId, factory_id: factoryId, is_active: true },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().factory_id).toBe(factoryId);

    const reloaded = await app.inject({ method: "GET", url: `/api/v1/service-positions/${created.json().id}`, headers: { authorization: `Bearer ${token}` } });
    expect(reloaded.json().factory_id).toBe(factoryId);

    const byCity = await app.inject({ method: "GET", url: `/api/v1/factories?city_id=${cityId}`, headers: { authorization: `Bearer ${token}` } });
    expect(byCity.json().items.map((f: { factory_name: string }) => f.factory_name)).toEqual(["测试厂区"]);
  });

  it("updates the persisted position status when the form toggles is_active", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/service-positions",
      headers: { authorization: `Bearer ${token}` },
      payload: { position_name: "停用回归岗位", city_id: 1, is_active: true },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const disabled = await app.inject({
      method: "PUT",
      url: `/api/v1/service-positions/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { is_active: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().is_active).toBe(false);
    expect((app as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } })
      .db.prepare("SELECT status FROM service_positions WHERE id=?").get(id)).toEqual({ status: "disabled" });
  });

  it("rejects manual city status changes (device-binding derived) and toggles a featured service position", async () => {
    // 2026-11-17：招聘状态由设备绑定自动推导，PATCH 手改返回 422
    const city = await app.inject({ method: "PATCH", url: "/api/v1/cities/1/status", headers: { authorization: `Bearer ${token}` }, payload: { recruitment_status: "inactive" } });
    expect(city.statusCode).toBe(422);
    const position = await app.inject({ method: "PUT", url: "/api/v1/service-positions/1/toggle-featured", headers: { authorization: `Bearer ${token}` } });
    expect(position.statusCode).toBe(200);
    expect(position.json().is_featured).toBe(true);
  });

  it("calculates city reception independently of an enabled position and ignores stale saved city status", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const city = await app.inject({
      method: "POST", url: "/api/v1/cities", headers, payload: { city_name: "接待状态验收城", recruitment_status: "active" },
    });
    expect(city.statusCode).toBe(200);
    const cityId = city.json().id;
    const position = await app.inject({
      method: "POST", url: "/api/v1/service-positions", headers,
      payload: { position_name: "接待状态验收岗位", city_id: cityId, is_active: true },
    });
    expect(position.statusCode).toBe(200);
    const positionId = position.json().id;
    const cityDetail = () => app.inject({ url: `/api/v1/cities/${cityId}`, headers });
    const cityList = (status: string) => app.inject({ url: `/api/v1/cities?status=${status}&page_size=100`, headers });

    expect(position.json().is_active).toBe(true);
    expect((await cityDetail()).json().recruitment_status).toBe("inactive");
    expect((await cityList("inactive")).json().items).toContainEqual(
      expect.objectContaining({ id: cityId, recruitment_status: "inactive" }),
    );

    const device = await app.inject({
      method: "POST", url: "/api/v1/agent/devices", headers,
      payload: { device_code: "city-reception-test", device_name: "状态验收设备", position_id: positionId },
    });
    expect(device.statusCode).toBe(200);
    app.db.prepare("UPDATE cities SET data_json=json_set(data_json,'$.recruitment_status','inactive') WHERE id=?").run(cityId);
    expect((await cityDetail()).json().recruitment_status).toBe("active");
    expect((await cityList("active")).json().items).toContainEqual(
      expect.objectContaining({ id: cityId, recruitment_status: "active" }),
    );
  });
});

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
});

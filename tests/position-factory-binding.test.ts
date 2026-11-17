import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("position factory assignment", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let positionId: number;
  let factoryId: number;
  let otherCityFactory: number;
  let disabledFactory: number;
  const original = {
    position_name: "归属回归安检员", city_name: "广州", store_name: "", is_active: true,
    base_sections: { salary_ask: "125元/班", salary_detail: "125元/班", work_hours: "9:00-18:00" },
    interview_points: [{ name: "竹料基地", address: "既有面试地点" }],
    custom_field: { preserve: true },
  };
  const url = () => `/api/v1/service-positions/${positionId}/factory-binding`;
  const put = (payload: unknown, headers = admin) => app.inject({ method: "PUT", url: url(), headers, payload });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "position-assignment-test";
    app = buildServer();
    await app.ready();
    const login = async (username: string) => ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } })).json().access_token}` });
    admin = await login("local-admin");
    customer = await login("local-customer");
    const factory = (name: string, city: number, status = "enabled", data = {}) => Number(app.db.prepare("INSERT INTO factories(factory_name,city_id,status,data_json) VALUES (?,?,?,?)").run(name, city, status, JSON.stringify(data)).lastInsertRowid);
    factoryId = factory("岗位归属安检厂", 1);
    otherCityFactory = factory("外城安检厂", 2);
    disabledFactory = factory("停用安检厂", 1, "enabled", { is_active: false });
    positionId = Number(app.db.prepare("INSERT INTO service_positions(position_name,city_id,data_json) VALUES (?,1,?)").run(original.position_name, JSON.stringify(original)).lastInsertRowid);
  });
  afterAll(async () => { delete process.env.REA_PROFILE_TOKEN; await app.close(); });

  it("reads the actual SQL assignment and only lists factories in the position city", async () => {
    const response = await app.inject({ method: "GET", url: url(), headers: admin });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ factory_id: null, city_id: 1, city_name: "广州" });
    expect(response.json().factories.map((factory: { id: number }) => factory.id)).toContain(factoryId);
    expect(response.json().factories.map((factory: { id: number }) => factory.id)).not.toContain(otherCityFactory);
  });

  it("does not allow missing, fractional, unknown, cross-city or disabled factories", async () => {
    for (const factory_id of [undefined, 0, -1, 1.5, "1", 999999, otherCityFactory, disabledFactory]) {
      expect((await put({ factory_id })).statusCode).toBe(422);
    }
    expect(app.db.prepare("SELECT factory_id FROM service_positions WHERE id=?").get(positionId)).toMatchObject({ factory_id: null });
  });

  it("requires authentication and prevents an operator from reading or writing another city", async () => {
    expect((await app.inject({ method: "GET", url: url() })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: url(), payload: { factory_id: factoryId } })).statusCode).toBe(403);
    const other = Number(app.db.prepare("INSERT INTO service_positions(position_name,city_id) VALUES ('范围外岗位',2)").run().lastInsertRowid);
    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({ method, url: `/api/v1/service-positions/${other}/factory-binding`, headers: customer, ...(method === "PUT" ? { payload: { factory_id: otherCityFactory } } : {}) });
      expect(response.statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: url(), headers: customer })).statusCode).toBe(200);
  });
  it("explicitly clears an assignment while retaining all job details", async () => {
    expect((await put({ factory_id: null })).json()).toMatchObject({ factory_id: null, factory_name: "" });
    const row = app.db.prepare("SELECT factory_id,data_json FROM service_positions WHERE id=?").get(positionId) as { factory_id: null; data_json: string };
    expect(row.factory_id).toBeNull();
    expect(JSON.parse(row.data_json)).toEqual({ ...original, factory_id: null });
  });
});

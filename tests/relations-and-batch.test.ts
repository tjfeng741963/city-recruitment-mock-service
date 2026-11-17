import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("remaining relation and batch workflows", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token; });
  afterAll(async () => { await app.close(); });

  it("persists city links and recruiter city assignments", async () => {
    // Target answers 201 {saved: n}, not 200 {success: true}.
    const link = await app.inject({ method: "POST", url: "/api/v1/city-links/batch", headers: { authorization: `Bearer ${token}` }, payload: { city_id: 1, linked_city_ids: [2] } });
    expect(link.statusCode).toBe(201);
    expect(link.json()).toHaveProperty("saved");
    const cityLinks = await app.inject({ method: "GET", url: "/api/v1/city-links", headers: { authorization: `Bearer ${token}` } });
    expect(cityLinks.json().links).toMatchObject({ 广州: ["深圳"] });
    // The target 404s "Recruiter not found" for a missing recruiter, so the test
    // must create one first rather than assuming a seeded id.
    const created = await app.inject({ method: "POST", url: "/api/v1/recruiters", headers: { authorization: `Bearer ${token}` }, payload: { recruiter_id: "test-recruiter", name: "测试招聘员" } });
    const recruiterId = created.json().id;
    const recruiter = await app.inject({ method: "POST", url: `/api/v1/recruiters/${recruiterId}/cities/batch`, headers: { authorization: `Bearer ${token}` }, payload: { city_ids: [1, 2] } });
    expect(recruiter.json().success).toBe(true);
    const cities = await app.inject({ method: "GET", url: `/api/v1/recruiters/${recruiterId}/cities`, headers: { authorization: `Bearer ${token}` } });
    expect(cities.json().items).toEqual(expect.any(Array));
  });
  it("keeps city history, holidays and recruiter relations", async () => {
    const updated = await app.inject({ method: "PUT", url: "/api/v1/cities/1", headers: { authorization: `Bearer ${token}` }, payload: { city_name: "广州新名" } });
    expect(updated.statusCode).toBe(200);
    const history = await app.inject({ method: "GET", url: "/api/v1/cities/1/history?page=1&page_size=10", headers: { authorization: `Bearer ${token}` } });
    expect(history.json().total).toBeGreaterThan(0);
    const holiday = await app.inject({ method: "POST", url: "/api/v1/service-positions/1/holidays", headers: { authorization: `Bearer ${token}` }, payload: { year: 2026, holiday_name: "圣诞节", start_date: "2026-12-25", end_date: "2026-12-25", label: "圣诞节" } });
    expect(holiday.statusCode).toBe(200);
    const holidays = await app.inject({ method: "GET", url: "/api/v1/service-positions/1/holidays", headers: { authorization: `Bearer ${token}` } });
    expect(holidays.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "圣诞节" })]));
  });
});

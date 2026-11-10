import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * The restored React application must be a real same-origin Fastify asset.
 * The test intentionally selects the production-style frontend directory so
 * the legacy Vue shell remains covered by smoke.test.ts independently.
 */
describe("React frontend served by the Node backend", () => {
  let app: FastifyInstance;
  let recruiterToken: string;

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_FRONTEND_DIR = "frontend/dist";
    app = buildServer();
    await app.ready();
    recruiterToken = (await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-recruiter", password: "local-demo-only" },
    })).json().access_token;
  });

  afterAll(async () => {
    delete process.env.REA_FRONTEND_DIR;
    await app.close();
  });

  it.each(["/", "/conversations", "/agent-devices", "/knowledge", "/settings/wecom"]) ("serves the React SPA shell for %s", async (route) => {
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('<div id="root"></div>');
    expect(response.body).toMatch(/\/assets\/index-[^\"]+\.js/);
  });

  it("serves the hashed React entry asset", async () => {
    const shell = await app.inject({ method: "GET", url: "/" });
    const asset = shell.body.match(/src="(\/assets\/index-[^\"]+\.js)"/)?.[1];
    expect(asset).toBeTruthy();
    const response = await app.inject({ method: "GET", url: asset! });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
  });

  it("exposes the response envelopes consumed by the React API clients", async () => {
    const headers = { authorization: `Bearer ${recruiterToken}` };
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: "local-recruiter", role: "recruiter" });

    const [devices, conversations, cities, knowledge, featured] = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/agent/devices", headers }),
      app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers }),
      app.inject({ method: "GET", url: "/api/v1/cities?page_size=1000", headers }),
      app.inject({ method: "GET", url: "/api/v1/knowledge?page=1&page_size=20", headers }),
      app.inject({ method: "GET", url: "/api/v1/recruiter-featured/cities", headers }),
    ]);
    expect(devices.statusCode).toBe(200);
    expect(devices.json()).toEqual(expect.objectContaining({ items: expect.any(Array) }));
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json()).toEqual(expect.objectContaining({ items: expect.any(Array), total_unread: expect.any(Number) }));
    expect(cities.statusCode).toBe(200);
    expect(cities.json()).toEqual(expect.objectContaining({ items: expect.any(Array), total: expect.any(Number) }));
    expect(knowledge.statusCode).toBe(200);
    expect(knowledge.json()).toEqual(expect.objectContaining({ items: expect.any(Array), total: expect.any(Number) }));
    expect(featured.statusCode).toBe(200);
    expect(featured.json()).toEqual(expect.objectContaining({ items: expect.any(Array), total: expect.any(Number), max_featured: 3 }));
    expect(featured.json().items[0]).toEqual(expect.objectContaining({ city_id: expect.any(Number), city_name: expect.any(String), positions: expect.any(Array) }));
  });

  it("accepts a React主推城市 update by numeric city id", async () => {
    const headers = { authorization: `Bearer ${recruiterToken}` };
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/recruiter-featured/cities/1",
      headers,
      payload: { position_ids: [1, 999999] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    const readback = await app.inject({ method: "GET", url: "/api/v1/recruiter-featured/cities", headers });
    expect(readback.json().items.find((item: { city_id: number }) => item.city_id === 1).position_ids).toEqual([1]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";

describe("activation devices batch-toggle", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let token = "";
  const headers = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    db = (app as FastifyInstance & { db: DatabaseSync }).db;
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;

    db.prepare("INSERT INTO activation_devices(device_name,status,data_json) VALUES (?,?,?)")
      .run("设备一", "enabled", JSON.stringify({ device_code: "batch-dev-1" }));
    db.prepare("INSERT INTO activation_devices(device_name,status,data_json) VALUES (?,?,?)")
      .run("设备二", "enabled", JSON.stringify({ device_code: "batch-dev-2" }));
  });

  afterAll(async () => { await app.close(); });

  it("actually disables only the matched device codes and reports the real count", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/activation/devices/batch-toggle",
      headers: headers(),
      payload: { device_codes: ["batch-dev-1"], enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, updated: 1 });

    const list = await app.inject({ method: "GET", url: "/api/v1/activation/devices", headers: headers() });
    const items = list.json().items as Array<{ device_code: string; activation_enabled: boolean }>;
    expect(items.find((item) => item.device_code === "batch-dev-1")).toMatchObject({ activation_enabled: false });
    expect(items.find((item) => item.device_code === "batch-dev-2")).toMatchObject({ activation_enabled: true });
  });

  it("returns updated: 0 for device codes that do not exist, without touching real rows", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/activation/devices/batch-toggle",
      headers: headers(),
      payload: { device_codes: ["no-such-device"], enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, updated: 0 });
  });

  it("rejects non-admin callers", async () => {
    const guestLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-recruiter", password: "local-demo-only" } });
    const guestToken = guestLogin.json().access_token;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/activation/devices/batch-toggle",
      headers: { authorization: `Bearer ${guestToken}` },
      payload: { device_codes: ["batch-dev-2"], enabled: false },
    });
    expect(response.statusCode).toBe(403);
  });
});

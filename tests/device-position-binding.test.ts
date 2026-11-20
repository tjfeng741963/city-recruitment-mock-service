import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("device position binding", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
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
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it("replaces a stale position when the bound factory changes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "position-device", factory_ids: [1] },
    });
    expect(created.statusCode).toBe(200);
    const id = Number(created.json().id);
    expect(JSON.parse(created.json().data_json)).toMatchObject({ factory_ids: [1], position_id: 1 });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/agent/devices/${id}`,
      headers: admin,
      payload: { factory_ids: [2] },
    });
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.json().data_json)).toMatchObject({ factory_ids: [2], position_id: 2 });

    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/position-device/pair", headers: admin });
    const device = { authorization: `Bearer ${pair.json().device_token}` };
    const flow = await app.inject({ method: "GET", url: "/api/v1/agent/flow?device_code=position-device", headers: device });
    expect(flow.statusCode).toBe(200);
    expect(flow.json().position_id).toBe(2);
  });

  it("rejects an explicitly selected position from another factory", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "position-device-2", factory_ids: [1], position_id: 2 },
    });
    expect(created.statusCode).toBe(422);
    expect(created.json().detail).toContain("绑定岗位必须属于已绑定工厂");
  });
});

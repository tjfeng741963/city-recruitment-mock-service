import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("agent config sync evidence", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let device: Record<string, string>;
  let anotherDevice: Record<string, string>;
  const saved = { ...process.env };
  const deviceCode = "config-sync-device";
  const payload = () => ({
    device_code: deviceCode,
    client_commit: "a".repeat(40),
    flow: { position_id: 25, version: 3, status: "enabled", synced_at: "2026-11-21T14:01:00+08:00",
      checked_at: "2026-11-21T14:02:00+08:00", state: "stale", error: "network" },
    opening: { position_id: 25, version: "b".repeat(64), synced_at: "2026-11-21T06:01:00Z",
      checked_at: "2026-11-21T06:02:00Z", state: "synced", error: "" },
  });

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_SEED_FIXTURES = "1";
    app = buildServer();
    await app.ready();
    const login = async (username: string) => {
      const result = await app.inject({ method: "POST", url: "/api/v1/auth/login",
        payload: { username, password: "local-demo-only" } });
      expect(result.statusCode).toBe(200);
      return { authorization: `Bearer ${result.json().access_token}` };
    };
    admin = await login("local-admin");
    customer = await login("local-customer");
    const pair = async (code: string) => {
      app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)")
        .run(code, JSON.stringify({ device_code: code, position_id: 25, untouched: "preserve" }));
      const result = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/pair`, headers: admin });
      expect(result.statusCode).toBe(200);
      return { authorization: `Bearer ${result.json().device_token}` };
    };
    device = await pair(deviceCode);
    anotherDevice = await pair("another-config-device");
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_SEED_FIXTURES"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("requires the owning device to report and an administrator to read one device", async () => {
    const unknown = await app.inject({ method: "GET", url: `/api/v1/agent/config-sync?device_code=${deviceCode}`, headers: admin });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ available: false, device_code: deviceCode, reply_provider: "agent", bridge_state: "offline" });
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/config-sync", headers: admin })).statusCode).toBe(422);
    for (const headers of [admin, customer, anotherDevice, {}]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers, payload: payload() })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers: device, payload: payload() })).statusCode).toBe(200);
    for (const headers of [customer, {}]) {
      expect((await app.inject({ method: "GET", url: `/api/v1/agent/config-sync?device_code=${deviceCode}`, headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: `/api/v1/agent/config-sync?device_code=${deviceCode}`, headers: device })).statusCode).toBe(401);
  });

  it("stores only safe fields, canonicalizes times and sets its own receive time", async () => {
    const input = payload();
    const before = Date.now();
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers: device,
      payload: { ...input, token: "secret-token", body: "customer-message", server_received_at: "2000-01-01T00:00:00Z",
        flow: { ...input.flow, token: "secret-token", content: "customer-message" },
        opening: { ...input.opening, snapshot: { text: "customer-message" } } } });
    expect(response.statusCode).toBe(200);
    const result = (await app.inject({ method: "GET", url: `/api/v1/agent/config-sync?device_code=${deviceCode}`, headers: admin })).json();
    expect(result).toMatchObject({ available: true, device_code: deviceCode, client_commit: "a".repeat(40),
      flow: { position_id: 25, version: 3, status: "enabled", synced_at: "2026-11-21T06:01:00.000Z", checked_at: "2026-11-21T06:02:00.000Z", state: "stale", error: "network" },
      opening: { position_id: 25, version: "b".repeat(64), state: "synced", error: "" } });
    expect(Date.parse(result.server_received_at)).toBeGreaterThanOrEqual(before);
    expect(result.server_received_at).toMatch(/Z$/);
    expect(response.json()).toEqual({ ok: true, server_received_at: result.server_received_at });
    const row = app.db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?")
      .get(deviceCode) as { data_json: string };
    const stored = JSON.parse(row.data_json);
    expect(stored.untouched).toBe("preserve");
    expect(Object.keys(stored.config_sync).sort()).toEqual(["client_commit", "flow", "opening", "server_received_at"]);
    expect(Object.keys(stored.config_sync.flow).sort()).toEqual(["checked_at", "error", "position_id", "state", "status", "synced_at", "version"]);
    expect(JSON.stringify(stored.config_sync)).not.toMatch(/secret-token|customer-message|snapshot|2000-01-01/);
  });

  it("rejects free-text errors, invalid versions and non-ISO timestamps without replacing evidence", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers: device, payload: payload() })).statusCode).toBe(200);
    const read = async () => (await app.inject({ method: "GET", url: `/api/v1/agent/config-sync?device_code=${deviceCode}`, headers: admin })).json();
    const original = await read();
    const input = payload();
    for (const invalid of [
      { ...input, flow: { ...input.flow, error: "HTTP 401 Bearer secret-token" } },
      { ...input, flow: { ...input.flow, state: "ready" } },
      { ...input, flow: { ...input.flow, checked_at: "2026-11-21 06:02:00" } },
      { ...input, opening: { ...input.opening, version: "customer-message" } },
    ]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers: device, payload: invalid })).statusCode).toBe(422);
    }
    expect(await read()).toEqual(original);
  });

  it("accepts initial unknown branches and omits an invalid client commit", async () => {
    const unknown = { position_id: null, version: null, synced_at: null, checked_at: null, state: "error", error: "unknown" };
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers: device,
      payload: { device_code: deviceCode, client_commit: "not-a-installed-commit", flow: { ...unknown, status: null }, opening: unknown } });
    expect(response.statusCode).toBe(200);
    const result = (await app.inject({ method: "GET", url: `/api/v1/agent/config-sync?device_code=${deviceCode}`, headers: admin })).json();
    expect(result.client_commit).toBeNull();
    expect(result.flow).toEqual({ ...unknown, status: null });
    expect(result.opening).toEqual(unknown);
  });

  it("does not let generic device creation or edits forge configuration sync evidence", async () => {
    const forged = { ...payload(), server_received_at: "2026-11-21T06:02:00Z" };
    const created = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: admin,
      payload: { device_name: "伪造摘要设备", device_code: "create-sync-forgery", config_sync: forged } });
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(created.json().data_json)).not.toHaveProperty("config_sync");

    expect((await app.inject({ method: "POST", url: "/api/v1/agent/config-sync", headers: device, payload: payload() })).statusCode).toBe(200);
    const row = app.db.prepare("SELECT id,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?")
      .get(deviceCode) as { id: number; data_json: string };
    const original = JSON.parse(row.data_json).config_sync;
    // The evidence may mention an old position; the editable device binding must
    // still refer to a currently existing position for its unrelated validator.
    app.db.prepare("UPDATE agent_devices SET data_json=json_remove(data_json,'$.position_id') WHERE id=?").run(row.id);
    const user = app.db.prepare("SELECT id FROM users WHERE username='local-customer'").get() as { id: number };
    app.db.prepare("INSERT INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?,'device',?)")
      .run(user.id, deviceCode);
    for (const headers of [admin, customer]) {
      const result = await app.inject({ method: "PUT", url: `/api/v1/agent/devices/${row.id}`, headers,
        payload: { name: "仍可编辑普通设备字段", config_sync: { ...forged, client_commit: "c".repeat(40) } } });
      expect(result.statusCode).toBe(200);
      const updated = app.db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(row.id) as { data_json: string };
      expect(JSON.parse(updated.data_json).config_sync).toEqual(original);
      expect(JSON.parse(updated.data_json).name).toBe("仍可编辑普通设备字段");
    }
  });
});

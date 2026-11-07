import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 设备自注册（方案 A）：客户端首次启动没有 JWT，凭 X-Register-Key 换 token。
// 重点验证：没配密钥时入口不开放、密钥错误不泄露信息、重复注册幂等、停用不被推翻。
describe("device self-registration", () => {
  let app: FastifyInstance;
  const saved = { ...process.env };
  const key = "self-register-key-for-tests";
  const code = "pc-selftest01";
  const register = (headers: Record<string, string> = { "x-register-key": key }, target = code) =>
    app.inject({ method: "POST", url: `/api/v1/bridge/devices/${target}/register`, headers, payload: {} });

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    process.env.REA_REGISTER_KEY = key;
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    for (const name of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER", "REA_REGISTER_KEY"]) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  });

  it("creates the device and hands back a working bridge token", async () => {
    const created = await register();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ device_code: code, created: true });
    const token = created.json().device_token as string;
    expect(token).toHaveLength(64);

    // 注册出来的 token 必须能直接调用设备接口。
    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/v1/bridge/devices/${code}/heartbeat`,
      headers: { authorization: `Bearer ${token}` },
      payload: { state: "online", account_id: "wx-owner" },
    });
    expect(heartbeat.statusCode).toBe(200);
  });

  it("records the device as observe_only so the Node side never auto-replies", async () => {
    await register();
    const row = app.db.prepare("SELECT status,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as { status: string; data_json: string };
    expect(row.status).toBe("enabled");
    expect(JSON.parse(row.data_json)).toMatchObject({ device_code: code, observe_only: true, registered_by: "self" });
  });

  it("is idempotent: registering twice keeps one row and rotates the token", async () => {
    const first = await register();
    const second = await register();
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().device_token).not.toBe(first.json().device_token);

    const count = app.db.prepare("SELECT COUNT(*) n FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as { n: number };
    expect(count.n).toBe(1);

    // 旧 token 立即失效，避免两台机器同时用同一个码互相覆盖。
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/bridge/devices/${code}/heartbeat`,
      headers: { authorization: `Bearer ${first.json().device_token}` },
      payload: { state: "online", account_id: "wx-owner" },
    });
    expect(stale.statusCode).toBe(401);
  });

  it("refuses a disabled device instead of re-enabling it", async () => {
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?, 'disabled', ?)")
      .run("停用设备", JSON.stringify({ device_code: code }));
    const result = await register();
    expect(result.statusCode).toBe(403);
    const row = app.db.prepare("SELECT status FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as { status: string };
    expect(row.status).toBe("disabled");
  });

  it("rejects a wrong or missing key without creating anything", async () => {
    expect((await register({ "x-register-key": "wrong-key-wrong-key-wrong" })).statusCode).toBe(401);
    expect((await register({})).statusCode).toBe(401);
    const count = app.db.prepare("SELECT COUNT(*) n FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as { n: number };
    expect(count.n).toBe(0);
  });

  it("closes the endpoint entirely when no key is configured", async () => {
    delete process.env.REA_REGISTER_KEY;
    const reopened = buildServer();
    await reopened.ready();
    const result = await reopened.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/register`, headers: { "x-register-key": key }, payload: {} });
    expect(result.statusCode).toBe(503);
    await reopened.close();
  });

  it("rejects a malformed device code before touching the database", async () => {
    const result = await register({ "x-register-key": key }, "PC_Bad.Code");
    expect(result.statusCode).toBe(422);
  });
});

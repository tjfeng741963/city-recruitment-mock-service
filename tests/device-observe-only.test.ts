import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 双引擎回复事故的回归保护（2026-11-13 实机）：
// 服务端 message-automation 收到 inbound 会自己生成回复并入队 bridge_commands，
// 客户端 drain() 也会调 8090 直接键鼠发送。两边同时开 → 同一会话阶段被推进
// 两次 → 客户收到两条不同回复（左边一句、右边一句）。
//
// observe_only=true 让服务端只记录不生成，执行权归客户端。两条创建设备的路径
// 都必须默认写 true：自注册（/bridge/.../register）和管理员建号
// （POST /api/v1/agent/devices）。
describe("device creation defaults to observe_only", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    process.env.REA_REGISTER_KEY = "unit-test-register-key-0123456789";
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
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER", "REA_REGISTER_KEY"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const readDevice = (code: string) => {
    const row = app.db
      .prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?")
      .get(code) as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as Record<string, unknown>) : undefined;
  };

  it("admin-created device is observe_only so the server never auto-replies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "pc-admin-01", device_name: "网页建的设备" },
    });
    expect(res.statusCode).toBe(200);
    expect(readDevice("pc-admin-01")).toMatchObject({ device_code: "pc-admin-01", observe_only: true });
  });

  it("admin can still explicitly opt out for the official WeCom channel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "pc-kf-01", device_name: "官方客服通道", observe_only: false },
    });
    expect(res.statusCode).toBe(200);
    expect(readDevice("pc-kf-01")).toMatchObject({ observe_only: false });
  });

  it("self-registered device stays observe_only (unchanged behaviour)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-self-01/register",
      headers: { "x-register-key": process.env.REA_REGISTER_KEY! },
      payload: { name: "自注册设备" },
    });
    expect(res.statusCode).toBe(201);
    expect(readDevice("pc-self-01")).toMatchObject({ observe_only: true });
  });

});

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { buildServer } from "../src/server.js";

describe("phase-two agent and activation flows", () => {
  // 该文件验证 manual-reply 的落库与消息流（非 bridge 通道）——默认 bridge
  // 后（2026-11-18）必须显式切回 mock，否则入队即 409（设备未配对）。
  beforeAll(() => { process.env.REA_MESSAGE_CHANNEL_PROVIDER = "mock"; });
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
  });
  afterAll(async () => { await app.close(); });

  it("creates a device and persists a manual reply", async () => {
    const device = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: { authorization: `Bearer ${token}` }, payload: { device_code: "D-1", device_name: "测试设备", status: "enabled" } });
    expect(device.statusCode).toBe(200);
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname) VALUES (?,?,?)").run("D-1", 7, "测试客户");
    const reply = await app.inject({ method: "POST", url: "/api/v1/agent/manual-reply", headers: { authorization: `Bearer ${token}` }, payload: { device_code: "D-1", customer_id: 7, content: "你好" } });
    expect(reply.statusCode).toBe(200);
    const messages = await app.inject({ method: "GET", url: "/api/v1/agent/messages?device_code=D-1&customer_id=7&after_id=0", headers: { authorization: `Bearer ${token}` } });
    expect(messages.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ content: "你好", direction: "outbound" })]));
  });
});

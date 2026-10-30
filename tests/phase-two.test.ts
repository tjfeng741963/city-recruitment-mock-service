import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { buildServer } from "../src/server.js";

describe("phase-two agent and activation flows", () => {
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

  it("tests a device's own Dify connection against its stored dify_url/dify_key", async () => {
    let received: { authorization?: string } = {};
    const server: Server = createServer((request, response) => {
      received.authorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ answer: "ok", message_id: "msg-1", conversation_id: "conv-1" }));
    }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const difyUrl = `http://127.0.0.1:${address.port}`;

    try {
      const device = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: { authorization: `Bearer ${token}` }, payload: { device_code: "D-dify-test", device_name: "测试连接设备", status: "enabled", dify_url: difyUrl, dify_key: "device-own-key" } });
      expect(device.statusCode).toBe(200);
      const deviceId = device.json().id;

      const result = await app.inject({ method: "POST", url: `/api/v1/agent/devices/${deviceId}/test-dify`, headers: { authorization: `Bearer ${token}` } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ device_id: deviceId, base_url: difyUrl, healthy: true });
      expect(received.authorization).toBe("Bearer device-own-key");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects test-dify for a device that has no dify_url configured", async () => {
    const device = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: { authorization: `Bearer ${token}` }, payload: { device_code: "D-no-dify", device_name: "未配置设备", status: "enabled" } });
    const deviceId = device.json().id;
    const result = await app.inject({ method: "POST", url: `/api/v1/agent/devices/${deviceId}/test-dify`, headers: { authorization: `Bearer ${token}` } });
    expect(result.statusCode).toBe(422);
  });

  it("404s test-dify for an unknown device id", async () => {
    const result = await app.inject({ method: "POST", url: "/api/v1/agent/devices/999999/test-dify", headers: { authorization: `Bearer ${token}` } });
    expect(result.statusCode).toBe(404);
  });

  it("moves an activation record through approval and sending", async () => {
    const db = (app as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("INSERT INTO activation_records(customer_id,nickname,status) VALUES (?,?,?)").run(9, "测试客户", "pending_review");
    const approved = await app.inject({ method: "POST", url: "/api/v1/activation/records/1/approve", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("pending_send");
    const sent = await app.inject({ method: "POST", url: "/api/v1/activation/records/1/run", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(sent.json().status).toBe("sent");
    expect(sent.json().tier).toBe(1);
  });
});

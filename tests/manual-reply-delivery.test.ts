import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("manual reply gateway delivery", () => {
  let app: FastifyInstance | undefined;
  let gateway: Server | undefined;
  let token = "";
  const originalEnv = {
    databasePath: process.env.REA_DATABASE_PATH,
    provider: process.env.REA_MESSAGE_CHANNEL_PROVIDER,
    sendUrl: process.env.REA_MESSAGE_CHANNEL_SEND_URL,
    gatewayToken: process.env.REA_MESSAGE_CHANNEL_TOKEN,
    difyProvider: process.env.REA_DIFY_PROVIDER,
    webhookSecret: process.env.REA_WEBHOOK_SECRET,
  };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "http";
    process.env.REA_MESSAGE_CHANNEL_TOKEN = "gateway-secret-for-test";
    process.env.REA_DIFY_PROVIDER = "mock";
    process.env.REA_WEBHOOK_SECRET = "webhook-test-secret";
    gateway = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, message_id: "bridge-message-1" }));
    }).listen(0);
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    process.env.REA_MESSAGE_CHANNEL_SEND_URL = `http://127.0.0.1:${address.port}/send`;

    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname) VALUES (?,?,?)").run("D-1", 7, "测试客户");
  });

  afterEach(async () => {
    if (app) await app.close();
    if (gateway) await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    app = undefined;
    gateway = undefined;
    if (originalEnv.databasePath === undefined) delete process.env.REA_DATABASE_PATH;
    else process.env.REA_DATABASE_PATH = originalEnv.databasePath;
    if (originalEnv.provider === undefined) delete process.env.REA_MESSAGE_CHANNEL_PROVIDER;
    else process.env.REA_MESSAGE_CHANNEL_PROVIDER = originalEnv.provider;
    if (originalEnv.sendUrl === undefined) delete process.env.REA_MESSAGE_CHANNEL_SEND_URL;
    else process.env.REA_MESSAGE_CHANNEL_SEND_URL = originalEnv.sendUrl;
    if (originalEnv.gatewayToken === undefined) delete process.env.REA_MESSAGE_CHANNEL_TOKEN;
    else process.env.REA_MESSAGE_CHANNEL_TOKEN = originalEnv.gatewayToken;
    if (originalEnv.difyProvider === undefined) delete process.env.REA_DIFY_PROVIDER;
    else process.env.REA_DIFY_PROVIDER = originalEnv.difyProvider;
    if (originalEnv.webhookSecret === undefined) delete process.env.REA_WEBHOOK_SECRET;
    else process.env.REA_WEBHOOK_SECRET = originalEnv.webhookSecret;
  });

  it("records a confirmed gateway send and deduplicates the same idempotency key", async () => {
    let sends = 0;
    gateway?.removeAllListeners("request");
    gateway?.on("request", (_request, response) => {
      sends += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, message_id: "bridge-message-1" }));
    });
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "manual-reply-7-1" };
    const payload = { device_code: "D-1", customer_id: 7, content: "可以，我发你岗位详情" };
    const first = await app!.inject({ method: "POST", url: "/api/v1/agent/manual-reply", headers, payload });
    const retry = await app!.inject({ method: "POST", url: "/api/v1/agent/manual-reply", headers, payload });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ device_code: "D-1", customer_id: 7, direction: "outbound", content: payload.content, status: "sent" });
    expect(first.json()).not.toHaveProperty("source_event_id");
    expect(retry.json()).toMatchObject({ id: first.json().id, status: "sent" });
    expect(sends).toBe(1);
    expect(app!.db.prepare("SELECT status,attempts,provider_message_id FROM message_deliveries").get())
      .toMatchObject({ status: "succeeded", attempts: 1, provider_message_id: "bridge-message-1" });
  });

  it("stores a failed manual delivery and returns a gateway error instead of claiming it was sent", async () => {
    gateway?.removeAllListeners("request");
    gateway?.on("request", (_request, response) => { response.statusCode = 503; response.end("unavailable"); });
    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/agent/manual-reply",
      headers: { authorization: `Bearer ${token}` },
      payload: { device_code: "D-1", customer_id: 7, content: "请重试" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ detail: "Message channel delivery failed", error: "Message gateway HTTP 503" });
    expect(app!.db.prepare("SELECT direction,content,status FROM agent_messages WHERE content='请重试'").get())
      .toMatchObject({ direction: "outbound", content: "请重试", status: "failed" });
    expect(app!.db.prepare("SELECT status,attempts,last_error FROM message_deliveries").get())
      .toMatchObject({ status: "failed", attempts: 1, last_error: "Message gateway HTTP 503" });
  });

  it("rejects reuse of an idempotency key for different message content", async () => {
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "manual-reply-content-check" };
    const first = await app!.inject({
      method: "POST",
      url: "/api/v1/agent/manual-reply",
      headers,
      payload: { device_code: "D-1", customer_id: 7, content: "第一条内容" },
    });
    const conflict = await app!.inject({
      method: "POST",
      url: "/api/v1/agent/manual-reply",
      headers,
      payload: { device_code: "D-1", customer_id: 7, content: "不同内容" },
    });

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ detail: "Idempotency key was already used with different content" });
    expect(app!.db.prepare("SELECT COUNT(*) count FROM message_deliveries").get()).toMatchObject({ count: 1 });
  });

  it("runs a signed inbound message through Dify and the configured target API gateway", async () => {
    let sends = 0;
    gateway?.removeAllListeners("request");
    gateway?.on("request", (request, response) => {
      sends += 1;
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        expect(JSON.parse(body)).toEqual({
          device_code: "D-1",
          customer_id: 7,
          content: "Mock response for 7",
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: 18022, status: "sent" }));
      });
    });
    app!.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?)")
      .run("测试设备", "enabled", JSON.stringify({ device_code: "D-1", dify_url: "mock://local", dify_key: "" }));
    const payload = {
      id: "inbound-gateway-loop-1",
      event: "message.created",
      data: { device_code: "D-1", customer_id: 7, content: "想了解岗位" },
    };
    const signature = createHmac("sha256", "webhook-test-secret").update(JSON.stringify(payload)).digest("hex");

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/webhooks/dify",
      headers: { "content-type": "application/json", "x-dify-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "processed", event_id: "inbound-gateway-loop-1", reply_status: "sent" });
    expect(sends).toBe(1);
    expect(app!.db.prepare("SELECT status,provider_message_id,attempts FROM message_deliveries WHERE event_id='inbound-gateway-loop-1:reply'").get())
      .toMatchObject({ status: "succeeded", provider_message_id: "18022", attempts: 1 });
  });
});

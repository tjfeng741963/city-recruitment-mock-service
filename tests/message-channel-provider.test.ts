import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { HttpMessageChannelProvider, createMessageChannelProvider } from "../src/modules/messaging/message-channel-provider.js";

describe("HTTP message channel provider", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("sends the device message with bearer auth and an idempotency key", async () => {
    let received: { authorization?: string; idempotencyKey?: string; url?: string; body?: Record<string, unknown> } = {};
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = {
          authorization: request.headers.authorization,
          idempotencyKey: request.headers["idempotency-key"],
          url: request.url,
          body: JSON.parse(body) as Record<string, unknown>,
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: 18021, direction: "outbound", status: "sent" }));
      });
    }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpMessageChannelProvider({
      sendUrl: `http://127.0.0.1:${address.port}/send`,
      token: "bridge-test-token",
      timeoutMs: 2_000,
    });
    const result = await provider.sendMessage({
      deviceCode: "device-7",
      customerId: 51,
      content: "你好，岗位还在招",
      idempotencyKey: "reply-event-1",
    });

    expect(result).toEqual({ success: true, message_id: "18021" });
    expect(received).toEqual({
      authorization: "Bearer bridge-test-token",
      idempotencyKey: "reply-event-1",
      url: "/send",
      body: { device_code: "device-7", customer_id: 51, content: "你好，岗位还在招" },
    });
  });

  it("fails closed when the gateway does not confirm a real message id", async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true }));
    }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpMessageChannelProvider({ sendUrl: `http://127.0.0.1:${address.port}/send` });
    await expect(provider.sendMessage({ deviceCode: "d", customerId: 1, content: "hi", idempotencyKey: "evt" }))
      .resolves.toMatchObject({ success: false, error: "Message gateway omitted message_id" });
  });

  it("does not treat a failed target message record as a successful send", async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 18021, status: "failed" }));
    }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpMessageChannelProvider({ sendUrl: `http://127.0.0.1:${address.port}/send` });
    await expect(provider.sendMessage({ deviceCode: "d", customerId: 1, content: "hi", idempotencyKey: "evt" }))
      .resolves.toMatchObject({ success: false, error: "Message gateway did not confirm delivery" });
  });

  it("does not echo gateway response bodies or credentials in errors", async () => {
    server = createServer((_request, response) => { response.statusCode = 503; response.end("bridge-test-token internal detail"); }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpMessageChannelProvider({ sendUrl: `http://127.0.0.1:${address.port}/send`, token: "bridge-test-token", timeoutMs: 2_000 });
    const result = await provider.sendMessage({ deviceCode: "d", customerId: 1, content: "hi", idempotencyKey: "evt" });

    expect(result).toEqual({ success: false, error: "Message gateway HTTP 503" });
    expect(result.error).not.toContain("bridge-test-token");
  });

  it("treats a gateway timeout as a failed delivery", async () => {
    server = createServer(() => { /* intentionally never responds */ }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpMessageChannelProvider({ sendUrl: `http://127.0.0.1:${address.port}/send`, timeoutMs: 25 });
    await expect(provider.sendMessage({ deviceCode: "d", customerId: 1, content: "hi", idempotencyKey: "evt" }))
      .resolves.toMatchObject({ success: false, error: "Message gateway request timeout" });
  });

  it("builds the HTTP provider only when its send URL is configured", () => {
    const originalMode = process.env.REA_MESSAGE_CHANNEL_PROVIDER;
    const originalUrl = process.env.REA_MESSAGE_CHANNEL_SEND_URL;
    delete process.env.REA_MESSAGE_CHANNEL_SEND_URL;
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "http";

    try {
      expect(() => createMessageChannelProvider()).toThrow("REA_MESSAGE_CHANNEL_SEND_URL is required");
    } finally {
      if (originalMode === undefined) delete process.env.REA_MESSAGE_CHANNEL_PROVIDER;
      else process.env.REA_MESSAGE_CHANNEL_PROVIDER = originalMode;
      if (originalUrl === undefined) delete process.env.REA_MESSAGE_CHANNEL_SEND_URL;
      else process.env.REA_MESSAGE_CHANNEL_SEND_URL = originalUrl;
    }
  });

  it("rejects a public HTTP URL before credentials or message content can be sent in cleartext", () => {
    expect(() => new HttpMessageChannelProvider({ sendUrl: "http://47.107.245.246:8080/api/v1/agent/manual-reply", token: "token" }))
      .toThrow("Message gateway must use HTTPS unless it is on a private or loopback network");
  });
});

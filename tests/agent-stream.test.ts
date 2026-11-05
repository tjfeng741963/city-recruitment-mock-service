import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// EventSource cannot send headers, so ../stream authenticates with ?token=.
// app.inject() cannot read a response that never ends, so the streaming cases
// talk to a real listening socket and consume the body through fetch().
interface StreamHandle {
  headers: Headers;
  state: { text: string };
  close: () => void;
}

interface Frame { type: string; data: Record<string, any> }

function parseFrames(text: string): Frame[] {
  return text.split("\n\n").flatMap((chunk) => {
    const type = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (!type) return [];
    return [{ type, data: data ? JSON.parse(data) as Record<string, any> : {} }];
  });
}

async function waitFor(check: () => boolean, describeFailure: () => string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(describeFailure());
}

describe("agent SSE stream", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let token: string;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const streams: StreamHandle[] = [];
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    token = login.json().access_token;
    admin = { authorization: `Bearer ${token}` };
    // observe_only: inbound records the message but never queues an AI reply,
    // so these tests can never reach a real keyboard client.
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?)")
      .run("观察设备", "enabled", JSON.stringify({ device_code: "pc-office-01", observe_only: true }));
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const openStream = async (query: string): Promise<StreamHandle> => {
    const controller = new AbortController();
    const state = { text: "" };
    const response = await fetch(`${baseUrl}/api/v1/agent/stream?${query}`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          state.text += decoder.decode(value, { stream: true });
        }
      } catch { /* aborted by the test */ }
    })();
    const handle: StreamHandle = { headers: response.headers, state, close: () => controller.abort() };
    streams.push(handle);
    return handle;
  };

  const heartbeat = () => app.inject({
    method: "POST", url: "/api/v1/bridge/devices/pc-office-01/heartbeat", headers: device,
    payload: { state: "online", account_id: "wx-owner" },
  });
  const inbound = (eventId: string, content: string) => app.inject({
    method: "POST", url: "/api/v1/bridge/devices/pc-office-01/inbound", headers: device,
    payload: { event_id: eventId, contact_id: "S:wxid_test", nickname: "测试会话", content },
  });
  const customerId = () => (app.db.prepare("SELECT customer_id FROM agent_conversations WHERE device_code='pc-office-01'").get() as { customer_id: number }).customer_id;

  it("rejects a connection without a token and with an unverifiable token", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/v1/agent/stream?device_code=pc-office-01" });
    expect(missing.statusCode).toBe(401);
    const invalid = await app.inject({ method: "GET", url: "/api/v1/agent/stream?token=not-a-jwt&device_code=pc-office-01" });
    expect(invalid.statusCode).toBe(401);
  });

  it("sends one ready frame immediately and sets the no-buffering headers", async () => {
    const stream = await openStream(`token=${token}&device_code=pc-office-01`);
    await waitFor(() => stream.state.text.includes("event: ready"), () => `no ready frame: ${stream.state.text}`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("cache-control")).toContain("no-cache");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    expect(parseFrames(stream.state.text)[0]).toEqual({ type: "ready", data: { device_code: "pc-office-01" } });
  });

  it("pushes message.created with the conversation snapshot after an inbound message", async () => {
    await heartbeat();
    const stream = await openStream(`token=${token}&device_code=pc-office-01`);
    await waitFor(() => stream.state.text.includes("event: ready"), () => "no ready frame");

    expect((await inbound("stream-inbound-1", "你们还招人吗")).statusCode).toBe(200);
    await waitFor(() => parseFrames(stream.state.text).some((frame) => frame.type === "message.created"), () => `no message.created: ${stream.state.text}`);

    const frame = parseFrames(stream.state.text).find((item) => item.type === "message.created")!;
    expect(frame.data.message).toMatchObject({ direction: "inbound", content: "你们还招人吗", status: "received", role: "customer", source: "bridge" });
    expect(frame.data.message.id).toEqual(expect.any(Number));
    expect(frame.data.conversation).toMatchObject({ customer_id: customerId(), nickname: "测试会话", last_msg: "你们还招人吗", unread: 1 });
  });

  it("pushes command.updated for queued, claimed and succeeded receipts", async () => {
    await heartbeat();
    await inbound("stream-inbound-2", "在吗");
    const stream = await openStream(`token=${token}&device_code=pc-office-01`);
    await waitFor(() => stream.state.text.includes("event: ready"), () => "no ready frame");

    const send = await app.inject({
      method: "POST", url: `/api/v1/agent/conversations/${customerId()}/send`, headers: admin,
      payload: { device_code: "pc-office-01", content: "人工回复内容" },
    });
    expect(send.statusCode).toBe(202);
    const commandId = send.json().command_id as string;
    await waitFor(() => parseFrames(stream.state.text).some((frame) => frame.type === "command.updated" && frame.data.status === "queued"), () => `no queued event: ${stream.state.text}`);

    const claim = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/claim", headers: device });
    const claimed = claim.json().command;
    expect(claimed.id).toBe(commandId);

    const receipt = await app.inject({
      method: "POST", url: "/api/v1/bridge/devices/pc-office-01/receipts", headers: device,
      payload: { command_id: commandId, lease_token: claimed.lease_token, status: "succeeded", message_id: "kbd-1" },
    });
    expect(receipt.statusCode).toBe(200);

    await waitFor(() => parseFrames(stream.state.text).some((frame) => frame.type === "command.updated" && frame.data.status === "succeeded"), () => `no succeeded event: ${stream.state.text}`);
    const statuses = parseFrames(stream.state.text).filter((frame) => frame.type === "command.updated").map((frame) => frame.data.status);
    expect(statuses).toEqual(["queued", "claimed", "succeeded"]);
    const outbound = parseFrames(stream.state.text).find((frame) => frame.type === "message.created" && frame.data.message.direction === "outbound");
    expect(outbound?.data.message).toMatchObject({ content: "人工回复内容", role: "agent", source: "manual" });
  });

  it("pushes device.updated only when the online state changes", async () => {
    const stream = await openStream(`token=${token}&device_code=pc-office-01`);
    await waitFor(() => stream.state.text.includes("event: ready"), () => "no ready frame");

    await heartbeat();
    await heartbeat(); // second heartbeat is the same state: must stay silent
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/heartbeat", headers: device, payload: { state: "offline" } });
    await waitFor(() => parseFrames(stream.state.text).some((frame) => frame.type === "device.updated" && frame.data.online === false), () => `no offline event: ${stream.state.text}`);

    const states = parseFrames(stream.state.text).filter((frame) => frame.type === "device.updated").map((frame) => frame.data);
    expect(states).toEqual([
      { device_code: "pc-office-01", online: true, wecom_state: "online" },
      { device_code: "pc-office-01", online: false, wecom_state: "offline" },
    ]);
  });

  it("drops a connection from the bus when the client disconnects", async () => {
    const stream = await openStream(`token=${token}&device_code=pc-office-01`);
    await waitFor(() => stream.state.text.includes("event: ready"), () => "no ready frame");
    expect(app.events.size).toBe(1);

    stream.close();
    await waitFor(() => app.events.size === 0, () => `connection still registered: ${app.events.size}`);
  });
});

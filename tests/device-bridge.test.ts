import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { DeviceBridgeStore } from "../src/modules/messaging/device-bridge.js";

describe("independent device bridge", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const saved = { ...process.env };
  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    expect(pair.statusCode).toBe(200);
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });
  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const call = (suffix: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/v1/bridge/devices/local-device-001/${suffix}`, headers: device, payload });

  it("binds a logged-in account, maps an opaque contact id and delivers an AI reply only after a device receipt", async () => {
    await call("heartbeat", { state: "online", account_id: "wx-owner" });
    // Inbound processing waits for the independently polling device to send.
    const pending = call("inbound", { event_id: "wx-message-1", contact_id: "wxid_external_abc", nickname: "测试联系人", content: "想找广州的工作" }).then(r => r);
    const store = new DeviceBridgeStore(app.db);
    const deadline = Date.now() + 3000;
    let command: any;
    while (!command && Date.now() < deadline) {
      command = (await call("claim")).json().command;
      if (!command) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(command).toMatchObject({ contact_id: "wxid_external_abc", content: expect.stringContaining("Mock response") });
    expect((await call("receipts", { command_id: command.id, lease_token: command.lease_token, status: "succeeded", message_id: "real-wx-send-id" })).statusCode).toBe(200);
    expect((await pending).json()).toMatchObject({ reply_status: "sent" });
    const replay = await call("inbound", { event_id: "wx-message-1", contact_id: "wxid_external_abc", content: "想找广州的工作" });
    expect(replay.json()).toMatchObject({ status: "duplicate" });
    expect((await call("claim")).json().command).toBeNull();
    expect(app.db.prepare("SELECT provider_message_id FROM message_deliveries").get()).toMatchObject({ provider_message_id: "real-wx-send-id" });
    expect(store.status("local-device-001")).toMatchObject({ state: "online", account_id: "wx-owner" });
  });

  it("reconciles a late device receipt into the application message and failed delivery", async () => {
    const store = new DeviceBridgeStore(app.db);
    store.heartbeat("local-device-001", "online", "wx-owner");
    const customer = store.contact("local-device-001", "late-contact", "test");
    const eventId = "manual-reply:late";
    app.db.prepare("INSERT INTO message_events(event_id,event_type,direction,payload_hash) VALUES (?,'agent.manual_reply','outbound','hash')").run(eventId);
    app.db.prepare("INSERT INTO message_deliveries(event_id,device_code,customer_id,content,status) VALUES (?,?,?,?,'failed')").run(eventId,"local-device-001",customer,"hello");
    const command = store.enqueue({ deviceCode: "local-device-001", customerId: customer, content: "hello", idempotencyKey: eventId });
    const claim = store.claim("local-device-001")!;
    store.receipt("local-device-001",command.id,claim.lease_token,"succeeded","late-id");
    store.receipt("local-device-001",command.id,claim.lease_token,"succeeded","late-id");
    expect(app.db.prepare("SELECT status,provider_message_id FROM message_deliveries").get()).toMatchObject({ status: "succeeded", provider_message_id: "late-id" });
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE source_event_id=? AND status='sent'").get(eventId+":outbound")).toMatchObject({ n: 1 });
  });

  it("enforces per-device credentials and rejects switching the bound account", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/claim", headers: admin, payload: {} })).statusCode).toBe(401);
    await call("heartbeat", { state: "online", account_id: "wx-owner" });
    expect((await call("heartbeat", { state: "online", account_id: "another-account" })).statusCode).toBe(409);
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    expect(pair.statusCode).toBe(200);
    expect((await call("claim")).statusCode).toBe(401);
  });

  it("leaves an expired claim unknown instead of sending it twice, and accepts a late matching receipt", async () => {
    let now = Date.now();
    const store = new DeviceBridgeStore(app.db, () => now);
    store.heartbeat("local-device-001", "online", "wx-owner");
    const customer = store.contact("local-device-001", "opaque-id", "test");
    const id = store.enqueue({ deviceCode: "local-device-001", customerId: customer, content: "测试", idempotencyKey: "same-key" }).id;
    const claim = store.claim("local-device-001")!;
    now += 61_000;
    expect(store.claim("local-device-001")).toBeNull();
    expect(store.command(id)?.status).toBe("unknown");
    store.receipt("local-device-001", id, claim.lease_token, "succeeded", "late-wx-id");
    expect(store.command(id)).toMatchObject({ status: "succeeded", message_id: "late-wx-id" });
  });

  it("rejects unmapped contacts, invalid receipts, disabled devices and inbound event conflicts", async () => {
    await call("heartbeat", { state: "online", account_id: "wx-owner" });
    const store = new DeviceBridgeStore(app.db);
    expect(() => store.enqueue({ deviceCode: "local-device-001", customerId: 999999, content: "x", idempotencyKey: "bad" })).toThrow("Contact mapping required");
    const customer = store.contact("local-device-001", "opaque-id", "test");
    const command = store.enqueue({ deviceCode: "local-device-001", customerId: customer, content: "hi", idempotencyKey: "test" });
    const claim = store.claim("local-device-001")!;
    expect(() => store.receipt("local-device-001", command.id, "wrong-lease", "succeeded", "msg")).toThrow();
    expect(() => store.receipt("local-device-001", command.id, claim.lease_token, "succeeded", "")).toThrow();
    app.db.prepare("UPDATE agent_conversations SET takeover=1 WHERE device_code=? AND customer_id=?").run("local-device-001", customer);
    const payload = { event_id: "immutable-event", contact_id: "opaque-id", content: "first" };
    expect((await call("inbound", payload)).statusCode).toBe(200);
    expect((await call("inbound", { ...payload, content: "changed" })).statusCode).toBe(409);
    app.db.prepare("UPDATE agent_devices SET status='disabled' WHERE id=1").run();
    expect((await call("claim")).statusCode).toBe(403);
  });
});

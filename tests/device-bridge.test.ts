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

  it("binds a logged-in account, maps an opaque contact id and stores the inbound message for the agent chain", async () => {
    await call("heartbeat", { state: "online", account_id: "wx-owner" });
    // Dify 自动回复已下线（2026-11-17）：入站只落库（agent_messages + 会话摘要），
    // AI 回复由客户端 autopilot 经 /agent/chat 生成，不再产生 claim 队列。
    const first = await call("inbound", { event_id: "wx-message-1", contact_id: "wxid_external_abc", nickname: "测试联系人", content: "想找广州的工作" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "stored", customer_id: expect.any(Number) });
    const row = app.db.prepare("SELECT direction,content,status FROM agent_messages WHERE content='想找广州的工作'").get() as any;
    expect(row).toMatchObject({ direction: "inbound", content: "想找广州的工作", status: "received" });
    const convo = app.db.prepare("SELECT last_msg,unread FROM agent_conversations WHERE last_msg='想找广州的工作'").get() as any;
    expect(convo).toMatchObject({ last_msg: "想找广州的工作", unread: 1 });
    // 同一事件重放：消息幂等（不重复入库），响应仍是 stored
    const replay = await call("inbound", { event_id: "wx-message-1", contact_id: "wxid_external_abc", content: "想找广州的工作" });
    expect(replay.statusCode).toBe(200);
    expect((await call("claim")).json().command).toBeNull();
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

  it("enforces per-device credentials and follows the account the client reports", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/claim", headers: admin, payload: {} })).statusCode).toBe(401);
    await call("heartbeat", { state: "online", account_id: "wx-owner" });
    // 换号不再拒收：绑定跟随客户端，并留一条审计事件（2026-11-15 业务口径）
    expect((await call("heartbeat", { state: "online", account_id: "another-account" })).statusCode).toBe(200);
    const afterRebind = new DeviceBridgeStore(app.db, () => Date.now());
    expect(afterRebind.status("local-device-001")).toMatchObject({
      state: "online",
      account_id: "another-account",
    });
    expect(
      app.db
        .prepare("SELECT event_type,reason FROM device_events WHERE device_code=? AND event_type='account_rebound'")
        .get("local-device-001"),
    ).toMatchObject({ event_type: "account_rebound", reason: "wx-owner->another-account" });
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

  it("mirrors heartbeat state into agent_devices so the admin UI shows the device online", async () => {
    await call("heartbeat", { state: "online", account_id: "wx-owner" });
    const devices = await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: admin });
    const row = devices.json().items.find((item: { device_code: string }) => item.device_code === "local-device-001");
    expect(row).toMatchObject({ online: true, status: true });
    expect(row.last_online).not.toBe("");
    await call("heartbeat", { state: "offline" });
    const after = await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: admin });
    const offlineRow = after.json().items.find((item: { device_code: string }) => item.device_code === "local-device-001");
    expect(offlineRow).toMatchObject({ online: false });
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

it("keeps Win connected while pausing replies and expires stale runtime samples", async () => {
  const previous = process.env.REA_DATABASE_PATH;
  process.env.REA_DATABASE_PATH = ":memory:";
  const app = buildServer();
  await app.ready();
  try {
    let time = 100_000;
    const store = new DeviceBridgeStore(app.db, () => time);
    store.updateRuntimeHealth("runtime-only", {
      reason: "desktop_unavailable", wecom_available: true, reply_ready: false, sync: "catching_up", backlog: 250,
    });
    expect(store.runtimeHealth("runtime-only")).toEqual({
      connected: true, wecom_available: true, reply_ready: false, reason: "desktop_unavailable", sync: "catching_up", backlog: 250,
    });
    time += 60_001;
    expect(store.runtimeHealth("runtime-only")).toMatchObject({
      connected: false, reply_ready: false, reason: "heartbeat_timeout",
    });
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.REA_DATABASE_PATH;
    else process.env.REA_DATABASE_PATH = previous;
  }
});

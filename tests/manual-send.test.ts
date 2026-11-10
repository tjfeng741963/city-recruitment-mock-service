import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 控制台主动发消息：观察模式（observe_only）设备只抑制「服务端自动生成」的
// 回复指令，人工指令必须照常入队并下发，否则接管就没法用。
describe("manual send from the console", () => {
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
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?)")
      .run("观察设备", "enabled", JSON.stringify({ device_code: "pc-office-01", observe_only: true }));
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/heartbeat", headers: device, payload: { state: "online", account_id: "wx-owner" } });
    // 造一条入站，拿到会话与 contact 映射（observe_only 不会生成自动回复指令）
    await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-office-01/inbound",
      headers: device,
      payload: { event_id: "manual-send-seed", contact_id: "S:wxid_test", nickname: "我的客服", content: "在吗" },
    });
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const conversationId = () => (app.db.prepare("SELECT customer_id FROM agent_conversations WHERE device_code='pc-office-01'").get() as { customer_id: number }).customer_id;
  const send = (content: string, key?: string) => app.inject({
    method: "POST",
    url: `/api/v1/agent/conversations/${conversationId()}/send`,
    headers: { ...admin, ...(key ? { "idempotency-key": key } : {}) },
    payload: { device_code: "pc-office-01", content },
  });

  it("queues a manual command even for an observe_only device and returns command_id/status", async () => {
    // 入站没有生成任何自动回复指令（observe_only 仍然有效）
    expect(app.db.prepare("SELECT COUNT(*) n FROM bridge_commands").get()).toMatchObject({ n: 0 });

    const response = await send("你好，这边是人工客服", "manual-send-1");
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ command_id: expect.any(String), status: "queued", customer_id: conversationId() });

    const command = app.db.prepare("SELECT * FROM bridge_commands").get() as Record<string, unknown>;
    expect(command).toMatchObject({ device_code: "pc-office-01", status: "queued", content: "你好，这边是人工客服" });
    expect(app.db.prepare("SELECT direction,content,status FROM agent_messages WHERE device_code='pc-office-01' AND direction='outbound' ORDER BY id DESC LIMIT 1").get())
      .toMatchObject({ direction: "outbound", content: "你好，这边是人工客服", status: "queued" });
    expect(app.db.prepare("SELECT last_msg FROM agent_conversations WHERE device_code='pc-office-01'").get())
      .toMatchObject({ last_msg: "你好，这边是人工客服" });
  });

  it("claims with the conversation nickname and flips the message to sent on a succeeded receipt", async () => {
    await send("明天面试可以吗", "manual-send-2");

    const claim = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/claim", headers: device });
    const command = claim.json().command;
    expect(command).toMatchObject({ content: "明天面试可以吗", nickname: "我的客服", status: "claimed" });

    const receipt = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-office-01/receipts",
      headers: device,
      payload: { command_id: command.id, lease_token: command.lease_token, status: "succeeded", message_id: "keyboard-1" },
    });
    expect(receipt.statusCode).toBe(200);
    expect(app.db.prepare("SELECT status,message_id FROM bridge_commands WHERE id=?").get(command.id))
      .toMatchObject({ status: "succeeded", message_id: "keyboard-1" });
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE device_code='pc-office-01' AND direction='outbound' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ status: "sent" });
    expect(app.db.prepare("SELECT status,provider_message_id FROM message_deliveries").get())
      .toMatchObject({ status: "succeeded", provider_message_id: "keyboard-1" });
  });

  it("holds uncertain sends without requeueing and accepts a late successful receipt", async () => {
    await send("Outcome uncertain", "uncertain-command");
    const command = (await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/claim", headers: device })).json().command;
    const receipt = (status: string, messageId = "") => app.inject({
      method: "POST", url: "/api/v1/bridge/devices/pc-office-01/receipts", headers: device,
      payload: { command_id: command.id, lease_token: command.lease_token, status, message_id: messageId },
    });
    expect((await receipt("unknown")).statusCode).toBe(200);
    expect((await receipt("unknown")).statusCode).toBe(200);
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE device_code='pc-office-01' AND direction='outbound'").get()).toMatchObject({ status: "unknown" });
    expect(app.db.prepare("SELECT status,next_retry_at FROM message_deliveries").get()).toMatchObject({ status: "sending", next_retry_at: null });
    expect((await send("Outcome uncertain", "uncertain-command")).json().status).toBe("unknown");
    expect((await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/claim", headers: device })).json().command).toBeNull();
    expect((await receipt("succeeded", "S:wxid_test:102")).statusCode).toBe(200);
    expect((await receipt("succeeded", "S:wxid_test:102")).statusCode).toBe(200);
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE device_code='pc-office-01' AND direction='outbound'").get()).toMatchObject({ status: "sent" });
    expect(app.db.prepare("SELECT status FROM message_deliveries").get()).toMatchObject({ status: "succeeded" });
    expect((await receipt("unknown")).statusCode).toBe(409);
  });

  it("reports a failed device send back onto the message instead of leaving it queued", async () => {
    await send("这条会失败", "manual-send-3");
    const command = (await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/claim", headers: device })).json().command;
    await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-office-01/receipts",
      headers: device,
      payload: { command_id: command.id, lease_token: command.lease_token, status: "failed" },
    });

    expect(app.db.prepare("SELECT status FROM bridge_commands WHERE id=?").get(command.id)).toMatchObject({ status: "failed" });
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE device_code='pc-office-01' AND direction='outbound' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ status: "failed" });
    expect(app.db.prepare("SELECT status,last_error FROM message_deliveries WHERE customer_id=?").get(conversationId()))
      .toMatchObject({ status: "failed", last_error: "Device reported delivery failure" });
  });

  it("keeps Idempotency-Key replay stable and rejects reuse with different content", async () => {
    const first = await send("同一条", "manual-send-key");
    const replay = await send("同一条", "manual-send-key");
    const conflict = await send("换了内容", "manual-send-key");

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().command_id).toBe(first.json().command_id);
    expect(app.db.prepare("SELECT COUNT(*) n FROM bridge_commands").get()).toMatchObject({ n: 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ detail: "Idempotency key was already used with different content" });
  });

  it("serves the compiled conversation page: manual-reply enqueues and returns immediately", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/manual-reply",
      headers: { ...admin, "idempotency-key": "vue-manual-1" },
      payload: { device_code: "pc-office-01", customer_id: conversationId(), content: "界面发的消息" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ direction: "outbound", content: "界面发的消息", status: "queued", command_status: "queued" });

    const messages = await app.inject({ method: "GET", url: `/api/v1/agent/messages?device_code=pc-office-01&customer_id=${conversationId()}&after_id=0`, headers: admin });
    expect(messages.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "outbound", content: "界面发的消息", role: "agent" }),
      expect.objectContaining({ direction: "inbound", content: "在吗", role: "customer" }),
    ]));
  });

  it("rejects empty content and a conversation that does not belong to the device", async () => {
    expect((await send("   ", "manual-empty")).statusCode).toBe(422);
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/agent/conversations/${conversationId()}/send`,
      headers: admin,
      payload: { device_code: "other-device", content: "x" },
    });
    expect(missing.statusCode).toBe(404); // 管理员可见全部设备，但没有该设备下的这条会话
  });
});

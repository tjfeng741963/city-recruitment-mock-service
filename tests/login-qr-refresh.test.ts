import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 登录二维码刷新指令（2026-11-23）。
 *
 * 背景：网页「刷新」以前只重读缓存帧，客户端 30 秒才推一次，看起来没反应。
 * 这里验证新链路：
 *   管理员 POST refresh → 入队 kind=refresh_login_qr
 *   登录态（scanning/offline）下设备仍能领到它（消息指令则领不到）
 *   回执成功不要求 message_id，也不产生任何客户消息
 */
describe("login qr refresh command", () => {
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
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/local-device-001/pair",
      headers: admin,
    });
    expect(pair.statusCode).toBe(200);
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const refresh = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/agent/devices/local-device-001/login-qr/refresh",
      headers: admin,
    });
  const bridge = (suffix: string, payload: object = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v1/bridge/devices/local-device-001/${suffix}`,
      headers: device,
      payload,
    });
  const claim = (only?: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/bridge/devices/local-device-001/claim${only ? `?only=${only}` : ""}`,
      headers: device,
      payload: {},
    });

  it("queues once per minute and lets a logged-out device pick it up", async () => {
    const countOf = (table: string) =>
      (app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const messagesBefore = countOf("agent_messages");
    const deliveriesBefore = countOf("message_deliveries");

    await bridge("heartbeat", { state: "scanning", account_id: "" });

    const first = await refresh();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ queued: true, deduped: false });
    const commandId = first.json().command_id as string;

    // 同一分钟再点：幂等，不重复入队
    const second = await refresh();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ queued: true, deduped: true, command_id: commandId });

    // 登录态下普通 claim 不碰队列（否则会白占消息指令的 60 秒租约）
    expect((await claim()).json()).toMatchObject({ command: null });

    // 只领刷新指令：能领到，且 kind 正确
    const picked = await claim("refresh_login_qr");
    const command = picked.json().command;
    expect(command).toMatchObject({ id: commandId, kind: "refresh_login_qr" });

    // 回执成功不要求 message_id（刷新不产生客户消息）
    const receipt = await bridge("receipts", {
      command_id: command.id,
      lease_token: command.lease_token,
      status: "succeeded",
      message_id: "",
    });
    expect(receipt.statusCode).toBe(200);

    // 不落任何客户消息，也不产生投递记录
    expect(countOf("agent_messages")).toBe(messagesBefore);
    expect(countOf("message_deliveries")).toBe(deliveriesBefore);

    const row = app.db
      .prepare("SELECT status,kind FROM bridge_commands WHERE id=?")
      .get(commandId) as { status: string; kind: string };
    expect(row).toMatchObject({ status: "succeeded", kind: "refresh_login_qr" });
  });

  it("surfaces the client failure reason on the qr endpoint", async () => {
    await bridge("heartbeat", { state: "scanning", account_id: "" });
    const queued = await refresh();
    expect(queued.json().command_id).toBeTruthy();
    const picked = await claim("refresh_login_qr");
    const command = picked.json().command;

    const failed = await bridge("receipts", {
      command_id: command.id,
      lease_token: command.lease_token,
      status: "failed",
      message_id: "",
      error: "没找到企微登录窗（可能已登录，或窗口被隐藏）",
    });
    expect(failed.statusCode).toBe(200);

    // 网页轮询 /login-qr 时能读到失败原因，而不是只能靠「图没变」猜
    const qr = await app.inject({
      method: "GET",
      url: "/api/v1/agent/devices/local-device-001/login-qr",
      headers: admin,
    });
    expect(qr.statusCode).toBe(200);
    expect(qr.json().last_refresh).toMatchObject({
      status: "failed",
      error: "没找到企微登录窗（可能已登录，或窗口被隐藏）",
    });
  });

  it("rejects the request when the client heartbeat is stale", async () => {
    // 没有任何心跳：不能假装指令发得出去
    const response = await refresh();
    expect(response.statusCode).toBe(409);
    expect(String(response.json().detail)).toContain("心跳");
  });

  it("does not touch the message queue when claiming refresh only", async () => {
    await bridge("heartbeat", { state: "online", account_id: "wx-owner" });
    // 造一条待发消息指令（需要联系人映射：先入站一次）
    await bridge("inbound", {
      event_id: "wx-message-1",
      contact_id: "wxid_external_abc",
      nickname: "测试联系人",
      content: "想找广州的工作",
    });
    const customerId = (app.db.prepare("SELECT customer_id FROM agent_conversations LIMIT 1").get() as { customer_id: number }).customer_id;
    app.db
      .prepare(
        `INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,kind,created_at)
         VALUES ('msg-1','local-device-001',?,?,'你好','test:msg-1','message',?)`,
      )
      .run(customerId, "wxid_external_abc", Date.now());

    // 只领刷新指令时，消息指令必须原样留在队列里
    const picked = await claim("refresh_login_qr");
    expect(picked.json().command).toBeNull();
    const queued = app.db
      .prepare("SELECT status FROM bridge_commands WHERE id='msg-1'")
      .get() as { status: string };
    expect(queued.status).toBe("queued");
  });
});

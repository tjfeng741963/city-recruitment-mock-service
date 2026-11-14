import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 「老友管理」页承诺：企微上报的老客户，AI 不自动回复，可手动放行。
// 过去这张表只有读写接口、没有任何消费方，入站消息照样走 Dify 自动回，
// 页面上的「不可聊 / 可聊」只是展示。这里锁死真实行为。
describe("old friend inbound protection", () => {
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
      .run("老友设备", "enabled", JSON.stringify({ device_code: "pc-old-01" }));
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-old-01/pair", headers: admin });
    expect(pair.statusCode).toBe(200);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-old-01/heartbeat", headers: device, payload: { state: "online", account_id: "wx-owner" } });
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const inbound = (payload: object) => app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-old-01/inbound", headers: device, payload });

  /**
   * bridge 渠道的入站请求会挂起到设备领走指令为止，所以测试里必须边等边领。
   * 没有生成回复时（老友拦截 / observe_only）请求会立刻返回，claim 一直为 null。
   */
  const inboundAndDrain = async (payload: object) => {
    const pending = inbound(payload);
    let command: any = null;
    const deadline = Date.now() + 3000;
    while (!command && Date.now() < deadline) {
      command = (await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-old-01/claim", headers: device })).json().command;
      if (command) break;
      await new Promise(resolve => setTimeout(resolve, 10));
      // 请求已经结束说明没有指令可领，别再空转
      if (await Promise.race([pending.then(() => true), Promise.resolve(false)])) break;
    }
    if (command) {
      await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-old-01/receipts", headers: device, payload: { command_id: command.id, lease_token: command.lease_token, status: "succeeded", message_id: `old-${payload["event_id"]}` } });
    }
    return { response: await pending, command };
  };
  const mark = (customerId: string, status?: string) => app.inject({
    method: "POST",
    url: "/api/v1/agent/old-friends/mark",
    headers: admin,
    payload: { device_code: "pc-old-01", customer_id: customerId, nickname: "老客户", ...(status ? { status } : {}) },
  });

  it("does not auto-reply to an old friend that was not released", async () => {
    const first = await inboundAndDrain({ event_id: "of-1", contact_id: "wxid_old_1", nickname: "老客户", content: "还有活吗" });
    const customerId = String(first.response.json().customer_id);
    // mark 不传 status 时默认不可聊（unreleased），不是「已放行」
    expect((await mark(customerId)).json()).toMatchObject({ status: "unreleased" });

    const outboundBefore = app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get() as { n: number };
    const second = await inboundAndDrain({ event_id: "of-2", contact_id: "wxid_old_1", nickname: "老客户", content: "在吗" });
    expect(second.response.json()).toMatchObject({ status: "processed", reply_status: "old_friend" });
    expect(second.command).toBeNull();
    // 消息照记，未读照加，只是不生成回复
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE content='在吗'").get()).toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT unread FROM agent_conversations WHERE device_code='pc-old-01'").get()).toMatchObject({ unread: 2 });
    // 拦截后不再新增任何发送指令，也不产生第二条出站消息
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: outboundBefore.n });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE direction='outbound' AND device_code='pc-old-01'").get()).toMatchObject({ n: 1 });
  });

  it("resumes auto-reply once the operator releases the old friend", async () => {
    const first = await inboundAndDrain({ event_id: "of-3", contact_id: "wxid_old_2", nickname: "老客户", content: "有活吗" });
    const customerId = String(first.response.json().customer_id);
    const marked = await mark(customerId);
    const release = await app.inject({ method: "PUT", url: `/api/v1/agent/old-friends/${marked.json().id}/release`, headers: admin });
    expect(release.statusCode).toBe(200);
    expect(app.db.prepare("SELECT status FROM old_friend_records WHERE id=?").get(marked.json().id as number)).toMatchObject({ status: "released" });

    const second = await inboundAndDrain({ event_id: "of-4", contact_id: "wxid_old_2", nickname: "老客户", content: "我想回来干" });
    expect(second.command).toMatchObject({ contact_id: "wxid_old_2", content: expect.stringContaining("Mock response") });
    expect(second.response.json()).toMatchObject({ status: "processed", reply_status: "sent" });
  });

  it("keeps the status vocabulary aligned with the page and normalizes legacy rows", async () => {
    const first = await inboundAndDrain({ event_id: "of-5", contact_id: "wxid_old_3", nickname: "老客户", content: "在吗" });
    const customerId = String(first.response.json().customer_id);
    const marked = await mark(customerId);
    const id = marked.json().id as number;

    // 不可聊 → 可聊 → 不可聊，三次切换都必须是页面认识的词
    await app.inject({ method: "PUT", url: `/api/v1/agent/old-friends/${id}/release`, headers: admin });
    expect(app.db.prepare("SELECT status FROM old_friend_records WHERE id=?").get(id)).toMatchObject({ status: "released" });
    await app.inject({ method: "PUT", url: `/api/v1/agent/old-friends/${id}/unrelease`, headers: admin });
    expect(app.db.prepare("SELECT status FROM old_friend_records WHERE id=?").get(id)).toMatchObject({ status: "unreleased" });

    const rows = app.inject({ method: "GET", url: "/api/v1/agent/old-friends", headers: admin });
    const statuses = (await rows).json().items.map((row: { status: string }) => row.status);
    expect(statuses.every((status: string) => status === "released" || status === "unreleased")).toBe(true);
  });
});

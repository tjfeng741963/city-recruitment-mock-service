import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// observe_only 设备（客户端用本地知识库回复，服务端只做会话展示）：
// inbound 必须照常记录会话与消息，但绝不生成回复指令（bridge_commands），
// 否则两套引擎都回客户，属于生产事故。
describe("observe_only device inbound", () => {
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
    expect(pair.statusCode).toBe(200);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/heartbeat", headers: device, payload: { state: "online", account_id: "wx-owner" } });
  });
  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const inbound = (payload: object) => app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/inbound", headers: device, payload });

  it("records the conversation and message but enqueues no reply command", async () => {
    const payload = { event_id: "obs-1", contact_id: "wxid_c1", nickname: "客户甲", content: "想找普工" };
    const response = await inbound(payload);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "processed", event_id: expect.stringContaining("bridge-inbound:"), reply_status: "observe_only", customer_id: expect.any(Number) });
    expect(app.db.prepare("SELECT direction,content FROM agent_messages WHERE content='想找普工'").get())
      .toMatchObject({ direction: "inbound", content: "想找普工" });
    expect(app.db.prepare("SELECT last_msg,unread FROM agent_conversations WHERE device_code='pc-office-01'").get())
      .toMatchObject({ last_msg: "想找普工", unread: 1 });
    // 防重复回复的关键断言：指令与投递一条都不生成
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM message_deliveries").get()).toMatchObject({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE direction='outbound' AND device_code='pc-office-01'").get()).toMatchObject({ n: 0 });
    expect((await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-office-01/claim", headers: device })).json().command).toBeNull();
  });

  it("stays idempotent when the same inbound event is replayed", async () => {
    const payload = { event_id: "obs-2", contact_id: "wxid_c2", nickname: "客户乙", content: "工资多少" };
    await inbound(payload);
    const replay = await inbound(payload);

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: "processed", reply_status: "observe_only" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE content='工资多少'").get()).toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT unread FROM agent_conversations WHERE device_code='pc-office-01'").get()).toMatchObject({ unread: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: 0 });
  });

  it("does not suppress reply generation for devices without the flag", async () => {
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    const normal = { authorization: `Bearer ${pair.json().device_token}` };
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/heartbeat", headers: normal, payload: { state: "online", account_id: "wx-owner" } });
    // 普通设备（无 observe_only）：bridge 渠道会等设备领走指令，这里并发模拟领走
    const pending = app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/inbound", headers: normal, payload: { event_id: "obs-3", contact_id: "wxid_c3", content: "普通设备照常自动回复" } });
    let command: any;
    const deadline = Date.now() + 3000;
    while (!command && Date.now() < deadline) {
      command = (await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/claim", headers: normal })).json().command;
      if (!command) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(command).toMatchObject({ contact_id: "wxid_c3", content: expect.stringContaining("Mock response") });
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/receipts", headers: normal, payload: { command_id: command.id, lease_token: command.lease_token, status: "succeeded", message_id: "normal-send-1" } });
    expect((await pending).json()).toMatchObject({ status: "processed", reply_status: "sent" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands WHERE device_code='local-device-001'").get()).toMatchObject({ n: 1 });
  });
});

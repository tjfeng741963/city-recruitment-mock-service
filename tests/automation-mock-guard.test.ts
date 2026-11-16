import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 单引擎整合回归（2026-11-16）：Dify 用不上（REA_DIFY_PROVIDER 未配置 = mock）。
// mock 的"回复"是本地占位文案，绝不能发给真实客户。自动化引擎在 mock 模式下
// 必须只记录不生成——即使设备显式 observe_only=false 也不再入队任何回复。
describe("automation stays observe-only when no real Dify engine is configured", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const saved = { ...process.env };

  beforeEach(async () => {
    delete process.env.REA_DIFY_PROVIDER; // 未配置 = mock
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_REGISTER_KEY = "unit-test-register-key-0123456789";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    // 显式关掉 observe_only：过去这正是双引擎事故的入口
    const dev = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "pc-auto-01", device_name: "未配 Dify 的设备", observe_only: false },
    });
    expect(dev.statusCode).toBe(200);
    const pair = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-auto-01/pair",
      headers: admin,
    });
    expect(pair.statusCode).toBe(200);
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER", "REA_REGISTER_KEY"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it("inbound records the message but never enqueues a reply command", async () => {
    // 入站通道要求设备在线：先心跳再上报
    const beat = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-auto-01/heartbeat",
      headers: device,
      payload: { state: "online", account_id: "wx-owner" },
    });
    expect(beat.statusCode).toBe(200);
    const inbound = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-auto-01/inbound",
      headers: device,
      payload: { event_id: "evt-1", contact_id: "wxid_a", nickname: "客户A", content: "想找广州的工作" },
    });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json().reply_status).toBe("observe_only");
    // 没有生成任何待发送指令
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/devices/pc-auto-01/claim",
      headers: device,
    });
    expect(claim.json().command).toBeFalsy();
    // 入站消息本身照常落库（控制台可见）
    const msgs = app.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_messages WHERE device_code='pc-auto-01' AND direction='inbound'",
    ).get() as { n: number };
    expect(msgs.n).toBe(1);
    // 也没有生成失败的投递记录
    const deliveries = app.db.prepare(
      "SELECT COUNT(*) AS n FROM message_deliveries",
    ).get() as { n: number };
    expect(deliveries.n).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("local agent conversation flow", () => {
  let app: FastifyInstance;
  let customerToken = "";

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    customerToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => { await app.close(); });

  const headers = () => ({ authorization: `Bearer ${customerToken}` });

  it("seeds a stable device code and a conversation with matching messages", async () => {
    const devices = await app.inject({ method: "GET", url: "/api/v1/agent/devices?my=true", headers: headers() });
    expect(devices.statusCode).toBe(200);
    expect(devices.json().items).toEqual([expect.objectContaining({ device_code: "local-device-001", online: false })]);

    const conversations = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers: headers() });
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json()).toMatchObject({ items: [expect.objectContaining({ customer_id: 700001, nickname: "示例客户A" })] });

    const messages = await app.inject({ method: "GET", url: "/api/v1/agent/messages?device_code=local-device-001&customer_id=700001&after_id=0", headers: headers() });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "inbound", content: "想了解一下长白班岗位" }),
      expect.objectContaining({ direction: "outbound", content: "可以的，我先给你发几个示例岗位。" }),
    ]));
  });

  // 红点灭而复现的回归：点开会话必须落库该会话已读，否则 15s 轮询
  // listConversations 会把库里的原值读回来，运营以为自己点过了却又有红点。
  it("marks the conversation read when its messages are opened", async () => {
    // 自造未读：同文件前面的用例已经打开过这个消息，不能依赖种子初值
    app.db.prepare("UPDATE agent_conversations SET unread=3 WHERE device_code='local-device-001' AND customer_id=700001").run();
    const before = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers: headers() });
    expect(before.json().total_unread).toBe(3);

    const opened = await app.inject({ method: "GET", url: "/api/v1/agent/messages?device_code=local-device-001&customer_id=700001&after_id=0", headers: headers() });
    expect(opened.statusCode).toBe(200);

    // 落库，不是只在前端减数字：重新查会话列表必须读到 0
    expect(app.db.prepare("SELECT unread FROM agent_conversations WHERE device_code='local-device-001' AND customer_id=700001").get())
      .toMatchObject({ unread: 0 });
    const after = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers: headers() });
    expect(after.json().total_unread).toBe(0);
  });

  it("keeps the required device contract for a missing device code", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=", headers: headers() });
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toEqual(expect.arrayContaining([expect.objectContaining({ loc: ["query", "device_code"] })]));
  });

  it("keeps device restart callable without a bearer token", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/v1/agent/conversations/700001/restart?device_code=local-device-001" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });
});

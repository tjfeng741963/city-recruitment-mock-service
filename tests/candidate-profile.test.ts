import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { isProfileTokenValid } from "../src/modules/agent/profile.routes.js";

/**
 * 候选人档案（Task #47）：POST/GET /api/v1/agent/profile 的部分更新、幂等、
 * 外部会话定位、候选人事件落库与 X-Profile-Token 鉴权。
 */
describe("candidate profile api", () => {
  let app: FastifyInstance;
  let token = "";
  const headers = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "svc-profile-token";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => {
    delete process.env.REA_PROFILE_TOKEN;
    await app.close();
  });

  const profileOf = async (query: string, extra: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api/v1/agent/profile?${query}`, headers: { ...headers(), ...extra } });

  it("writes a profile once and keeps unlisted keys on partial updates", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/agent/profile",
      headers: headers(),
      payload: { device_code: "local-device-001", customer_id: "700001", profile: { name: "张三", phone: "13800000000", age: 32, stage: "asking" } },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, customer_id: "700001" });

    const created = await profileOf("device_code=local-device-001&customer_id=700001");
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "张三", phone: "13800000000", profile: { name: "张三", phone: "13800000000", age: 32, stage: "asking" } });

    // 只带 city/district 的第二次推送不能把姓名电话抹掉（部分更新）。
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/agent/profile",
      headers: headers(),
      payload: { device_code: "local-device-001", customer_id: "700001", profile: { city: "广州", district: "番禺" } },
    });
    expect(second.statusCode).toBe(200);
    const merged = await profileOf("device_code=local-device-001&customer_id=700001");
    expect(merged.json()).toMatchObject({ name: "张三", phone: "13800000000", city: "广州", district: "番禺" });
    expect(merged.json().profile).toMatchObject({ name: "张三", age: 32, city: "广州" });

    // 同 payload 再推一次：幂等（值不变、不新增会话）。
    await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: headers(), payload: { device_code: "local-device-001", customer_id: "700001", profile: { city: "广州", district: "番禺" } } });
    const again = await profileOf("device_code=local-device-001&customer_id=700001");
    expect(again.json()).toMatchObject({ name: "张三", phone: "13800000000", city: "广州", district: "番禺" });
    const conversations = app.db.prepare("SELECT COUNT(*) count FROM agent_conversations WHERE device_code=? AND customer_id=?").get("local-device-001", 700001) as { count: number };
    expect(conversations.count).toBe(1);
  });

  it("locates the conversation by external_conversation_id when customer_id is absent", async () => {
    app.db.prepare("UPDATE agent_conversations SET external_conversation_id=? WHERE device_code=? AND customer_id=?").run("wx-ext-700001", "local-device-001", 700001);

    const response = await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: headers(), payload: { device_code: "local-device-001", external_conversation_id: "wx-ext-700001", profile: { factory_name: "利口福食品厂" } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, customer_id: "700001" });

    const read = await profileOf("device_code=local-device-001&external_conversation_id=wx-ext-700001");
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ customer_id: "700001", factory_name: "利口福食品厂" });
  });

  it("marks the conversation invited and records one candidate event when an interview date arrives", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/profile",
      headers: headers(),
      payload: {
        device_code: "local-device-001",
        customer_id: "700001",
        profile: { name: "李四", phone: "13900000000", job_title: "利口福食品厂 普工", factory_name: "利口福食品厂", province: "广东省", city: "广州", district: "番禺", interview_date: "2026-12-01", interview_time: "09:00-11:00", stage: "booked" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, customer_id: "700001", recruit_status: "invited" });

    // 会话列表用的是 SELECT *，新列自动带出，不需要改查询。
    const conversations = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers: headers() });
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: 700001, name: "李四", phone: "13900000000", factory_name: "利口福食品厂", province: "广东省", interview_date: "2026-12-01", interview_time: "09:00-11:00", recruit_status: "invited", state: "pending_invite" }),
    ]));

    const candidates = await app.inject({ method: "GET", url: "/api/v1/agent/candidates?event_type=invited", headers: headers() });
    const invited = candidates.json().items.filter((item: Record<string, unknown>) => String(item.customer_id) === "700001" && item.event_type === "invited");
    expect(invited).toHaveLength(1);
    expect(invited[0]).toMatchObject({ name: "李四", phone: "13900000000", interview_date: "2026-12-01", interview_time: "09:00-11:00", factory_name: "利口福食品厂", province: "广东省", city: "广州", district: "番禺", status: "invited" });

    // 017：省字段要能读回来，前端拼「广东省广州市/番禺」
    const provinceRead = await profileOf("device_code=local-device-001&customer_id=700001");
    expect(provinceRead.json()).toMatchObject({ province: "广东省", city: "广州", district: "番禺" });

    // 再推一次同样的档案：事件只更新，不新增。
    await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: headers(), payload: { device_code: "local-device-001", customer_id: "700001", profile: { interview_date: "2026-12-01" } } });
    const after = await app.inject({ method: "GET", url: "/api/v1/agent/candidates?event_type=invited", headers: headers() });
    expect(after.json().items.filter((item: Record<string, unknown>) => String(item.customer_id) === "700001" && item.event_type === "invited")).toHaveLength(1);
  });

  it("marks the conversation disqualified when the candidate gave up", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: headers(), payload: { device_code: "local-device-001", customer_id: "700001", profile: { stage: "gave_up" } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, recruit_status: "disqualified" });

    const candidates = await app.inject({ method: "GET", url: "/api/v1/agent/candidates?event_type=disqualified", headers: headers() });
    expect(candidates.json().items.filter((item: Record<string, unknown>) => String(item.customer_id) === "700001")).toHaveLength(1);
  });

  it("answers 404 instead of creating a conversation for an unknown candidate", async () => {
    const before = (app.db.prepare("SELECT COUNT(*) count FROM agent_conversations").get() as { count: number }).count;
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: headers(), payload: { device_code: "local-device-001", customer_id: "999999", profile: { name: "不存在" } } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "conversation not found" });
    expect((app.db.prepare("SELECT COUNT(*) count FROM agent_conversations").get() as { count: number }).count).toBe(before);
  });

  it("accepts the service token in X-Profile-Token and rejects a wrong or missing one", async () => {
    const payload = { device_code: "local-device-001", customer_id: "700001", profile: { remark: "服务间写入" } };

    const anonymous = await app.inject({ method: "POST", url: "/api/v1/agent/profile", payload });
    expect(anonymous.statusCode).toBe(403);

    const wrong = await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: { "x-profile-token": "svc-profile-token-wrong" }, payload });
    expect(wrong.statusCode).toBe(403);

    const right = await app.inject({ method: "POST", url: "/api/v1/agent/profile", headers: { "x-profile-token": "svc-profile-token" }, payload });
    expect(right.statusCode).toBe(200);

    const read = await app.inject({ method: "GET", url: "/api/v1/agent/profile?device_code=local-device-001&customer_id=700001", headers: { "x-profile-token": "svc-profile-token" } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ remark: "服务间写入" });

    // 未配置 REA_PROFILE_TOKEN 时这条通道整体关闭；长度不等不做逐字节比较。
    expect(isProfileTokenValid("anything", "")).toBe(false);
    expect(isProfileTokenValid("short", "much-longer-token")).toBe(false);
    expect(isProfileTokenValid("abc", "abc")).toBe(true);
  });
});

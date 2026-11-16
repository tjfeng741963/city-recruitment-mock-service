import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { buildInviteLine, cityAbbrOf, isAllowedWebhookUrl, monthDayOf } from "../src/shared/invite-group.js";

/**
 * R1：名单自动发内部邀约群（录屏 02:10 实证）。
 *
 * 客户原话：「求职者给你发了这些什么名单之类的，OK 我们就自动去录名单，
 * 然后按照这个格式去发就行了」。
 * 格式：`深11/9 谢子鑫 18077352958`
 */
describe("invite group line format", () => {
  it("formats city abbreviation + month/day + name + phone", () => {
    expect(buildInviteLine({
      city: "深圳", interviewDate: "2026-11-09", name: "谢子鑫", phone: "18077352958",
      cityAbbr: { 深圳: "深", 东莞: "万" },
    })).toBe("深11/9 谢子鑫 18077352958");
  });

  it("falls back to the first character of the city when no mapping exists", () => {
    expect(cityAbbrOf("佛山", {})).toBe("佛");
    expect(cityAbbrOf("深圳市", {})).toBe("深");
    expect(cityAbbrOf("东莞", { 东莞: "万" })).toBe("万");
  });

  it("normalizes dates and rejects incomplete lines instead of sending half a row", () => {
    expect(monthDayOf("2026-11-09")).toBe("11/9");
    expect(monthDayOf("2026-1-5")).toBe("1/5");
    expect(monthDayOf("明天")).toBe("");
    const base = { city: "深圳", interviewDate: "2026-11-09", cityAbbr: { 深圳: "深" } };
    expect(buildInviteLine({ ...base, name: "谢子鑫", phone: "1807735295" })).toBe("");
    expect(buildInviteLine({ ...base, name: "", phone: "18077352958" })).toBe("");
    expect(buildInviteLine({ ...base, name: "谢子鑫", phone: "18077352958", interviewDate: "" })).toBe("");
  });
});

describe("invite group send on candidate registration", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    process.env.REA_PROFILE_TOKEN = "svc-token";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    // 种子已经占了 id=1（local-device-001），这里复用同一行改设备码
    app.db.prepare("UPDATE agent_devices SET device_name='邀约设备', status='enabled', data_json=? WHERE id=1")
      .run(JSON.stringify({ device_code: "pc-invite-01" }));
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-invite-01/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-invite-01/heartbeat", headers: device, payload: { state: "online", account_id: "wx-owner" } });
    app.db.prepare("INSERT INTO bridge_contacts(device_code,contact_id,customer_id,nickname) VALUES (?,?,?,?)").run("pc-invite-01", "S:wxid_a", 888001, "谢子鑫");
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname) VALUES (?,?,?)").run("pc-invite-01", 888001, "谢子鑫");
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER", "REA_PROFILE_TOKEN"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const configure = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/v1/agent/invite-group", headers: admin, payload });
  const pushProfile = (profile: Record<string, unknown>, customerId = "888001") => app.inject({
    method: "POST",
    url: "/api/v1/agent/profile",
    headers: { "x-profile-token": "svc-token" },
    payload: { device_code: "pc-invite-01", customer_id: customerId, profile },
  });

  it("sends the registered candidate to the configured group", async () => {
    await configure({ enabled: true, group_name: "内部邀约群", device_code: "pc-invite-01", city_abbr: { 深圳: "深" } });
    const pushed = await pushProfile({
      stage: "booked", interview_agreed: true, name: "谢子鑫", phone: "18077352958",
      interview_date: "2026-11-09", interview_time: "09:00", city: "深圳", factory_name: "深圳地铁安检",
    });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json()).toMatchObject({ recruit_status: "invited", invite_group: "sent" });

    const command = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-invite-01/claim", headers: device });
    expect(command.json().command).toMatchObject({ contact_id: "R:内部邀约群", nickname: "内部邀约群", content: "深11/9 谢子鑫 18077352958" });

    const sends = await app.inject({ method: "GET", url: "/api/v1/agent/invite-group/sends", headers: admin });
    expect(sends.json().items[0]).toMatchObject({ group_name: "内部邀约群", content: "深11/9 谢子鑫 18077352958", status: "sent" });
  });

  it("does not send twice for the same candidate and interview date", async () => {
    await configure({ enabled: true, group_name: "内部邀约群", device_code: "pc-invite-01", city_abbr: { 深圳: "深" } });
    const profile = {
      stage: "booked", interview_agreed: true, name: "谢子鑫", phone: "18077352958",
      interview_date: "2026-11-09", city: "深圳", factory_name: "深圳地铁安检",
    };
    await pushProfile(profile);
    await pushProfile(profile);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM invite_group_sends").get()).toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands WHERE contact_id='R:内部邀约群'").get()).toMatchObject({ n: 1 });
  });

  it("records a skip instead of sending when the group is not configured", async () => {
    const pushed = await pushProfile({
      stage: "booked", interview_agreed: true, name: "谢子鑫", phone: "18077352958",
      interview_date: "2026-11-09", city: "深圳", factory_name: "深圳地铁安检",
    });
    expect(pushed.json()).toMatchObject({ invite_group: "skipped" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: 0 });
    // 默认是「开启」的（2026-11-15 修正：配好群却忘了点开关不再静默失败）。
    // 没配群名也没配 Webhook 时落到「未配置邀约群」，仍然不发。
    expect(app.db.prepare("SELECT status,error FROM invite_group_sends").get()).toMatchObject({ status: "skipped", error: "未配置邀约群（群名或 Webhook 地址）" });
  });

  it("does not send when the operator explicitly disables the group", async () => {
    await configure({ enabled: false, group_name: "内部邀约群", device_code: "pc-invite-01", city_abbr: { 深圳: "深" } });
    const pushed = await pushProfile({
      stage: "booked", interview_agreed: true, name: "谢子鑫", phone: "18077352958",
      interview_date: "2026-11-09", city: "深圳", factory_name: "深圳地铁安检",
    });
    expect(pushed.json()).toMatchObject({ invite_group: "skipped" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: 0 });
    expect(app.db.prepare("SELECT status,error FROM invite_group_sends").get()).toMatchObject({ status: "skipped", error: "未启用自动发群" });
  });

  it("does not send before the four fields are complete", async () => {
    await configure({ enabled: true, group_name: "内部邀约群", device_code: "pc-invite-01", city_abbr: { 深圳: "深" } });
    const pushed = await pushProfile({ stage: "collect", name: "谢子鑫", phone: "", city: "深圳" });
    expect(pushed.json().recruit_status).not.toBe("invited");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: 0 });
  });
});

/**
 * 群机器人 Webhook 通道。
 *
 * 为什么加它：建群企业微信没有开放接口，只能人工建一次；建好后在群里加
 * 群机器人就是一条固定 URL，后端直接 POST 即可。相比键鼠自动化，它不依赖
 * 客户端在线、不需要按群名搜索，也不会因群久不活跃被挤出本地会话表而失败。
 *
 * 安全：这个配置会让服务端主动发 POST，必须只放行企微官方地址，
 * 否则后台等于一个 SSRF 跳板（内网、云元数据端点都能打）。
 */
describe("invite group webhook", () => {
  const VALID = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa";

  it("accepts only the official WeCom group robot endpoint over https", () => {
    expect(isAllowedWebhookUrl(VALID)).toBe(true);
    expect(isAllowedWebhookUrl("http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc")).toBe(false);
    expect(isAllowedWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send")).toBe(false);
    expect(isAllowedWebhookUrl("https://evil.example.com/cgi-bin/webhook/send?key=abc")).toBe(false);
    expect(isAllowedWebhookUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/message/send?key=abc")).toBe(false);
    expect(isAllowedWebhookUrl("")).toBe(false);
  });

  it("posts the line to the robot and records it as sent", async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    const { buildServer } = await import("../src/server.js");
    const app = buildServer();
    await app.ready();
    const admin = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    const headers = { authorization: `Bearer ${admin}` };

    await app.inject({ method: "PUT", url: "/api/v1/agent/invite-group", headers, payload: { enabled: true, webhook_url: VALID, city_abbr: { 深圳: "深" } } });
    // 读回来必须是打码的，且不返回真值
    const readBack = (await app.inject({ method: "GET", url: "/api/v1/agent/invite-group", headers })).json();
    expect(readBack).toMatchObject({ enabled: true, webhookConfigured: true });
    expect(readBack.webhookUrl).toBe("");
    expect(readBack.webhookPreview).not.toContain("0ec2sifa5aaa");

    const { sendInviteGroupLine } = await import("../src/shared/invite-group.js");
    const calls: Array<{ url: string; content: string }> = [];
    const result = await sendInviteGroupLine(app.db, {
      deviceCode: "local-device-001", customerId: "700001", candidateEventId: 1,
      city: "深圳", interviewDate: "2026-11-09", name: "谢子鑫", phone: "18077352958",
    }, {
      send: async () => { throw new Error("client channel must not be used when webhook is configured"); },
      webhook: async (url, content) => { calls.push({ url, content }); return { success: true }; },
    });

    expect(result).toMatchObject({ status: "sent", content: "深11/9 谢子鑫 18077352958" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(VALID);
    expect(app.db.prepare("SELECT content,status FROM invite_group_sends").get()).toMatchObject({ content: "深11/9 谢子鑫 18077352958", status: "sent" });
    await app.close();
  });

  it("rejects a non-WeCom URL instead of silently falling back to the client", async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    const { buildServer } = await import("../src/server.js");
    const app = buildServer();
    await app.ready();
    const admin = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    const headers = { authorization: `Bearer ${admin}` };

    const rejected = await app.inject({ method: "PUT", url: "/api/v1/agent/invite-group", headers, payload: { enabled: true, webhook_url: "http://169.254.169.254/latest/meta-data" } });
    expect(rejected.statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/invite-group", headers })).json()).toMatchObject({ webhookConfigured: false });

    // 直接写入非法地址（绕过接口校验）时，发送必须明确失败，不能偷偷走客户端
    app.db.prepare(`INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('invite_group','global',?)`)
      .run(JSON.stringify({ enabled: true, group_name: "内部邀约群", webhook_url: "https://evil.example.com/x?key=1" }));
    const { sendInviteGroupLine } = await import("../src/shared/invite-group.js");
    const result = await sendInviteGroupLine(app.db, {
      deviceCode: "local-device-001", customerId: "700001", candidateEventId: 2,
      city: "深圳", interviewDate: "2026-11-09", name: "谢子鑫", phone: "18077352958",
    }, {
      send: async () => { throw new Error("must not fall back to client"); },
      webhook: async () => ({ success: true }),
    });
    expect(result.status).toBe("failed");
    expect(app.db.prepare("SELECT status,error FROM invite_group_sends").get()).toMatchObject({ status: "failed" });
    await app.close();
  });
});

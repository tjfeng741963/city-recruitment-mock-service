import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { buildInviteLine, cityAbbrOf, monthDayOf } from "../src/shared/invite-group.js";

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
    expect(app.db.prepare("SELECT status,error FROM invite_group_sends").get()).toMatchObject({ status: "skipped", error: "未配置邀约群" });
  });

  it("does not send before the four fields are complete", async () => {
    await configure({ enabled: true, group_name: "内部邀约群", device_code: "pc-invite-01", city_abbr: { 深圳: "深" } });
    const pushed = await pushProfile({ stage: "collect", name: "谢子鑫", phone: "", city: "深圳" });
    expect(pushed.json().recruit_status).not.toBe("invited");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bridge_commands").get()).toMatchObject({ n: 0 });
  });
});

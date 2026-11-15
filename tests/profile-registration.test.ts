import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("formal candidate registration", () => {
  let app: FastifyInstance;
  let token: string;
  let nextCustomer = 810000;
  const complete = { city: "广州", factory_name: "测试工厂", name: "张三", phone: "13800138000" };
  const headers = () => ({ authorization: `Bearer ${token}` });
  const createCustomer = () => {
    const id = String(++nextCustomer);
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,remark) VALUES (?,?,?,?)")
      .run("local-device-001", Number(id), "测试客户", "手工备注");
    return id;
  };
  const push = (id: string, profile: Record<string, unknown>) => app.inject({
    method: "POST", url: "/api/v1/agent/profile", headers: headers(),
    payload: { device_code: "local-device-001", customer_id: id, profile },
  });
  const events = (id: string) => app.db.prepare("SELECT * FROM candidate_events WHERE device_code=? AND customer_id=? AND event_type='invited'")
    .all("local-device-001", id) as Array<Record<string, unknown>>;
  const read = (id: string) => app.inject({ method: "GET", url: `/api/v1/agent/profile?device_code=local-device-001&customer_id=${id}`, headers: headers() });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });
  afterAll(async () => { await app.close(); });

  it.each([
    { name: "no consent", change: { stage: "asking" } },
    { name: "explicit refusal", change: { stage: "booked", interview_agreed: false } },
    { name: "string consent", change: { stage: "asking", interview_agreed: "true" } },
    { name: "missing name", change: { name: "  ", interview_agreed: true } },
    { name: "missing phone", change: { phone: "", interview_agreed: true } },
    { name: "invalid phone", change: { phone: "12345", interview_agreed: true } },
    { name: "missing city", change: { city: "", interview_agreed: true } },
    { name: "missing factory", change: { factory_name: "", interview_agreed: true } },
  ])("does not register $name even with a date or forged summary", async ({ change }) => {
    const id = createCustomer();
    const response = await push(id, { ...complete, interview_date: "2026-12-01", registration_text: "伪造记录", ...change });
    expect(response.statusCode).toBe(200);
    expect(response.json().recruit_status).not.toBe("invited");
    expect(events(id)).toHaveLength(0);
    const profile = (await read(id)).json();
    expect(profile.registration_text).toBe("");
    expect(profile.remark).toBe("手工备注");
  });

  it("registers after consent and split contact updates, without requiring an interview date", async () => {
    const id = createCustomer();
    await push(id, { city: "广州", factory_name: "测试工厂", stage: "collect", record: "无" });
    await push(id, { name: " 张三 " });
    expect(events(id)).toHaveLength(0);
    const booked = await push(id, { phone: "13800138000" });
    expect(booked.json().recruit_status).toBe("invited");
    expect(events(id)).toHaveLength(1);
    const firstId = events(id)[0].id;

    await push(id, { phone: "13800138000", registration_text: "不要信任调用方拼接" });
    await push(id, { notes: "希望长白班" });
    expect(events(id)).toHaveLength(1);
    expect(events(id)[0].id).toBe(firstId);
    const profile = (await read(id)).json();
    expect(profile).toMatchObject({ registration_text: "广州 测试工厂 张三 13800138000", remark: "广州 测试工厂 张三 13800138000\n希望长白班", profile: { record: "无", interview_agreed: true } });
    const candidates = (await app.inject({ method: "GET", url: "/api/v1/agent/candidates?event_type=invited", headers: headers() })).json();
    expect(candidates.items.find((item: Record<string, unknown>) => item.customer_id === id)).toMatchObject({ registration_text: "广州 测试工厂 张三 13800138000" });
    const communicating = app.db.prepare("SELECT status FROM candidate_events WHERE device_code=? AND customer_id=? AND event_type='communicating'").get("local-device-001", id);
    expect(communicating).toMatchObject({ status: "converted" });
  });

  it("accepts a complete legacy booked profile as consent", async () => {
    const id = createCustomer();
    const response = await push(id, { ...complete, stage: "booked", interview_date: "2026-12-01" });
    expect(response.json().recruit_status).toBe("invited");
    expect((await read(id)).json().registration_text).toBe("广州 测试工厂 张三 13800138000");
  });

  it("does not revive a withdrawn candidate when an old date is pushed", async () => {
    const id = createCustomer();
    await push(id, { ...complete, stage: "booked", interview_agreed: true });
    await push(id, { stage: "gave_up" });
    const late = await push(id, { interview_date: "2026-12-01", phone: "13800138000" });
    expect(late.json().recruit_status).toBe("disqualified");
    expect((await read(id)).json().profile.interview_agreed).toBe(false);
    expect(events(id)).toHaveLength(1);
  });

  it("updates the generated remark once while retaining manual notes and candidate metadata", async () => {
    const id = createCustomer();
    await push(id, { ...complete, interview_agreed: true });
    const row = events(id)[0];
    app.db.prepare("UPDATE candidate_events SET status='marked',data_json=json_set(data_json,'$.wechat_id','test-wechat') WHERE id=?").run(row.id);
    await push(id, { phone: "13900139000" });
    await push(id, { phone: "13900139000" });
    const profile = (await read(id)).json();
    expect(profile.remark).toBe("广州 测试工厂 张三 13900139000\n手工备注");
    expect(events(id)).toHaveLength(1);
    expect(events(id)[0].status).toBe("marked");
    expect(JSON.parse(String(events(id)[0].data_json))).toMatchObject({ registration_text: "广州 测试工厂 张三 13900139000", wechat_id: "test-wechat" });
  });

  it("does not duplicate a summary supplied through notes on the first registration", async () => {
    const id = createCustomer();
    const summary = "广州 测试工厂 张三 13800138000";
    await push(id, { ...complete, interview_agreed: true, notes: `${summary}\n希望长白班` });
    await push(id, { notes: `${summary}\n希望长白班` });
    expect((await read(id)).json().remark).toBe(`${summary}\n希望长白班`);
    expect(events(id)).toHaveLength(1);
  });

  it("rolls back the profile and remark if the candidate event cannot be created", async () => {
    const id = createCustomer();
    app.db.exec(`CREATE TRIGGER reject_registration BEFORE INSERT ON candidate_events WHEN NEW.customer_id='${id}' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    try {
      const response = await push(id, { ...complete, interview_agreed: true });
      expect(response.statusCode).toBe(500);
      const profile = (await read(id)).json();
      expect(profile).toMatchObject({ name: "", remark: "手工备注", registration_text: "" });
      expect(profile.recruit_status).not.toBe("invited");
      expect(events(id)).toHaveLength(0);
    } finally {
      app.db.exec("DROP TRIGGER reject_registration");
    }
  });
});

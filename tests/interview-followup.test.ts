import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { localToday, runFollowupOnce, type FollowupDeps } from "../src/modules/agent/followup.js";

function seedFollowupDb(options: { enabled: boolean; maxCount?: number; scripts?: string[] }) {
  const db = openDatabase(":memory:");
  migrateDatabase(db);
  db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('followup','global',?)")
    .run(JSON.stringify({ enabled: options.enabled, max_count: options.maxCount ?? 3, scripts: options.scripts ?? [] }));
  return db;
}

function insertCandidate(db: ReturnType<typeof seedFollowupDb>, date: string, remindCount = 0, status = "invited") {
  db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,interview_date,interview_time,status,remind_count) VALUES (?,?,?,?,?,?,?,?)")
    .run("device-followup", "710001", "示例候选人", "invited", date, "13:00", status, remindCount);
}

function shiftDays(days: number): string {
  const today = new Date(`${localToday()}T00:00:00`);
  today.setDate(today.getDate() + days);
  return localToday(today);
}

const stubChannel = () => {
  const calls: Array<{ deviceCode: string; customerId: number; content: string }> = [];
  const channel = {
    async sendMessage(input: { deviceCode: string; customerId: number; content: string }) {
      calls.push({ deviceCode: input.deviceCode, customerId: input.customerId, content: input.content });
      return { success: true, message_id: `stub-${calls.length}` };
    },
  };
  return { calls, channel };
};

describe("interview follow-up scan", () => {
  it("does not send anything while the followup switch is off", async () => {
    const db = seedFollowupDb({ enabled: false });
    insertCandidate(db, shiftDays(-1));
    const { calls, channel } = stubChannel();

    const result = await runFollowupOnce(db, { channel } as FollowupDeps);
    expect(result).toMatchObject({ skipped: true, sent: 0 });
    expect(calls).toHaveLength(0);
    expect(db.prepare("SELECT remind_count FROM candidate_events").get()).toMatchObject({ remind_count: 0 });
    db.close();
  });

  it("sends one reminder per run for a due candidate and bumps remind_count", async () => {
    const db = seedFollowupDb({ enabled: true, maxCount: 3, scripts: ["跟进脚本A", "跟进脚本B"] });
    insertCandidate(db, shiftDays(-1));
    const { calls, channel } = stubChannel();

    const first = await runFollowupOnce(db, { channel } as FollowupDeps);
    expect(first).toMatchObject({ skipped: false, scanned: 1, sent: 1, failed: 0 });
    expect(calls).toEqual([{ deviceCode: "device-followup", customerId: 710001, content: "跟进脚本A" }]);
    expect(db.prepare("SELECT remind_count,status FROM candidate_events").get()).toMatchObject({ remind_count: 1, status: "invited" });

    // 再跑一轮：仍然只发一条，次数递增（不是同一轮重复轰炸）。
    const second = await runFollowupOnce(db, { channel } as FollowupDeps);
    expect(second).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1].content).toBe("跟进脚本B");
    expect(db.prepare("SELECT remind_count FROM candidate_events").get()).toMatchObject({ remind_count: 2 });
    db.close();
  });

  it("skips future interviews, exhausted reminders and non-invited rows", async () => {
    const db = seedFollowupDb({ enabled: true, maxCount: 3 });
    insertCandidate(db, shiftDays(1)); // 明天才面试
    insertCandidate(db, shiftDays(-2), 3); // 已达上限
    insertCandidate(db, shiftDays(-3), 0, "disqualified");
    const { calls, channel } = stubChannel();

    const result = await runFollowupOnce(db, { channel } as FollowupDeps);
    expect(result).toMatchObject({ skipped: false, scanned: 0, sent: 0 });
    expect(calls).toHaveLength(0);
    db.close();
  });

  it("logs a failed send without retrying or counting it", async () => {
    const db = seedFollowupDb({ enabled: true });
    insertCandidate(db, shiftDays(-1));
    const logger = { warn: vi.fn() };
    const channel = { sendMessage: async () => ({ success: false, error: "gateway down" }) };

    const result = await runFollowupOnce(db, { channel, logger } as unknown as FollowupDeps);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT remind_count FROM candidate_events").get()).toMatchObject({ remind_count: 0 });
    expect(result.items[0]).toMatchObject({ ok: false, error: "gateway down" });
    db.close();
  });
});

describe("reminder-tasks and manual follow-up run", () => {
  let app: FastifyInstance;
  let adminToken = "";
  let customerToken = "";

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    const login = async (username: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } })).json().access_token;
    adminToken = await login("local-admin");
    customerToken = await login("local-customer");
  });

  afterAll(async () => { await app.close(); });

  const admin = () => ({ authorization: `Bearer ${adminToken}` });

  it("lists due candidates as reminder tasks instead of an empty array", async () => {
    app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,interview_date,interview_time,status,remind_count) VALUES (?,?,?,?,?,?,?,?)")
      .run("local-device-001", "720001", "待跟进客户", "invited", shiftDays(-1), "13:00", "invited", 0);

    const response = await app.inject({ method: "GET", url: "/api/v1/agent/reminder-tasks", headers: { authorization: `Bearer ${customerToken}` } });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: "720001", nickname: "待跟进客户", interview_date: shiftDays(-1), remind_count: 0 }),
    ]));
    const task = items.find((item) => item.customer_id === "720001")!;
    expect(typeof task.next_due).toBe("string");
    expect(task.next_due).not.toBe("");
  });

  it("keeps the manual trigger admin-only and idempotent per run", async () => {
    const forbidden = await app.inject({ method: "POST", url: "/api/v1/agent/followup/run", headers: { authorization: `Bearer ${customerToken}` } });
    expect(forbidden.statusCode).toBe(403);

    // 默认关闭：管理员点一下也不会发。
    const disabled = await app.inject({ method: "POST", url: "/api/v1/agent/followup/run", headers: admin() });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ skipped: true });

    const enabled = await app.inject({ method: "POST", url: "/api/v1/agent/followup-config", headers: admin(), payload: { recruiter_id: "global", enabled: true, max_count: 3, scripts: ["验收脚本"] } });
    expect(enabled.statusCode).toBe(200);

    const run = await app.inject({ method: "POST", url: "/api/v1/agent/followup/run", headers: admin() });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ skipped: false, sent: 1, failed: 0 });
    expect(run.json().items[0]).toMatchObject({ customer_id: "720001", remind_count: 1 });

    const after = app.db.prepare("SELECT remind_count FROM candidate_events WHERE customer_id=?").get("720001") as { remind_count: number };
    expect(after.remind_count).toBe(1);
  });
});

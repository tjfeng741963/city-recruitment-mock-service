import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";

/**
 * 激活扫描的两种触发方式（客户要求：「可以自动跑也可以手动填名单」）。
 *
 * 自动：activation_config.schedule_time 到点由定时器触发，一次扫描。
 * 手动：运营粘贴一批客户 ID，只对这些客户跑策略，不扩散到全库。
 *
 * 这里锁死手动名单的边界——给了名单就只扫那几个，没给才扫全库。
 */
const DAY = 86_400_000;
const isoAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe("activation manual scan", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let token = "";
  const headers = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    db = (app as FastifyInstance & { db: DatabaseSync }).db;
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;

    // 两个都满足「发过消息后沉默」的客户，用来验证名单边界
    for (const customerId of [301, 302]) {
      db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,created_at,last_msg_at) VALUES (?,?,?,?,?)")
        .run("scan-device", customerId, `客户${customerId}`, isoAgo(3), isoAgo(3));
      db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at) VALUES (?,?,?,?,?)")
        .run("scan-device", customerId, "outbound", "岗位资料", isoAgo(2));
    }
    await app.inject({
      method: "PUT",
      url: "/api/v1/activation/strategies/no_reply",
      headers: headers(),
      payload: { enabled: true, stale_days: 1, stale_days_max: 3, conversation_max_days: 10, cooldown_days: 14 },
    });
  });

  afterEach(async () => { await app?.close(); });

  it("scans only the customers the operator listed", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/activation/scan/manual",
      headers: headers(),
      payload: { customer_ids: ["301"], strategy: "no_reply" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ customers: 1 });

    const records = db.prepare("SELECT customer_id FROM activation_records ORDER BY customer_id").all() as Array<{ customer_id: number }>;
    expect(records.map((row) => row.customer_id)).toEqual([301]);
  });

  it("rejects an empty list and an unknown strategy", async () => {
    const empty = await app.inject({ method: "POST", url: "/api/v1/activation/scan/manual", headers: headers(), payload: { customer_ids: [] } });
    expect(empty.statusCode).toBe(422);

    const unknown = await app.inject({ method: "POST", url: "/api/v1/activation/scan/manual", headers: headers(), payload: { customer_ids: ["301"], strategy: "not_a_strategy" } });
    expect(unknown.statusCode).toBe(422);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activation_records").get()).toMatchObject({ n: 0 });
  });

  it("requires an admin token", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/activation/scan/manual", payload: { customer_ids: ["301"] } });
    expect(response.statusCode).toBe(403);
  });

  it("deduplicates repeated ids in the pasted list", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/activation/scan/manual",
      headers: headers(),
      payload: { customer_ids: ["301", "301", " 301 "] },
    });
    expect(response.json()).toMatchObject({ customers: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activation_records WHERE customer_id=301").get()).toMatchObject({ n: 1 });
  });
});

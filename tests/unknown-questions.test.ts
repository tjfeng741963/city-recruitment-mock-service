import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";
import { normalizeQuestion } from "../src/modules/agent/unknown-questions.routes.js";

/**
 * 未知问题（任务 C）：8090 记账 → 知识库页列表 → 运营标记已处理。
 *
 * 覆盖：
 * - 018 迁移的列与 016/017 的 province 列都在
 * - 服务间台账（X-Profile-Token）按归一化问题累加 occurrence_count
 * - 列表 status 筛选、count/city_name/last_seen_at 字段
 * - resolve 幂等，不存在的 id 404
 */
describe("unknown questions api", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let token = "";
  const SERVICE_TOKEN = "svc-uq-token";
  const headers = () => ({ authorization: `Bearer ${token}` });
  const serviceHeaders = { "x-profile-token": SERVICE_TOKEN };

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = SERVICE_TOKEN;
    app = buildServer();
    await app.ready();
    db = (app as FastifyInstance & { db: DatabaseSync }).db;
    token = (await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    })).json().access_token;
  });

  afterAll(async () => {
    delete process.env.REA_PROFILE_TOKEN;
    await app.close();
  });

  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

  it("adds province columns to conversations and candidate events", () => {
    expect(columns("agent_conversations")).toContain("province");
    expect(columns("candidate_events")).toContain("province");
  });

  it("adds the unknown question columns used by the flow", () => {
    const names = columns("unknown_questions");
    expect(names).toEqual(expect.arrayContaining(["device_code", "customer_id", "occurrence_count", "question", "status"]));
  });

  it("records the same question once and counts repeats", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/agent/unknown-questions",
      headers: serviceHeaders,
      payload: { question: "宿舍有没有空调？", device_code: "pc-office-01", external_conversation_id: "wx-1" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ question: "宿舍有没有空调", occurrence_count: 1, status: "pending" });

    // 归一化后是同一句：只累加次数，不新增行
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/agent/unknown-questions",
      headers: serviceHeaders,
      payload: { question: "  宿舍有没有空调 ？ ", device_code: "pc-office-01" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, occurrence_count: 2 });

    const rows = db.prepare("SELECT COUNT(*) count FROM unknown_questions WHERE question=?").get("宿舍有没有空调") as { count: number };
    expect(rows.count).toBe(1);
  });

  it("rejects an anonymous ingest", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/unknown-questions",
      payload: { question: "没人鉴权" },
    });
    expect(response.statusCode).toBe(403);

    const blank = await app.inject({
      method: "POST",
      url: "/api/v1/agent/unknown-questions",
      headers: serviceHeaders,
      payload: { question: "   " },
    });
    expect(blank.statusCode).toBe(422);
  });

  it("lists with status filter and fills the fields the knowledge page reads", async () => {
    db.prepare("INSERT INTO unknown_questions(question,status,device_code,occurrence_count,data_json) VALUES (?,?,?,?,?)")
      .run("体检要自己出钱吗", "pending", "pc-office-02", 5, JSON.stringify({ city_name: "广州" }));

    const all = await app.inject({ method: "GET", url: "/api/v1/unknown-questions?page=1&page_size=20", headers: headers() });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ total: expect.any(Number) });
    expect(all.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: "体检要自己出钱吗", status: "pending", count: 5, occurrence_count: 5, city_name: "广州" }),
    ]));
    expect(all.json().items[0]).toHaveProperty("last_seen_at");

    const pending = await app.inject({ method: "GET", url: "/api/v1/unknown-questions?status=pending&page=1&page_size=20", headers: headers() });
    expect(pending.json().items.every((item: Record<string, unknown>) => item.status === "pending")).toBe(true);

    const resolved = await app.inject({ method: "GET", url: "/api/v1/unknown-questions?status=resolved", headers: headers() });
    expect(resolved.json().items.every((item: Record<string, unknown>) => item.status === "resolved")).toBe(true);

    const searched = await app.inject({ method: "GET", url: `/api/v1/unknown-questions?search=${encodeURIComponent("体检")}`, headers: headers() });
    expect(searched.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ question: "体检要自己出钱吗" })]));
  });

  it("marks a question resolved idempotently and 404s an unknown id", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agent/unknown-questions",
      headers: serviceHeaders,
      payload: { question: "上班能不能带手机", device_code: "pc-office-03" },
    });
    const id = created.json().id as number;

    const first = await app.inject({ method: "POST", url: `/api/v1/unknown-questions/${id}/resolve`, headers: headers() });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ success: true, id, status: "resolved" });
    expect((db.prepare("SELECT status FROM unknown_questions WHERE id=?").get(id) as { status: string }).status).toBe("resolved");

    const second = await app.inject({ method: "POST", url: `/api/v1/unknown-questions/${id}/resolve`, headers: headers() });
    expect(second.statusCode).toBe(200);

    const missing = await app.inject({ method: "POST", url: "/api/v1/unknown-questions/999999/resolve", headers: headers() });
    expect(missing.statusCode).toBe(404);
  });

  it("normalizes questions for dedupe", () => {
    expect(normalizeQuestion("  宿舍  有没有空调？ ")).toBe("宿舍 有没有空调");
    expect(normalizeQuestion("工资多少")).toBe("工资多少");
    expect(normalizeQuestion("多少钱？？")).toBe("多少钱");
    expect(normalizeQuestion(undefined)).toBe("");
  });
});

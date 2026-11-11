import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { buildServer } from "../src/server.js";
import { defaultKbTitle } from "../src/modules/agent/unknown-questions.routes.js";

/**
 * 未知问题「转知识库」（契约 2026-11-11）：
 * convert 拿运营填的答案去 8090（REA_BRAIN_URL）建一条 script 话术，
 * 201 才标 resolved；8090 挂了返回 502、状态不动。已 resolved 幂等返回。
 * 8090 用进程内 mock 模拟。
 */
describe("unknown question conversion", () => {
  let app: FastifyInstance;
  let token = "";
  let db: DatabaseSync;
  let brain: http.Server;
  let brainUrl = "";
  let brainCalls: Array<{ path: string; token: string | undefined; body: Record<string, unknown> }> = [];
  // "ok" → 201；其它值 → 以该数字作为状态码返回
  let brainMode: "ok" | number = "ok";

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "svc-profile-token";
    app = buildServer();
    await app.ready();
    db = (app as FastifyInstance & { db: DatabaseSync }).db;
    token = (await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    })).json().access_token;

    brain = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { body = {}; }
        brainCalls.push({ path: req.url ?? "", token: req.headers["x-profile-token"], body });
        const status = brainMode === "ok" ? 201 : brainMode;
        res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ id: 4321, title: body.title ?? "" }));
      });
    });
    await new Promise<void>((resolve) => brain.listen(0, "127.0.0.1", resolve));
    const address = brain.address() as { address: string; port: number };
    brainUrl = `http://${address.address}:${address.port}`;
    process.env.REA_BRAIN_URL = brainUrl;
  });

  afterAll(async () => {
    delete process.env.REA_BRAIN_URL;
    delete process.env.REA_PROFILE_TOKEN;
    await new Promise<void>((resolve) => brain.close(() => resolve()));
    brain.closeAllConnections();
    await app.close();
  });

  async function createQuestion(question: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/unknown-questions",
      headers: { authorization: `Bearer ${token}` },
      payload: { question, status: "pending", count: 2, city_name: "广州" },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as number;
  }

  it("creates a script entry on 8090 and marks the question resolved", async () => {
    const id = await createQuestion("转知识库：报名需要什么资料？");
    brainCalls.length = 0;
    brainMode = "ok";

    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "身份证和本人银行卡", title: "报名资料" },
    });

    expect(converted.statusCode).toBe(200);
    expect(converted.json()).toMatchObject({ success: true, id, status: "resolved", title: "报名资料" });

    expect(brainCalls).toHaveLength(1);
    const call = brainCalls[0];
    expect(call.path).toBe("/api/v1/kb/entries");
    expect(call.token).toBe("svc-profile-token");
    expect(call.body).toEqual({ kind: "script", title: "报名资料", body: "身份证和本人银行卡", status: "enabled" });

    const stored = db.prepare("SELECT status FROM unknown_questions WHERE id=?").get(id) as { status: string };
    expect(stored.status).toBe("resolved");
  });

  it("derives a punctuation-free title capped at 30 chars when title is omitted", async () => {
    const id = await createQuestion("哈哈哈，你们那个厂！宿舍到底有没有空调、WiFi？冬天冷不冷？麻烦说下，谢谢啦各位");
    brainCalls.length = 0;

    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "宿舍有空调和独立WiFi。" },
    });

    expect(converted.statusCode).toBe(200);
    const title = String(converted.json().title);
    expect(title).toHaveLength(30);
    expect(title).not.toMatch(/[\p{P}\p{S}]/u);
    expect(brainCalls[0].body.title).toBe(title);
  });

  it("is idempotent once resolved and does not call 8090 again", async () => {
    const id = await createQuestion("幂等转换测试");
    brainCalls.length = 0;

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "每天八小时" },
    });
    expect(first.statusCode).toBe(200);
    expect(brainCalls).toHaveLength(1);

    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "每天八小时" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ success: true, id, status: "resolved" });
    expect(brainCalls).toHaveLength(1); // 没有第二次 8090 调用
  });

  it("returns 502 and keeps the question pending when 8090 is unreachable", async () => {
    const id = await createQuestion("8090不可达测试");
    process.env.REA_BRAIN_URL = "http://127.0.0.1:1"; // 保留端口，必然连接失败

    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "不会丢的答案" },
    });

    expect(converted.statusCode).toBe(502);
    expect(converted.json().detail).toBeTruthy();
    const stored = db.prepare("SELECT status FROM unknown_questions WHERE id=?").get(id) as { status: string };
    expect(stored.status).toBe("pending");

    process.env.REA_BRAIN_URL = brainUrl;
  });

  it("returns 502 when 8090 answers with an error status", async () => {
    const id = await createQuestion("8090报错测试");
    brainMode = 500;

    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "答案照旧" },
    });

    expect(converted.statusCode).toBe(502);
    const stored = db.prepare("SELECT status FROM unknown_questions WHERE id=?").get(id) as { status: string };
    expect(stored.status).toBe("pending");
    brainMode = "ok";
  });

  it("rejects missing answers and unknown ids without touching 8090", async () => {
    const id = await createQuestion("参数校验测试");
    brainCalls.length = 0;

    const noAnswer = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(noAnswer.statusCode).toBe(422);

    const blank = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "   " },
    });
    expect(blank.statusCode).toBe(422);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/unknown-questions/999999/convert",
      headers: { authorization: `Bearer ${token}` },
      payload: { answer: "x" },
    });
    expect(missing.statusCode).toBe(404);

    expect(brainCalls).toHaveLength(0);
    const stored = db.prepare("SELECT status FROM unknown_questions WHERE id=?").get(id) as { status: string };
    expect(stored.status).toBe("pending");
  });

  it("builds the default title by stripping punctuation and truncating to 30 chars", () => {
    expect(defaultKbTitle("体检要自己出钱吗？")).toBe("体检要自己出钱吗");
    expect(defaultKbTitle("a, b！c？")).toBe("abc");
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一";
    expect(defaultKbTitle(long)).toHaveLength(30);
    expect(defaultKbTitle("？？？")).toBe("？？？"); // 去标点后为空 → 回退原句
    expect(defaultKbTitle(undefined)).toBe("");
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

describe("interview registration follow-up summary", () => {
  const app = (() => {
    process.env.REA_DATABASE_PATH = ":memory:";
    return buildServer();
  })();
  let admin: Record<string, string>;
  let recruiter: Record<string, string>;
  const difyKey = "dify:" + "a".repeat(64);
  const generate = (key: string, headers = admin) => app.inject({
    method: "POST", url: `/api/v1/agent/archive/${encodeURIComponent(key)}/followup-summary`, headers,
  });
  const quote = "早班可以，晚班要看末班车。";

  beforeAll(async () => {
    await app.ready();
    async function login(username: string) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } });
      return { authorization: `Bearer ${res.json().access_token}` };
    }
    admin = await login("local-admin");
    recruiter = await login("local-recruiter");

    const conversation = app.db.prepare(`INSERT INTO agent_conversations
      (device_code,customer_id,external_conversation_id,unread) VALUES (?,?,?,4) RETURNING id`);
    conversation.get("summary-agent", 901, "agent-summary");
    const dify = conversation.get("summary-dify", 902, "external-dify")!;
    conversation.get("summary-other", 902, "external-dify");
    conversation.get("summary-agent", 903, "ambiguous-summary");
    conversation.get("summary-other", 903, "ambiguous-summary");
    conversation.get("summary-agent", 904, "outbound-only");
    conversation.get("summary-other", 905, "manual:1");
    conversation.get("summary-other", 906, "dify:" + "b".repeat(64));
    const archive = app.db.prepare("INSERT INTO agent_archive(session_key,position_id,name) VALUES (?, 1, '测试候选人')");
    for (const key of ["agent-summary", "ambiguous-summary", "manual:1", "outbound-only", difyKey, "dify:" + "b".repeat(64)]) archive.run(key);
    app.db.prepare(`UPDATE agent_archive SET dify_device_code=?,dify_conversation_row_id=?,dify_external_session=?
      WHERE session_key=?`).run("summary-dify", dify.id, "external-dify", difyKey);

    const message = app.db.prepare(`INSERT INTO agent_messages(id,device_code,customer_id,direction,content,status)
      VALUES (?,?,?,?,?,?)`);
    message.run(8001, "summary-agent", 901, "inbound", quote + " 我叫测试候选人，手机号13800000000", "received");
    message.run(8002, "summary-agent", 901, "outbound", "未送达内容", "queued");
    message.run(8003, "summary-agent", 901, "outbound", "这边有早班和晚班", "sent");
    message.run(8004, "summary-dify", 902, "inbound", "以前做过保安。", "sent");
    message.run(8005, "summary-other", 902, "inbound", "其他设备的对话", "sent");
    message.run(8006, "summary-agent", 904, "outbound", "你好，想咨询什么？", "sent");
    message.run(8007, "summary-agent", 901, "inbound", "甲".repeat(690) + " 手机13800012345", "received");
    message.run(8008, "summary-agent", 901, "inbound", "[能接受倒班]", "received");
    for (let id = 8010; id < 8070; id++) message.run(id, "summary-agent", 901, "inbound", "[图片]", "received");
    app.db.prepare("UPDATE agent_messages SET created_at='2026-11-01T10:00:00Z' WHERE id=8003").run();
    app.db.prepare("UPDATE agent_messages SET created_at='2026-11-01T10:01:00Z' WHERE id=8001").run();
  });
  beforeEach(() => {
    vi.stubEnv("AGENT_LLM_API_KEY", "summary-test");
    vi.stubEnv("AGENT_LLM_MODEL", "deepseek-chat");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(() => app.close());

  function stubModel(evidence: { message_id: number; text: string }, nextQuestion = "晚班怎样回家？") {
    const fetchModel = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        intent: "在确认晚班通勤", discussed: "可以接受早班", experience: null,
        next_question: nextQuestion, evidence,
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchModel);
    return fetchModel;
  }

  it("uses the linked Agent chat, validates the quote, and keeps unread and delivery state", async () => {
    const model = stubModel({ message_id: 8001, text: quote });
    const queued = app.db.prepare("SELECT COUNT(*) n FROM bridge_commands").get()!.n;
    const result = await generate("agent-summary");
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      intent: "在确认晚班通勤", discussed: "可以接受早班", experience: null,
      next_question: "晚班怎样回家？", quote,
    });
    const body = String(model.mock.calls[0][1].body);
    expect(body).toContain("这边有早班和晚班");
    expect(body).toContain("[能接受倒班]");
    expect(body.indexOf("这边有早班和晚班")).toBeLessThan(body.indexOf(quote));
    expect(body).not.toMatch(/138000|未送达内容|测试候选人|\[图片\]/);
    expect(app.db.prepare("SELECT unread FROM agent_conversations WHERE device_code='summary-agent' AND customer_id=901").get()!.unread).toBe(4);
    expect(app.db.prepare("SELECT COUNT(*) n FROM bridge_commands").get()!.n).toBe(queued);
  });

  it("uses the exact Dify device and conversation and drops invented quotes", async () => {
    const model = stubModel({ message_id: 8004, text: "从未说过的内容" });
    const result = await generate(difyKey);
    expect(result.statusCode).toBe(200);
    expect(result.json().quote).toBeNull();
    expect(String(model.mock.calls[0][1].body)).toContain("以前做过保安。");
    expect(String(model.mock.calls[0][1].body)).not.toContain("其他设备的对话");
  });

  it("exposes only link status in the list and skips model calls on unavailable records", async () => {
    const model = stubModel({ message_id: 8001, text: quote });
    const list = await app.inject({ url: "/api/v1/agent/archive/list", headers: admin });
    expect(list.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_key: difyKey, has_conversation: true }),
      expect.objectContaining({ session_key: "ambiguous-summary", has_conversation: false }),
      expect.objectContaining({ session_key: "manual:1", has_conversation: false }),
    ]));
    expect((await generate("agent-summary", recruiter)).statusCode).toBe(403);
    expect((await generate("missing")).statusCode).toBe(404);
    expect((await generate("manual:1")).json()).toMatchObject({ code: "no_conversation" });
    expect((await generate("dify:" + "b".repeat(64))).json()).toMatchObject({ code: "no_conversation" });
    expect((await generate("ambiguous-summary")).json()).toMatchObject({ code: "no_conversation" });
    expect((await generate("outbound-only")).json()).toMatchObject({ code: "no_candidate_messages" });
    expect(model).not.toHaveBeenCalled();
  });

  it("does not label a redacted excerpt as a verbatim quote", async () => {
    stubModel({ message_id: 8001, text: "手机号[手机号已隐藏]" });
    const result = await generate("agent-summary");
    expect(result.statusCode).toBe(200);
    expect(result.json().quote).toBeNull();
  });

  it("requires a non-reasoning model before sending any chat text", async () => {
    vi.stubEnv("AGENT_LLM_MODEL", "deepseek-reasoner");
    const model = stubModel({ message_id: 8001, text: quote });
    expect((await generate("agent-summary")).statusCode).toBe(503);
    expect(model).not.toHaveBeenCalled();
  });

  it("suppresses recruitment scoring or hiring decisions from generated fields", async () => {
    stubModel({ message_id: 8001, text: quote }, "候选人评分 1/10，建议淘汰");
    const result = await generate("agent-summary");
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ next_question: null, quote });
  });

  it("returns a retryable response when the model is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private provider error")));
    const result = await generate("agent-summary");
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain("private provider error");
  });
});

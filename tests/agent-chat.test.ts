import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// Agent 会话接口（src/modules/agent/agent-chat.routes.ts）
//
// 只测不依赖网络的路径：上下文读取、dry 模式的 prompt 拼装、
// 以及「没配 key 时返回结构化的失败」——真实模型调用不放进单测。
describe("agent chat routes", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let positionId: number;
  const saved = { ...process.env };

  const login = async (username: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "local-demo-only" },
    });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${res.json().access_token}` };
  };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    delete process.env.AGENT_LLM_API_KEY;
    app = buildServer();
    await app.ready();
    admin = await login("local-admin");
    customer = await login("local-customer");

    const row = app.db
      .prepare("INSERT INTO service_positions(position_name,status,data_json) VALUES (?,?,?) RETURNING id")
      .get(
        "地铁安检员",
        "enabled",
        JSON.stringify({ wage_text: "22元/小时", place: "陈村基地", hours_text: "两班倒" }),
      ) as { id: number };
    positionId = Number(row.id);
  });

  afterEach(async () => {
    await app?.close();
    for (const key of [
      "REA_DATABASE_PATH",
      "REA_MESSAGE_CHANNEL_PROVIDER",
      "REA_DIFY_PROVIDER",
      "AGENT_LLM_API_KEY",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("上下文把岗位事实整理成 facts，空字段不出现", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agent/context?position_id=${positionId}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facts).toMatchObject({ job_title: "地铁安检员", wage_text: "22元/小时", place: "陈村基地" });
    // data_json 里没写的键不能凭空出现
    expect(body.facts.interview_time).toBeUndefined();
    expect(body.opening).toEqual([]);
    expect(body.llm.configured).toBe(false);
  });

  it("非管理员读不到上下文，也调不了对话", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/agent/context?position_id=${positionId}`,
          headers: customer,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agent/chat",
          headers: customer,
          payload: { position_id: positionId, text: "多少钱" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("dry 模式不调模型，返回 system + 历史 + 当前这句", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: {
        position_id: positionId,
        text: "有没有夜班",
        dry: true,
        history: [
          { role: "customer", text: "多少钱一小时" },
          { role: "agent", text: "22 一小时" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dry).toBe(true);
    expect(body.messages[0].role).toBe("system");
    // 事实必须真的进了 system，而不是只在接口响应里
    expect(body.messages[0].content).toContain("22元/小时");
    expect(body.messages[1]).toEqual({ role: "user", content: "多少钱一小时" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "22 一小时" });
    expect(body.messages[3]).toEqual({ role: "user", content: "有没有夜班" });
  });

  it("没配 key 时返回结构化失败，不抛 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, text: "多少钱" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_api_key");
    expect(String(body.error)).toContain("AGENT_LLM_API_KEY");
  });

  it("岗位不存在时 404", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/agent/context?position_id=99999",
          headers: admin,
        })
      ).statusCode,
    ).toBe(404);
  });
});

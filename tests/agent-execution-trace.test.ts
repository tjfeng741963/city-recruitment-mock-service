import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("agent execution evidence", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let positionId: number;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    delete process.env.AGENT_LLM_API_KEY;
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const row = app.db.prepare(
      "INSERT INTO service_positions(position_name,status,data_json) VALUES (?,?,?) RETURNING id",
    ).get(
      "仓库分拣",
      "enabled",
      JSON.stringify({ wage_text: "26元/小时", place: "东门", hours_text: "两班倒" }),
    ) as { id: number };
    positionId = Number(row.id);
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "AGENT_LLM_API_KEY"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns and persists dry-run evidence with fact sources", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: {
        position_id: positionId,
        session_key: "S:trace-demo",
        text: "工资是多少",
        dry: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.trace_id).toMatch(/^agent-trace-/);
    expect(body.evidence).toMatchObject({
      engine: "agent",
      position_id: positionId,
      facts: { wage_text: "26元/小时" },
      fact_sources: { wage_text: { kind: "position", label: "岗位资料" } },
    });

    const traces = await app.inject({
      method: "GET",
      url: "/api/v1/agent/execution-traces?session_key=S%3Atrace-demo",
      headers: admin,
    });
    expect(traces.statusCode).toBe(200);
    const traceList = traces.json();
    expect(traceList.total).toBe(1);
    expect(traceList.items[0]).toMatchObject({ trace_id: body.trace_id, status: "dry_run" });
    expect(traceList.items[0].facts.wage_text).toBe("26元/小时");
    expect(traceList.items[0].fact_sources.wage_text.kind).toBe("position");
  });

  it("records a structured failure when the model is not configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, session_key: "S:trace-fail", text: "在吗" },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.trace_id).toMatch(/^agent-trace-/);
    expect(body.code).toBe("no_api_key");

    const traces = await app.inject({
      method: "GET",
      url: "/api/v1/agent/execution-traces?trace_id=" + encodeURIComponent(body.trace_id),
      headers: admin,
    });
    expect(traces.json().items).toEqual([
      expect.objectContaining({ status: "failed", error_code: "no_api_key" }),
    ]);
  });

  it("does not expose traces to a non-admin user", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-customer", password: "local-demo-only" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent/execution-traces",
      headers: { authorization: `Bearer ${login.json().access_token}` },
    });
    expect(response.statusCode).toBe(403);
  });
});

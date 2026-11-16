import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("controlled FAQ publication", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let calls: Array<{ url: string; body: any; headers: any }>;
  const saved = { ...process.env };
  const keys = ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER", "REA_BRAIN_URL", "REA_PROFILE_TOKEN"];
  const post = (path: string, payload = {}, headers = admin) => app.inject({ method: "POST", url: `/api/v1/kb-publish/${path}`, headers, payload });
  beforeEach(async () => {
    Object.assign(process.env, { REA_DATABASE_PATH: ":memory:", REA_MESSAGE_CHANNEL_PROVIDER: "bridge", REA_DIFY_PROVIDER: "mock", REA_BRAIN_URL: "http://real-brain:8090", REA_PROFILE_TOKEN: "test-profile-key" });
    app = buildServer();
    await app.ready();
    for (const name of ["local-admin", "local-customer"]) {
      const result = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: "local-demo-only" } });
      if (name === "local-admin") admin = { authorization: `Bearer ${result.json().access_token}` };
      else customer = { authorization: `Bearer ${result.json().access_token}` };
    }
    app.db.prepare("DELETE FROM kb_faq").run();
    app.db.prepare("INSERT INTO kb_faq(id,tenant_id,vertical_id,scope_level,question,keywords,answer) VALUES(701,1,2,'global','工资多少','[\"工资\"]','{wage}')").run();
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body, headers: init.headers });
      if (url.endsWith("/preview")) return Response.json({ target_id: "real-instance", target_revision: "revision-0", target_generation: 0, payload_digest: "reviewed", items: body.items ?? [], changes: [{ source_id: 701, action: "create" }], managed_count: 0 });
      if (url.endsWith("/apply")) return Response.json({ publication_id: body.publication_id, target_id: body.expected_target, payload_digest: body.payload_digest, managed_count: 1, changes: [], replayed: false });
      if (url.endsWith("/instance")) return Response.json({ install_id: "real-instance" });
      return Response.json({ items: [] });
    }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it("requires admin before reading either side or sending any credentials", async () => {
    for (const headers of [customer, {}]) {
      expect((await post("preview", {}, headers)).statusCode).toBe(403);
      expect((await post("apply", { preview_id: "x" }, headers)).statusCode).toBe(403);
      expect((await app.inject({ url: "/api/v1/kb-publish/history", headers })).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });
  it("previews stable category codes, pins target and applies the reviewed snapshot idempotently", async () => {
    const preview = (await post("preview")).json();
    expect(calls[0]).toMatchObject({ url: "http://real-brain:8090/api/v1/kb/publish/preview", headers: { "X-Profile-Token": "test-profile-key" } });
    expect(calls[0].body.items[0]).toMatchObject({ source_id: 701, vertical_code: "subway" });
    expect(calls[0].body.items[0]).not.toHaveProperty("vertical_id");
    const first = await post("apply", { preview_id: preview.preview_id });
    expect(first.statusCode).toBe(200);
    expect(calls[1].body).toMatchObject({ expected_target: "real-instance", expected_revision: "revision-0", payload_digest: "reviewed" });
    expect((await post("apply", { preview_id: preview.preview_id })).json().replayed).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it("blocks source edits, expired previews and changed destination without sending an apply", async () => {
    const preview = (await post("preview")).json();
    app.db.prepare("UPDATE kb_faq SET answer='{welfare}' WHERE id=701").run();
    expect((await post("apply", { preview_id: preview.preview_id })).statusCode).toBe(409);
    app.db.prepare("UPDATE kb_faq SET answer='{wage}' WHERE id=701").run();
    app.db.prepare("UPDATE kb_publication_preview SET created_at=0").run();
    expect((await post("apply", { preview_id: preview.preview_id })).statusCode).toBe(409);
    process.env.REA_BRAIN_URL = "http://wrong-brain:8090";
    expect((await post("apply", { preview_id: preview.preview_id })).statusCode).toBe(409);
    expect(calls).toHaveLength(1);
  });
  it("rejects unsafe shared policy and unmapped employer scopes before contacting the target", async () => {
    app.db.prepare("UPDATE kb_faq SET answer='25元/小时' WHERE id=701").run();
    expect((await post("preview")).statusCode).toBe(422);
    app.db.prepare("UPDATE kb_faq SET scope_level='employer',status='disabled' WHERE id=701").run();
    expect((await post("preview")).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });
  it("never reports success after rejection or uncertain network outcome; retry keeps publication id", async () => {
    const preview = (await post("preview")).json();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private-network-diagnostics"));
    const failure = await post("apply", { preview_id: preview.preview_id });
    expect(failure.statusCode).toBe(502);
    expect(failure.body).not.toContain("private-network-diagnostics");
    expect(app.db.prepare("SELECT result_json FROM kb_publication_preview").get()!.result_json).toBeNull();
    const retry = await post("apply", { preview_id: preview.preview_id });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().publication_id).toBe(preview.preview_id);
  });
  it("forwards rollback preview and target conflicts, and fails closed when unconfigured", async () => {
    expect((await post("preview", { rollback_of: "prior-publication" })).statusCode).toBe(200);
    expect(calls[0].body).toEqual({ rollback_of: "prior-publication" });
    const preview = (await post("preview")).json();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ detail: "目标已变化" }, { status: 409 }));
    expect((await post("apply", { preview_id: preview.preview_id })).statusCode).toBe(409);
    delete process.env.REA_BRAIN_URL;
    expect((await post("preview")).statusCode).toBe(503);
  });
});

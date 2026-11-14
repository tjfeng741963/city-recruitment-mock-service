import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { FACT_FIELDS, sharedAnswerAllowed, sharedFaqIssues } from "../src/modules/agent/kb-governance.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/kb-policy.json", import.meta.url), "utf8")) as Array<{ question: string; answer: string; allowed: boolean; keywords?: string[]; media?: string[] }>;
describe("shared policy contract used by Node and Python", () => {
  it.each(cases)("$question / $answer", row => {
    expect(sharedAnswerAllowed(row.question, row.answer, row.keywords, row.media)).toBe(row.allowed);
  });
  it("accepts every supported fact field and rejects unknown or broken shared placeholders", () => {
    for (const name of FACT_FIELDS) expect(sharedFaqIssues({ scope_level: "global", question: "岗位信息", answer: `{${name}}` })).toEqual([]);
    for (const answer of ["{training|考试就能上岗}", "{{address}}", "{address", "{anything}"]) {
      expect(sharedFaqIssues({ scope_level: "global", question: "岗位信息", answer }).length).toBeGreaterThan(0);
    }
  });
});

describe("FAQ writes and read-only inventory", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let employer: number;
  let position: number;
  let location: number;
  const saved = { ...process.env };
  const post = (payload: object) => app.inject({ method: "POST", url: "/api/v1/kb-faqs", headers: admin, payload });
  const put = (id: number, payload: object) => app.inject({ method: "PUT", url: `/api/v1/kb-faqs/${id}`, headers: admin, payload });
  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    for (const name of ["local-admin", "local-customer"]) {
      const token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: "local-demo-only" } })).json().access_token;
      if (name === "local-admin") admin = { authorization: `Bearer ${token}` }; else customer = { authorization: `Bearer ${token}` };
    }
    employer = Number(app.db.prepare("SELECT id FROM employer WHERE vertical_id=1 AND status='enabled' LIMIT 1").get()!.id);
    position = Number(app.db.prepare("SELECT id FROM service_positions WHERE status='enabled' LIMIT 1").get()!.id);
    location = Number(app.db.prepare("INSERT INTO location(level,name) VALUES ('city','审计测试城') RETURNING id").get()!.id);
  });
  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it.each(["global", "city", "vertical"])("blocks fixed shared prices and policy defaults in %s", async scope => {
    const before = app.db.prepare("SELECT COUNT(*) n FROM kb_faq").get()!.n;
    for (const answer of ["22元/小时", "{wage|22元/小时}", "{wage}，体检免费", "月薪五千起"]) {
      expect((await post({ question: "工资多少", answer, scope_level: scope, vertical_id: 1, scope_location_id: location })).statusCode).toBe(422);
    }
    expect(app.db.prepare("SELECT COUNT(*) n FROM kb_faq").get()!.n).toBe(before);
    expect((await post({ question: "工资多少", answer: "这边工价是{wage}", scope_level: scope, vertical_id: 1, scope_location_id: location })).statusCode).toBe(201);
  });

  it("persists a scope change and clears unrelated identities after re-reading", async () => {
    const row = (await post({ question: "工资多少", answer: "{wage}", vertical_id: 1 })).json();
    const changed = await put(row.id, { scope_level: "position", scope_position_id: position, scope_employer_id: employer, answer: "本岗25元/小时" });
    expect(changed.statusCode).toBe(200);
    const listed = (await app.inject({ method: "GET", url: `/api/v1/kb-faqs?scope_position_id=${position}`, headers: admin })).json();
    expect(listed.items.find((item: { id: number }) => item.id === row.id)).toMatchObject({ scope_level: "position", scope_position_id: position, scope_employer_id: null, scope_location_id: null, answer: "本岗25元/小时" });
    expect((await put(row.id, { scope_level: "global" })).statusCode).toBe(422);
    expect(app.db.prepare("SELECT scope_level,answer FROM kb_faq WHERE id=?").get(row.id)).toMatchObject({ scope_level: "position", answer: "本岗25元/小时" });
    expect((await put(row.id, { scope_level: "global", vertical_id: 2, answer: "{wage}" })).statusCode).toBe(200);
    expect(app.db.prepare("SELECT scope_position_id,vertical_id FROM kb_faq WHERE id=?").get(row.id)).toMatchObject({ scope_position_id: null, vertical_id: 2 });
  });

  it("validates missing, malformed, inactive and mismatched references instead of returning a server error", async () => {
    for (const changes of [
      { scope_level: "employer", scope_employer_id: 999999 },
      { scope_level: "employer", scope_employer_id: employer, vertical_id: 2 },
      { scope_level: "position", scope_position_id: -1 },
      { scope_level: "position", scope_position_id: true },
      { scope_level: "position", scope_position_id: 999999 },
      { scope_level: "vertical" }, { vertical_id: 999999 }, { media: "bad" }, { keywords: [25] }, { status: "bogus" },
    ]) expect((await post({ question: "你好", answer: "你好", ...changes })).statusCode).toBe(422);
    app.db.prepare("UPDATE employer SET status='disabled' WHERE id=?").run(employer);
    expect((await post({ question: "体检", answer: "本厂免费体检", scope_level: "employer", scope_employer_id: employer })).statusCode).toBe(422);
  });

  it("allows exact employer content and quarantined drafts but validates re-enabling and partial edits", async () => {
    expect((await post({ question: "体检", answer: "本厂免费体检", scope_level: "employer", scope_employer_id: employer })).statusCode).toBe(201);
    const row = (await post({ question: "工资多少", answer: "25元/小时", status: "disabled" })).json();
    expect(row.status).toBe("disabled");
    expect((await put(row.id, { status: "enabled" })).statusCode).toBe(422);
    expect((await put(row.id, { answer: "{wage}", status: "enabled" })).statusCode).toBe(200);
    expect((await put(row.id, { media: ["【图片:别家工资.jpg】"] })).statusCode).toBe(422);
    expect(app.db.prepare("SELECT answer,media FROM kb_faq WHERE id=?").get(row.id)).toMatchObject({ answer: "{wage}", media: "[]" });
  });

  it("audits old rows without modifying data, scopes the inventory, and requires admin", async () => {
    const id = Number(app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,question,answer) VALUES(1,'global','工资测试','23元/小时') RETURNING id").get()!.id);
    const alien = Number(app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,question,answer) VALUES(2,'global','不可见','99元/小时') RETURNING id").get()!.id);
    const before = JSON.stringify(app.db.prepare("SELECT * FROM kb_faq ORDER BY id").all());
    const audited = await app.inject({ method: "GET", url: "/api/v1/kb-faqs/audit", headers: admin });
    expect(audited.statusCode).toBe(200);
    expect(audited.json().items.some((item: { id: number }) => item.id === id)).toBe(true);
    expect(audited.json().items.some((item: { id: number }) => item.id === alien)).toBe(false);
    expect(JSON.stringify(app.db.prepare("SELECT * FROM kb_faq ORDER BY id").all())).toBe(before);
    expect((await app.inject({ method: "GET", url: "/api/v1/kb-faqs/audit", headers: customer })).statusCode).toBe(403);
    expect((await put(alien, { answer: "你好" })).statusCode).toBe(404);
  });

  it("can quarantine an old row even when its original target no longer exists", async () => {
    const id = Number(app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,question,answer) VALUES(1,'position','旧归属','25元/小时') RETURNING id").get()!.id);
    expect((await put(id, { status: "disabled" })).statusCode).toBe(200);
    expect(app.db.prepare("SELECT status,answer FROM kb_faq WHERE id=?").get(id)).toMatchObject({ status: "disabled", answer: "25元/小时" });
    expect((await put(id, { status: "enabled" })).statusCode).toBe(422);
  });

  it("imports only eligible template items, reports blocked content, and remains idempotent", async () => {
    const template = Number(app.db.prepare("INSERT INTO kb_template(code,name,vertical_code) VALUES ('audit-pack','审计模板','factory') RETURNING id").get()!.id);
    const insert = app.db.prepare("INSERT INTO kb_template_item(template_id,question,keywords,answer) VALUES(?,?,?,?)");
    insert.run(template, "测试安全工资", '["工资"]', "{wage}");
    insert.run(template, "测试固定工价", '["工资"]', "99元/小时");
    insert.run(template, "测试未知模板", "[]", "{training|考试后上岗}");
    const first = await app.inject({ method: "POST", url: "/api/v1/kb-templates/audit-pack/import", headers: admin });
    expect(first.json()).toMatchObject({ imported: 1, skipped: 0 });
    expect(first.json().blocked).toHaveLength(2);
    const second = await app.inject({ method: "POST", url: "/api/v1/kb-templates/audit-pack/import", headers: admin });
    expect(second.json()).toMatchObject({ imported: 0, skipped: 1 });
    expect(second.json().blocked).toHaveLength(2);
    expect(app.db.prepare("SELECT COUNT(*) n FROM kb_faq WHERE question LIKE '测试%'").get()).toMatchObject({ n: 1 });
  });
});

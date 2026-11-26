import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { messageCreatedEvent } from "../src/modules/messaging/stream-events.js";

describe("observed device outbound messages", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const saved = { ...process.env };
  const code = "pc-observe";
  const contact = "S:customer";
  const payload = { event_id: `${contact}:102`, contact_id: contact, nickname: "Customer", content: "An actual reply", sent_at: "2026-11-06T02:00:00Z" };
  const post = (action: string, body: object, headers = device) => app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/${action}`, headers, payload: body });
  const observe = (body: object = payload) => post("outbound", body);
  const count = (table: string) => Number((app.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE device_code=?`).get(code) as { n: number }).n);

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('Observer','enabled',?)").run(JSON.stringify({ device_code: code, observe_only: true }));
    const pair = await post("pair", {}, admin);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await post("heartbeat", { state: "online", account_id: "owner" });
  });
  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it("records an agent bubble without unread, automation or delivery side effects", async () => {
    const result = await observe();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "processed", created: true });
    expect(count("agent_messages")).toBe(1);
    expect(count("message_deliveries")).toBe(0);
    expect(count("bridge_commands")).toBe(0);
    expect(count("message_events")).toBe(0);
    expect(app.db.prepare("SELECT unread,last_msg,last_msg_at FROM agent_conversations WHERE device_code=?").get(code))
      .toMatchObject({ unread: 0, last_msg: payload.content, last_msg_at: "2026-11-06T02:00:00.000Z" });
    const messages = await app.inject({ url: `/api/v1/agent/messages?device_code=${code}&customer_id=${result.json().customer_id}`, headers: admin });
    expect(messages.json().items[0]).toMatchObject({ role: "agent", direction: "outbound", status: "sent", content: payload.content });
    expect(messageCreatedEvent(app.db, code, result.json().customer_id, result.json().source_event_id)?.event.data.message)
      .toMatchObject({ role: "agent", source: "bridge" });
  });

  it("allocates integer ids even when a group conversation stored a text customer_id", async () => {
    // 群聊会话历史把 customer_id 写成了群名（TEXT）：SQLite 的 MAX() 会取到它，
    // +1 退化成 1，新联系人插入撞 UNIQUE(device_code,customer_id) → 整条上报 500。
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES (?,?,?,?)")
      .run(code, "预约报名群", "预约报名群", "group:预约报名群");
    const first = await observe();
    expect(first.statusCode).toBe(200);
    const second = await observe({ ...payload, event_id: `${contact}:104`, contact_id: "S:another", nickname: "Another" });
    expect(second.statusCode).toBe(200);
    const ids = app.db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=?").all(code)
      .map((row) => (row as { customer_id: unknown }).customer_id);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("deduplicates event replay but preserves distinct messages with equal text", async () => {
    await observe();
    expect((await observe()).json()).toMatchObject({ status: "duplicate", created: false });
    expect((await observe({ ...payload, event_id: `${contact}:103` })).statusCode).toBe(200);
    expect(count("agent_messages")).toBe(2);
    expect((await observe({ ...payload, content: "changed" })).statusCode).toBe(409);
    expect((await observe({ ...payload, contact_id: "S:other" })).statusCode).toBe(409);
    expect((await observe({ ...payload, sent_at: "2026-11-06T03:00:00Z" })).statusCode).toBe(409);
    expect(count("agent_conversations")).toBe(1);
  });

  it("does not overwrite a newer conversation preview with delayed observations", async () => {
    await observe({ ...payload, event_id: "new", sent_at: "2026-11-06T04:00:00Z", content: "newest" });
    await observe();
    await post("inbound", { ...payload, event_id: "late-inbound", sent_at: "2026-11-06T03:00:00Z", content: "older inbound" });
    expect(app.db.prepare("SELECT last_msg,unread FROM agent_conversations WHERE device_code=?").get(code)).toMatchObject({ last_msg: "newest", unread: 1 });
  });

  it("requires device credentials, enabled device and online heartbeat", async () => {
    expect((await post("outbound", payload, {})).statusCode).toBe(401);
    expect((await post("outbound", payload, admin)).statusCode).toBe(401);
    await post("heartbeat", { state: "offline" });
    expect((await observe()).statusCode).toBe(409);
    await post("heartbeat", { state: "online", account_id: "owner" });
    app.db.prepare("UPDATE agent_devices SET status='disabled' WHERE json_extract(data_json,'$.device_code')=?").run(code);
    expect((await observe()).statusCode).toBe(403);
    expect(count("agent_messages")).toBe(0);
  });

  it.each([
    { ...payload, sent_at: "yesterday" }, { ...payload, sent_at: 123 },
    { ...payload, content: " " }, { ...payload, event_id: "" },
    { ...payload, sent_at: "2026-11-06T02:00:00" },
  ])("rejects malformed observations before writing", async body => {
    expect((await observe(body)).statusCode).toBe(422);
    expect(count("agent_messages")).toBe(0);
  });

  const manual = async () => {
    await post("inbound", { event_id: "seed", contact_id: contact, nickname: "Customer", content: "hello" });
    const customer = (app.db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=?").get(code) as { customer_id: number }).customer_id;
    const response = await app.inject({ method: "POST", url: `/api/v1/agent/conversations/${customer}/send`, headers: admin, payload: { device_code: code, content: payload.content } });
    expect(response.statusCode).toBe(202);
    return (await post("claim", {})).json().command;
  };
  const receipt = (command: { id: string; lease_token: string }, messageId = payload.event_id) => post("receipts", { command_id: command.id, lease_token: command.lease_token, status: "succeeded", message_id: messageId });

  it.each([true, false])("reconciles a manual reply with a real id, receipt first=%s", async receiptFirst => {
    const command = await manual();
    if (receiptFirst) expect((await receipt(command)).statusCode).toBe(200);
    expect((await observe()).statusCode).toBe(200);
    if (!receiptFirst) expect((await receipt(command)).statusCode).toBe(200);
    expect((await observe()).json().created).toBe(false);
    expect((await receipt(command)).statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE device_code=? AND direction='outbound'").get(code)).toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT status FROM agent_messages WHERE device_code=? AND direction='outbound'").get(code)).toMatchObject({ status: "sent" });
    expect(count("bridge_commands")).toBe(1);
    expect(count("message_deliveries")).toBe(1);
  });

  it("keeps a direct reply with identical text separate from an unrelated manual command", async () => {
    const command = await manual();
    await receipt(command, `${contact}:different-id`);
    await observe();
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE device_code=? AND direction='outbound'").get(code)).toMatchObject({ n: 2 });
  });

  it("preserves the greatest message id during reconciliation so after_id never misses the next message", async () => {
    const command = await manual();
    await observe();
    const cursor = (app.db.prepare("SELECT MAX(id) id FROM agent_messages").get() as { id: number }).id;
    await receipt(command);
    await observe({ ...payload, event_id: `${contact}:103`, content: "next" });
    const rows = app.db.prepare("SELECT content FROM agent_messages WHERE device_code=? AND id>?").all(code, cursor);
    expect(rows).toEqual([expect.objectContaining({ content: "next" })]);
  });

  it("keeps identical external event ids isolated by device", async () => {
    await observe();
    const otherCode = "pc-other";
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('Other','enabled',?)").run(JSON.stringify({ device_code: otherCode, observe_only: true }));
    const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${otherCode}/pair`, headers: admin });
    const headers = { authorization: `Bearer ${pair.json().device_token}` };
    await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${otherCode}/heartbeat`, headers, payload: { state: "online", account_id: "other-owner" } });
    const other = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${otherCode}/outbound`, headers, payload });
    expect(other.statusCode).toBe(200);
    const original = app.db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=?").get(code) as { customer_id: number };
    expect(other.json().customer_id).not.toBe(original.customer_id);
    expect(count("agent_messages")).toBe(1);
  });

  it("accepts normalized multiline database content without duplicating a manual reply", async () => {
    const multiline = { ...payload, content: "line one\r\nline two" };
    await post("inbound", { event_id: "seed", contact_id: contact, nickname: "Customer", content: "hello" });
    const customer = (app.db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=?").get(code) as { customer_id: number }).customer_id;
    await app.inject({ method: "POST", url: `/api/v1/agent/conversations/${customer}/send`, headers: admin, payload: { device_code: code, content: multiline.content } });
    const command = (await post("claim", {})).json().command;
    await observe({ ...multiline, content: "line one\nline two" });
    expect((await receipt(command)).statusCode).toBe(200);
    expect(count("agent_messages")).toBe(2);
  });

  it("rejects a receipt referencing another contact's observed message", async () => {
    const command = await manual();
    await observe({ ...payload, contact_id: "S:other" });
    expect((await receipt(command)).statusCode).toBe(409);
    expect(app.db.prepare("SELECT status FROM bridge_commands WHERE id=?").get(command.id)).toMatchObject({ status: "claimed" });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("bridge recovery visible to operators", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  let customerId: number;
  let updates: Array<Record<string, unknown>>;
  const saved = { ...process.env };
  const code = "pc-recovery";
  const contact = "S:recovery-contact";
  const post = (action: string, payload: object = {}, headers = device) => app.inject({
    method: "POST", url: `/api/v1/bridge/devices/${code}/${action}`, headers, payload,
  });
  const send = (content = "manual reply", key = "recovery-command") => app.inject({
    method: "POST", url: `/api/v1/agent/conversations/${customerId}/send`, headers: { ...admin, "idempotency-key": key },
    payload: { device_code: code, content },
  });
  const messages = () => app.inject({ url: `/api/v1/agent/messages?device_code=${code}&customer_id=${customerId}`, headers: admin });
  const conversation = () => app.db.prepare("SELECT last_msg,last_msg_at,unread FROM agent_conversations WHERE device_code=? AND customer_id=?").get(code, customerId);
  const outbound = () => app.db.prepare("SELECT status,created_at FROM agent_messages WHERE device_code=? AND direction='outbound'").get(code);
  const expire = (id: string) => app.db.prepare("UPDATE bridge_commands SET lease_until=0 WHERE id=?").run(id);
  const receipt = (command: { id: string; lease_token: string }) => post("receipts", {
    command_id: command.id, lease_token: command.lease_token, status: "succeeded", message_id: `${contact}:102`,
  });

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('Recovery','enabled',?)")
      .run(JSON.stringify({ device_code: code, observe_only: true }));
    device = { authorization: `Bearer ${(await post("pair", {}, admin)).json().device_token}` };
    await post("heartbeat", { state: "online", account_id: "test-owner" });
    customerId = (await post("inbound", { event_id: "seed", contact_id: contact, nickname: "Test contact", content: "hello" })).json().customer_id;
    updates = [];
    app.events.subscribe(code, frame => {
      if (frame.startsWith("event: command.updated\n")) updates.push(JSON.parse(/^data: (.+)$/m.exec(frame)![1]));
    }, () => {});
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it.each(["bridge", "messages", "conversations", "claim"])("settles expired claims on %s access, publishes once and accepts a late receipt", async endpoint => {
    await send();
    const command = (await post("claim")).json().command;
    expire(command.id);
    await post("heartbeat", { state: "offline" });
    const read = () => endpoint === "claim" ? post("claim") : app.inject({
      url: endpoint === "bridge" ? `/api/v1/bridge/devices/${code}` : `/api/v1/agent/${endpoint}?device_code=${code}&customer_id=${customerId}`,
      headers: admin,
    });
    expect((await read()).statusCode).toBe(200);
    expect(app.db.prepare("SELECT status,receipt_at FROM bridge_commands WHERE id=?").get(command.id)).toMatchObject({ status: "unknown", receipt_at: null });
    expect(outbound()).toMatchObject({ status: "unknown" });
    expect(app.db.prepare("SELECT status,next_retry_at FROM message_deliveries WHERE device_code=?").get(code)).toMatchObject({ status: "sending", next_retry_at: null });
    expect((await messages()).json().items.find((item: { direction: string }) => item.direction === "outbound").status).toBe("unknown");
    await read();
    expect(updates.filter(update => update.status === "unknown")).toEqual([
      expect.objectContaining({ command_id: command.id, customer_id: customerId, error: expect.any(String) }),
    ]);
    expect((await post("claim")).json().command).toBeNull();
    expect((await receipt(command)).statusCode).toBe(200);
    expect(outbound()).toMatchObject({ status: "sent" });
  });

  it("keeps expiration isolated to the requested device", async () => {
    await send();
    const command = (await post("claim")).json().command;
    expire(command.id);
    await app.inject({ url: "/api/v1/bridge/devices/local-device-001", headers: admin });
    expect(app.db.prepare("SELECT status FROM bridge_commands WHERE id=?").get(command.id)).toMatchObject({ status: "claimed" });
    expect(updates.filter(update => update.status === "unknown")).toHaveLength(0);
  });

  it("does not let unauthenticated reads or claims expire commands", async () => {
    await send();
    const command = (await post("claim")).json().command;
    expire(command.id);
    for (const url of [`/api/v1/bridge/devices/${code}`, `/api/v1/agent/messages?device_code=${code}`, `/api/v1/agent/conversations?device_code=${code}`]) {
      expect((await app.inject({ url })).statusCode).toBe(403);
    }
    expect((await post("claim", {}, {})).statusCode).toBe(401);
    expect(app.db.prepare("SELECT status FROM bridge_commands WHERE id=?").get(command.id)).toMatchObject({ status: "claimed" });
    expect(updates.filter(update => update.status === "unknown")).toHaveLength(0);
  });

  it("rolls back expiration on a storage failure and retries cleanly on the next poll", async () => {
    await send();
    const command = (await post("claim")).json().command;
    expire(command.id);
    app.db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE OF status ON agent_messages BEGIN SELECT RAISE(ABORT,'test disk failure'); END");
    expect((await messages()).statusCode).toBe(500);
    expect(app.db.prepare("SELECT status,receipt_at FROM bridge_commands WHERE id=?").get(command.id)).toMatchObject({ status: "claimed", receipt_at: null });
    expect(updates.filter(update => update.status === "unknown")).toHaveLength(0);
    app.db.exec("DROP TRIGGER reject_recovery");
    expect((await messages()).statusCode).toBe(200);
    expect(outbound()).toMatchObject({ status: "unknown" });
    expect(updates.filter(update => update.status === "unknown")).toHaveLength(1);
  });

  it("claims the next queued command after settling an expired command", async () => {
    await send();
    const original = (await post("claim")).json().command;
    expire(original.id);
    const next = await send("next reply", "next-command");
    const claimed = (await post("claim")).json().command;
    expect(claimed.id).toBe(next.json().command_id);
    expect(claimed.id).not.toBe(original.id);
    expect((await post("claim")).json().command).toBeNull();
  });

  it("updates queued and claimed messages when pairing rotates credentials", async () => {
    await send();
    const command = (await post("claim")).json().command;
    await send("not yet claimed", "queued-command");
    const pair = await post("pair", {}, admin);
    expect(pair.statusCode).toBe(200);
    expect((await post("claim")).statusCode).toBe(401);
    const rows = (await messages()).json().items.filter((item: { direction: string }) => item.direction === "outbound");
    expect(rows).toEqual([
      expect.objectContaining({ content: "manual reply", status: "unknown" }),
      expect.objectContaining({ content: "not yet claimed", status: "failed" }),
    ]);
    expect(app.db.prepare("SELECT content,status FROM message_deliveries WHERE device_code=? ORDER BY id").all(code)).toEqual([
      expect.objectContaining({ content: "manual reply", status: "sending" }),
      expect.objectContaining({ content: "not yet claimed", status: "failed" }),
    ]);
    expect(updates.filter(update => ["unknown", "failed"].includes(String(update.status)))).toHaveLength(2);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    expect((await receipt(command)).statusCode).toBe(200);
  });

  it("rolls back pairing and emits no terminal events if message state cannot be persisted", async () => {
    await send();
    await post("claim");
    app.db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE OF status ON agent_messages BEGIN SELECT RAISE(ABORT,'test disk failure'); END");
    expect((await post("pair", {}, admin)).statusCode).toBe(500);
    app.db.exec("DROP TRIGGER reject_recovery");
    expect((await post("heartbeat", { state: "online", account_id: "test-owner" })).statusCode).toBe(200);
    expect(outbound()).toMatchObject({ status: "queued" });
    expect(app.db.prepare("SELECT status FROM bridge_commands WHERE device_code=?").get(code)).toMatchObject({ status: "claimed" });
    expect(updates.filter(update => ["unknown", "failed"].includes(String(update.status)))).toHaveLength(0);
  });

  it.each(["queued", "succeeded", "unknown"])("does not promote an old %s manual message when the same request is replayed", async status => {
    await send();
    if (status !== "queued") {
      const command = (await post("claim")).json().command;
      if (status === "succeeded") await receipt(command);
      else await post("receipts", { command_id: command.id, lease_token: command.lease_token, status: "unknown" });
    }
    await post("inbound", { event_id: "newer", contact_id: contact, content: "new customer message", sent_at: "2099-01-01T00:00:00Z" });
    const before = conversation();
    await send();
    expect(conversation()).toEqual(before);
  });

  it.each([true, false])("uses the observed send time and preserves newer messages, receipt first=%s", async receiptFirst => {
    await send();
    const command = (await post("claim")).json().command;
    app.db.prepare("UPDATE agent_messages SET created_at='2026-01-01T00:00:00.000Z' WHERE device_code=?").run(code);
    await post("inbound", { event_id: "newer", contact_id: contact, content: "new customer message", sent_at: "2026-01-01T00:02:00Z" });
    if (receiptFirst) expect((await receipt(command)).statusCode).toBe(200);
    expect((await post("outbound", { event_id: `${contact}:102`, contact_id: contact, content: "manual reply", sent_at: "2026-01-01T00:01:00Z" })).statusCode).toBe(200);
    if (!receiptFirst) expect((await receipt(command)).statusCode).toBe(200);
    expect(outbound()).toMatchObject({ status: "sent", created_at: "2026-01-01T00:01:00.000Z" });
    expect(conversation()).toMatchObject({ last_msg: "new customer message", last_msg_at: "2026-01-01T00:02:00.000Z", unread: 2 });
    const before = conversation();
    expect((await receipt(command)).statusCode).toBe(200);
    expect(conversation()).toEqual(before);
  });
});

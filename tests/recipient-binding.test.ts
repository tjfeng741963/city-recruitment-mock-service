import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

describe("WeCom recipient binding", () => {
  const code = "local-device-001";
  const account = "1688858099955512";
  const first = `S:${account}_7881300461189233`;
  const second = `S:7881300468948765_${account}`;
  const url = `/api/v1/bridge/devices/${code}`;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  let firstId: number;
  let secondId: number;

  const send = (url: string, headers: Record<string, string>, payload?: object) =>
    app.inject({ method: "POST", url, headers, payload });
  const heartbeat = (account_id: string) =>
    send(`${url}/heartbeat`, device, { state: "online", account_id });
  const report = (conversation_id: string, status: string, remark?: string, account_id = account) =>
    send(`${url}/recipient-binding`, device, { account_id, conversation_id, status, remark });
  const issue = (id: number, headers = admin, deviceCode = code) =>
    send(`/api/v1/agent/conversations/${id}/recipient-binding?device_code=${deviceCode}`, headers);
  const config = async () =>
    (await app.inject({ method: "GET", url: `${url}/config`, headers: device })).json();
  const conversations = async () =>
    (await app.inject({ method: "GET", url: `/api/v1/agent/conversations?device_code=${code}`, headers: admin })).json().items;

  beforeEach(async () => {
    vi.stubEnv("REA_DATABASE_PATH", ":memory:");
    vi.stubEnv("REA_MESSAGE_CHANNEL_PROVIDER", "bridge");
    app = buildServer();
    await app.ready();
    const login = await send("/api/v1/auth/login", {}, { username: "local-admin", password: "local-demo-only" });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await send(`${url}/pair`, admin);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    expect((await heartbeat(account)).statusCode).toBe(200);
    for (const [index, cid] of [first, second].entries()) {
      const inbound = await send(`${url}/inbound`, device, {
        event_id: `same-name-${index}`, contact_id: cid, content: "你好", nickname: "1",
      });
      expect(inbound.statusCode).toBe(200);
      if (index === 0) firstId = inbound.json().customer_id;
      else secondId = inbound.json().customer_id;
    }
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("only issues a stable unique remark for reported conflicts and never queues a rename", async () => {
    expect(await config()).toMatchObject({ recipient_bindings_account_id: account, recipient_bindings: [] });
    expect((await issue(firstId)).statusCode).toBe(409);
    expect((await report(first, "conflict")).statusCode).toBe(200);
    expect((await report(second, "conflict")).statusCode).toBe(200);
    expect(await conversations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: firstId, nickname: "1", recipient_binding: { status: "conflict", remark: "" } }),
      expect.objectContaining({ customer_id: secondId, nickname: "1", recipient_binding: { status: "conflict", remark: "" } }),
    ]));

    const a = (await issue(firstId)).json();
    const b = (await issue(secondId)).json();
    expect(a).toMatchObject({ status: "awaiting", remark: expect.stringMatching(/^CR[0-9a-f]{16}$/) });
    expect(b.remark).not.toBe(a.remark);
    expect((await issue(firstId)).json()).toEqual(a);
    expect(await config()).toMatchObject({ recipient_bindings: expect.arrayContaining([
      { conversation_id: first, status: "awaiting", remark: a.remark },
      { conversation_id: second, status: "awaiting", remark: b.remark },
    ]) });
    expect(app.db.prepare("SELECT count(*) AS count FROM bridge_commands WHERE kind='set_remark'").get()?.count).toBe(0);
  });

  it("requires exact readback and a new remark after invalidation", async () => {
    await report(first, "conflict");
    const old = (await issue(firstId)).json().remark;
    expect((await report(first, "verified", "wrong")).statusCode).toBe(409);
    expect((await report(first, "needs_confirmation", old)).statusCode).toBe(409);
    expect((await report(first, "verified", old)).json()).toMatchObject({ status: "verified" });
    expect((await report(first, "conflict")).json()).toMatchObject({ status: "verified" });
    expect((await report(first, "needs_confirmation", old)).json()).toMatchObject({ status: "needs_confirmation" });
    expect((await report(first, "verified", old)).statusCode).toBe(409);
    const renewed = (await issue(firstId)).json().remark;
    expect(renewed).not.toBe(old);
    expect((await report(first, "verified", old)).statusCode).toBe(409);
    expect((await report(first, "verified", renewed)).json()).toMatchObject({ status: "verified" });
    expect((await report(first, "needs_confirmation", old)).statusCode).toBe(409);
  });

  it("does not accept a console send until the reported conflict is verified", async () => {
    const payload = { device_code: code, customer_id: firstId, content: "招聘回复" };
    const manualSend = () => send("/api/v1/agent/manual-reply", admin, payload);
    const detailSend = () => send(`/api/v1/agent/conversations/${firstId}/send`, admin, payload);
    await report(first, "conflict");
    expect((await detailSend()).statusCode).toBe(409);
    expect((await manualSend()).statusCode).toBe(409);
    const remark = (await issue(firstId)).json().remark;
    expect((await manualSend()).statusCode).toBe(409);
    expect((await report(first, "verified", remark)).statusCode).toBe(200);
    expect((await detailSend()).statusCode).toBe(202);
  });

  it("scope-checks reports and clears the served snapshot when the account changes", async () => {
    expect((await send(`${url}/recipient-binding`, admin, { account_id: account, conversation_id: first, status: "conflict" })).statusCode).toBe(401);
    expect((await issue(firstId, device)).statusCode).toBe(401);
    expect((await report(`S:${account}_999`, "conflict")).statusCode).toBe(404);
    expect((await report("R:123", "conflict")).statusCode).toBe(422);
    await report(first, "conflict");
    const a = (await issue(firstId)).json().remark;
    expect((await report(first, "verified", a, "other")).statusCode).toBe(409);
    expect((await heartbeat("other")).statusCode).toBe(200);
    expect(await config()).toMatchObject({ recipient_bindings_account_id: "other", recipient_bindings: [] });
    expect((await report(first, "verified", a)).statusCode).toBe(409);
    expect((await issue(firstId)).statusCode).toBe(409);
    const listed = (await conversations()).find((item: { customer_id: number }) => item.customer_id === firstId);
    expect(listed.recipient_binding).toBeUndefined();
    await heartbeat(account);
    expect(await config()).toMatchObject({ recipient_bindings: [{ conversation_id: first, status: "awaiting", remark: a }] });
  });
});

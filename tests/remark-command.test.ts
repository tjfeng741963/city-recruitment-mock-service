import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * 设置备注走的是 bridge_commands 队列。它和发消息共用一条队列，但**不该**跟
 * 发消息共用「发送就绪」这个门槛：改备注只是点通讯录，窗口黑掉/最小化时
 * 发送不可用，备注却仍然做得成。
 *
 * 2026-11-26 之前的实现把两者绑在一起，导致窗口一黑备注就永久卡在队列里，
 * 网页上点了没反应，也不报错。
 */
describe("remark command claim", () => {
  const code = "local-device-001";
  const account = "1688858099955512";
  const conversation = `S:${account}_7881300461189233`;
  const url = `/api/v1/bridge/devices/${code}`;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;

  const post = (path: string, headers: Record<string, string>, payload?: object) =>
    app.inject({ method: "POST", url: path, headers, payload });

  const enqueueRemark = (remark = "CR0123456789abcdef") =>
    post(`/api/v1/agent/devices/${code}/remark`, admin, {
      name: "青冥",
      remark,
      conversation_id: conversation,
    });

  const reportHealth = (ready: boolean, reason: string) =>
    post(`${url}/heartbeat`, device, {
      state: ready ? "online" : "offline",
      account_id: account,
      runtime: {
        wecom_available: true,
        reply_ready: ready,
        reason,
        sync: "current",
        backlog: 0,
      },
    });

  const claim = (only = "") =>
    post(`${url}/claim${only ? `?only=${encodeURIComponent(only)}` : ""}`, device);

  beforeEach(async () => {
    vi.stubEnv("REA_DATABASE_PATH", ":memory:");
    vi.stubEnv("REA_MESSAGE_CHANNEL_PROVIDER", "bridge");
    app = buildServer();
    await app.ready();
    const login = await post("/api/v1/auth/login", {}, { username: "local-admin", password: "local-demo-only" });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await post(`${url}/pair`, admin);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await reportHealth(true, "ready");
    const inbound = await post(`${url}/inbound`, device, {
      event_id: "remark-claim-1",
      contact_id: conversation,
      content: "你好",
      nickname: "青冥",
    });
    expect(inbound.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("hands a queued remark to the device even when sending is not ready", async () => {
    expect((await enqueueRemark()).statusCode).toBe(200);

    await reportHealth(false, "desktop_unavailable");

    const got = await claim("set_remark");
    expect(got.statusCode).toBe(200);
    expect(got.json().command).toMatchObject({ kind: "set_remark" });
    expect(got.json().command.content).toContain("CR0123456789abcdef");
  });

  it("still refuses every other command while sending is not ready", async () => {
    expect((await enqueueRemark()).statusCode).toBe(200);

    await reportHealth(false, "desktop_unavailable");

    // 不带 only 的领取会碰消息队列，发送未就绪时必须返回空，不能把备注顶出去
    const plain = await claim();
    expect(plain.statusCode).toBe(200);
    expect(plain.json().command).toBeNull();
  });

  it("keeps the remark queued instead of failing it when the desktop is down", async () => {
    expect((await enqueueRemark()).statusCode).toBe(200);
    await reportHealth(false, "desktop_unavailable");

    expect((await claim()).json().command).toBeNull();

    // 恢复发送能力后，那条备注还在队列里等着，没有被标成失败
    await reportHealth(true, "ready");
    const got = await claim("set_remark");
    expect(got.json().command).toMatchObject({ kind: "set_remark" });
  });
});

/**
 * 回执环节（2026-11-27 修复）。
 *
 * 备注不产生客户消息，回执没有 message_id。原实现只豁免了刷新二维码，
 * set_remark 成功回执被 422 拒掉，指令留在 claimed，60 秒租约过期后变 failed——
 * 界面上看是「备注全失败」，其实操作成功了；失败时又走了消息链路，error 没落库。
 */
describe("remark command receipt", () => {
  const code = "local-device-001";
  const account = "1688858099955512";
  const conversation = `S:${account}_7881300461189233`;
  const url = `/api/v1/bridge/devices/${code}`;
  let app: FastifyInstance;
  let dbPath: string;
  let admin: Record<string, string>;
  let device: Record<string, string>;

  const post = (path: string, headers: Record<string, string>, payload?: object) =>
    app.inject({ method: "POST", url: path, headers, payload });

  const claimRemark = async () => {
    const res = await post(`${url}/claim?only=set_remark`, device);
    return res.json().command as { id: string; lease_token: string };
  };

  const receipt = (command: { id: string; lease_token: string }, body: object) =>
    post(`${url}/receipts`, device, { command_id: command.id, lease_token: command.lease_token, ...body });

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "remark-receipt-"));
    dbPath = join(dir, "app.sqlite");
    vi.stubEnv("REA_DATABASE_PATH", dbPath);
    vi.stubEnv("REA_MESSAGE_CHANNEL_PROVIDER", "bridge");
    app = buildServer();
    await app.ready();
    const login = await post("/api/v1/auth/login", {}, { username: "local-admin", password: "local-demo-only" });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await post(`${url}/pair`, admin);
    device = { authorization: `Bearer ${pair.json().device_token}` };
    await post(`${url}/heartbeat`, device, {
      state: "online", account_id: account,
      runtime: { wecom_available: true, reply_ready: true, reason: "ready", sync: "current", backlog: 0 },
    });
    await post(`${url}/inbound`, device, {
      event_id: "remark-receipt-1", contact_id: conversation, content: "你好", nickname: "青冥",
    });
    const queued = await post(`/api/v1/agent/devices/${code}/remark`, admin, {
      name: "青冥", remark: "CR0123456789abcdef", conversation_id: conversation,
    });
    expect(queued.statusCode, queued.body).toBe(200);
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("accepts a successful receipt that has no message id", async () => {
    const command = await claimRemark();
    const res = await receipt(command, { status: "succeeded", message_id: "" });
    expect(res.statusCode).toBe(200);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT status FROM bridge_commands WHERE id=?").get(command.id) as { status: string };
    db.close();
    expect(row.status).toBe("succeeded");
  });

  it("records the failure reason so the console can show it", async () => {
    const command = await claimRemark();
    const detail = "已操作界面但库里备注仍是「空」，请人工确认";
    expect((await receipt(command, { status: "failed", error: detail })).statusCode).toBe(200);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT status,error FROM bridge_commands WHERE id=?").get(command.id) as { status: string; error: string };
    db.close();
    expect(row.status).toBe("failed");
    expect(row.error).toBe(detail);
  });
});

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * 心跳带客户端版本（068）。
 *
 * 2026-11-26 现场：看板上分不清「已更新」和「以为更新了」，只能 SSH 上机器翻
 * .client-version.json。心跳带上 commit 后，设备列表直接显示版本。
 */
describe("device client commit", () => {
  const code = "local-device-001";
  const account = "1688858099955512";
  const commit = "8d77436b156c786b3854a0ac9100c2a88e740f3a";
  const url = `/api/v1/bridge/devices/${code}`;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;

  const post = (path: string, headers: Record<string, string>, payload?: object) =>
    app.inject({ method: "POST", url: path, headers, payload });

  const heartbeat = (payload: Record<string, unknown>) =>
    post(`${url}/heartbeat`, device, { state: "online", account_id: account, ...payload });

  const devices = async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: admin });
    return res.json().items as Array<Record<string, unknown>>;
  };
  const current = async () => (await devices()).find((row) => row.device_code === code) ?? {};

  beforeEach(async () => {
    vi.stubEnv("REA_DATABASE_PATH", ":memory:");
    vi.stubEnv("REA_MESSAGE_CHANNEL_PROVIDER", "bridge");
    app = buildServer();
    await app.ready();
    const login = await post("/api/v1/auth/login", {}, { username: "local-admin", password: "local-demo-only" });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await post(`${url}/pair`, admin);
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("exposes the commit the client reports", async () => {
    expect((await heartbeat({ commit })).statusCode).toBe(200);
    expect((await current()).client_commit).toBe(commit);
  });

  it("keeps the last known commit when an older client omits the field", async () => {
    await heartbeat({ commit });
    // 旧版客户端心跳不带 commit，不能把已知版本抹成空
    await heartbeat({});
    expect((await current()).client_commit).toBe(commit);
  });

  it("reports an empty commit for a client that never sent one", async () => {
    await heartbeat({});
    expect((await current()).client_commit).toBe("");
  });
});

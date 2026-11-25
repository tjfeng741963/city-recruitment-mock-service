import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

let app: FastifyInstance;
let admin: Record<string, string>;
let recruiter: Record<string, string>;
const poolCode = "pool-win-01";
const customer = "AG-CLOUD-CUSTOMER";
const other = "AG-CLOUD-OTHER";
const base = "/api/v1/agent/cloud-agent";
const pool = `/api/v1/bridge/devices/${poolCode}/cloud-assignment`;
const assignment = (code: string) => `${base}/${code}`;

beforeEach(async () => {
  vi.stubEnv("REA_DATABASE_PATH", ":memory:");
  vi.stubEnv("REA_CLOUD_AGENT_POOL", poolCode);
  vi.stubEnv("REA_AGENT_SETTINGS_HTTPS_ORIGIN", "https://recruitment.example");
  app = buildServer();
  await app.ready();
  app.db.prepare("INSERT INTO users(username,password_hash,role) SELECT 'cloud-recruiter',password_hash,'recruiter' FROM users WHERE username='local-admin'").run();
  const user = app.db.prepare("SELECT id FROM users WHERE username='cloud-recruiter'").get()!;
  app.db.prepare("INSERT INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?,'device',?)").run(user.id, customer);
  async function login(username: string) {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } });
    expect(response.statusCode).toBe(200);
    return { authorization: `Bearer ${response.json().access_token}` };
  }
  admin = await login("local-admin");
  recruiter = await login("cloud-recruiter");
  for (const code of [customer, other, poolCode]) {
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: admin,
      payload: { device_code: code, device_name: `Name for ${code}`, group_chat: "original-group" } })).statusCode).toBe(200);
  }
});

afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

it("allows a scoped request once and restricts the pool to administrators", async () => {
  const request = (code: string) => app.inject({ method: "POST", url: assignment(code), headers: recruiter });
  expect((await request(other)).statusCode).toBe(404);
  expect((await request(customer)).json()).toEqual({ state: "requested" });
  expect((await request(customer)).json()).toEqual({ state: "requested" });
  const rows = (await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: recruiter })).json().items;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ device_code: customer, cloud_assignment: { state: "requested" } });
  expect((await app.inject({ method: "GET", url: `${base}/machines`, headers: recruiter })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: `${base}/machines`, headers: admin })).json()).toEqual({ items: [] });
});

it("reserves an online machine once and completes only on the assigned credential's heartbeat", async () => {
  const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${poolCode}/pair`, headers: admin });
  expect(pair.statusCode).toBe(200);
  const machineToken = pair.json().device_token;
  const listener = createServer((req, res) => app.routing(req, res));
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as AddressInfo).port;
  vi.stubEnv("REA_AGENT_SETTINGS_PORT", String(port));
  const forwarded = { host: "recruitment.example", "x-forwarded-proto": "https", authorization: `Bearer ${machineToken}` };
  const securePost = (path: string, token: string, payload?: object) => new Promise<any>((resolve, reject) => {
    const headers = { ...forwarded, authorization: `Bearer ${token}`, ...(payload && { "content-type": "application/json" }) };
    const req = request(`http://127.0.0.1:${port}${path}`, { method: "POST", headers }, response => {
      response.setEncoding("utf8");
      let raw = "";
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, body: JSON.parse(raw) });
      });
    });
    req.on("error", reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
  const poll = async () => {
    const response = await securePost(pool, machineToken);
    expect(response.statusCode).toBe(200);
    return response.body;
  };
  const assign = (code: string) => app.inject({ method: "PUT", url: assignment(code), headers: admin, payload: { machine_code: poolCode } });
  try {
    expect((await app.inject({ method: "POST", url: pool, headers: forwarded })).statusCode).toBe(403);
    for (const code of [customer, other]) await app.inject({ method: "POST", url: assignment(code), headers: admin });
    expect((await assign(customer)).statusCode).toBe(409);
    expect(await poll()).toEqual({ assignment: null });
    expect((await assign(customer)).json()).toMatchObject({ state: "assigning" });
    expect((await assign(other)).statusCode).toBe(409);
    const first = await poll();
    expect(first.assignment).toMatchObject({ device_code: customer });
    expect(await poll()).toEqual(first);
    for (const code of [poolCode, customer]) {
      expect((await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/pair`, headers: admin })).statusCode).toBe(409);
      vi.stubEnv("REA_REGISTER_KEY", "local-registration-key");
      expect((await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/register`,
        headers: { "x-register-key": "local-registration-key" } })).statusCode).toBe(409);
    }
    const status = async () => (await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: recruiter })).json().items[0].cloud_assignment.state;
    expect(await status()).toBe("assigning");
    const heartbeat = `/api/v1/bridge/devices/${customer}/heartbeat`;
    const token = first.assignment.bridge_token;
    const runtime = { wecom_available: false, reply_ready: false, reason: "wechat_login", sync: "unknown", backlog: 0 };
    expect((await app.inject({ method: "POST", url: heartbeat,
      headers: { ...forwarded, authorization: `Bearer ${token}` }, payload: { state: "scanning", runtime } })).statusCode).toBe(403);
    expect((await securePost(heartbeat, token, { state: "scanning" })).statusCode).toBe(422);
    expect((await securePost(heartbeat, token, { state: "scanning", runtime: {} })).statusCode).toBe(422);
    expect((await securePost(heartbeat, token, { state: "offline", runtime })).statusCode).toBe(200);
    expect(await status()).toBe("assigning");
    expect((await securePost(heartbeat, token, { state: "scanning", runtime })).statusCode).toBe(200);
    expect(await status()).toBe("connected");
    expect((await securePost(heartbeat, token, { state: "online", account_id: "test-wecom", runtime: {
      ...runtime, wecom_available: true, reply_ready: true, reason: "ready",
    } })).statusCode).toBe(200);
    const row = (await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: recruiter })).json().items[0];
    expect(row.windows_runtime).toMatchObject({ connected: true, reply_ready: false });
    expect((await app.inject({ method: "POST", url: `/api/v1/agent/devices/${customer}/login-qr/refresh`, headers: recruiter })).statusCode).toBe(409);
    expect(await poll()).toEqual({ assignment: null });
    const data = app.db.prepare("SELECT device_name,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(customer)!;
    expect(data.device_name).toBe(`Name for ${customer}`);
    expect(JSON.parse(String(data.data_json)).group_chat).toBe("original-group");
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
});

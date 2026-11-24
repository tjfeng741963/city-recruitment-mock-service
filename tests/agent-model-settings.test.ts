import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/server.js";
import { providerRequest } from "../src/modules/agent/agent-model-transport.js";

vi.mock("../src/modules/agent/agent-model-transport.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/modules/agent/agent-model-transport.js")>(),
  providerRequest: vi.fn(),
}));

let app: ReturnType<typeof buildServer>;
let headers: { authorization: string };
const endpoint = "/api/v1/settings/agent/model";
const draft = { base_url: "https://models.example/v1", api_key: "synthetic-provider-key", model: "fixture-chat", revision: 0 };
const message = { content: JSON.stringify({ messages: [{ type: "text", content: "配置已接通" }] }) };

beforeEach(async () => {
  vi.stubEnv("REA_DATABASE_PATH", ":memory:");
  vi.stubEnv("AGENT_LLM_API_KEY", "existing-fixture");
  vi.stubEnv("AGENT_LLM_CONFIG_SECRET", "a separate synthetic configuration encryption secret");
  vi.mocked(providerRequest).mockReset();
  app = buildServer();
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login",
    payload: { username: "local-admin", password: "local-demo-only" } });
  headers = { authorization: "Bearer " + login.json().access_token };
});

afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

const testDraft = () => app.inject({ method: "POST", url: endpoint + "/test", headers, payload: draft });
const save = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: endpoint, headers, payload });

it("discovers unique model IDs and protects the settings endpoints", async () => {
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login",
    payload: { username: "local-customer", password: "local-demo-only" } });
  const denied = await app.inject({ method: "GET", url: endpoint,
    headers: { authorization: "Bearer " + login.json().access_token } });
  expect(denied.statusCode).toBe(403);
  vi.mocked(providerRequest).mockResolvedValue({ data: [{ id: "fixture-chat" }, { id: "other" }, { id: "fixture-chat" }, {}] });
  const found = await app.inject({ method: "POST", url: endpoint + "/models", headers, payload: draft });
  expect(found.statusCode).toBe(200);
  expect(found.json()).toEqual({ models: ["fixture-chat", "other"] });
  expect(providerRequest).toHaveBeenCalledWith(draft.base_url, draft.api_key, "models", expect.any(Number));
});

it("activates only the tested draft and uses it for the real Agent chat route", async () => {
  vi.mocked(providerRequest).mockResolvedValue({ model: draft.model, choices: [{ message }] });
  expect((await save(draft)).statusCode).toBe(409);
  const checked = await testDraft();
  expect(checked.statusCode).toBe(200);
  const { test_id } = checked.json();
  expect((await save({ ...draft, model: "other", test_id })).statusCode).toBe(409);

  const saved = await save({ ...draft, test_id });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ model: draft.model, source: "settings", revision: 1, key_configured: true });
  expect(saved.payload).not.toContain(draft.api_key);
  expect(JSON.stringify(app.db.prepare("SELECT * FROM agent_model_settings").get())).not.toContain(draft.api_key);
  expect((await save({ ...draft, test_id })).statusCode).toBe(409);

  const position = app.db.prepare("INSERT INTO service_positions(position_name,status,data_json) VALUES ('测试岗位','enabled','{}') RETURNING id").get()!;
  const chat = await app.inject({ method: "POST", url: "/api/v1/agent/chat", headers,
    payload: { position_id: position.id, session_key: "S:settings-fixture", text: "你好" } });
  expect(chat.json()).toMatchObject({ ok: true, model: draft.model });
  expect(providerRequest).toHaveBeenLastCalledWith(draft.base_url, draft.api_key, "chat/completions", expect.any(Number),
    expect.objectContaining({ model: draft.model }));
});

it("rejects private destinations, reasoning replies and browser submissions over plain HTTP", async () => {
  const badUrl = await app.inject({ method: "POST", url: endpoint + "/models", headers,
    payload: { ...draft, base_url: "https://127.0.0.1/v1" } });
  expect(badUrl.statusCode).toBe(422);
  const insecure = await app.inject({ method: "POST", url: endpoint + "/models",
    headers: { ...headers, origin: "http://production.example:4222" }, payload: draft });
  expect(insecure.statusCode).toBe(400);
  const fakeHost = await app.inject({ method: "POST", url: endpoint + "/models", remoteAddress: "192.0.2.10",
    headers: { ...headers, host: "localhost" }, payload: draft });
  expect(fakeHost.statusCode).toBe(400);
  const forbidden = await app.inject({ method: "POST", url: endpoint + "/test", headers,
    payload: { ...draft, model: "glm-z1-flash" } });
  expect(forbidden.statusCode).toBe(422);
  expect(providerRequest).not.toHaveBeenCalled();
  vi.mocked(providerRequest).mockResolvedValue({ choices: [{ message: { ...message, reasoning_content: "reasoning" } }] });
  expect((await testDraft()).statusCode).toBe(422);
  vi.mocked(providerRequest).mockResolvedValue({ choices: [{ message: { content: "<think>reasoning</think>" + message.content } }] });
  expect((await testDraft()).statusCode).toBe(422);
});

it("lets multiple administrators use the same HTTPS gateway and rejects forged headers at the HTTP listener", async () => {
  vi.stubEnv("REA_AGENT_SETTINGS_HTTPS_ORIGIN", "https://recruitment.example");
  const credentials = { ...draft, api_key: "replacement-synthetic-key" };
  vi.mocked(providerRequest).mockResolvedValue({ model: draft.model, choices: [{ message }] });
  const secureHeaders = { ...headers, host: "recruitment.example", origin: "https://recruitment.example",
    "x-forwarded-proto": "https" };
  const gatewayListener = createServer((request, response) => app.routing(request, response));
  await new Promise<void>(resolve => gatewayListener.listen(0, "127.0.0.1", resolve));
  const port = (gatewayListener.address() as AddressInfo).port;
  vi.stubEnv("REA_AGENT_SETTINGS_PORT", String(port));
  const send = (authHeaders: Record<string, string>, action = "/test", payload = credentials) =>
    new Promise<{ status: number; body: { test_id: string } }>((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = request(`http://127.0.0.1:${port}${endpoint}${action}`, {
        method: action ? "POST" : "PUT",
        headers: { ...authHeaders, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
        response.on("error", reject);
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    const rejected = await app.inject({ method: "POST", url: endpoint + "/test", headers: secureHeaders, payload: credentials });
    expect(rejected.statusCode).toBe(400);
    expect((await send({ ...secureHeaders, origin: "https://elsewhere.example" })).status).toBe(400);
    expect(vi.mocked(providerRequest)).not.toHaveBeenCalled();

    const adminTest = await send(secureHeaders);
    expect(adminTest.status).toBe(200);
    const { test_id } = adminTest.body;
    app.db.prepare("INSERT INTO users(username,password_hash,role) SELECT 'other-model-admin',password_hash,'admin' FROM users WHERE username='local-admin'").run();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login",
      payload: { username: "other-model-admin", password: "local-demo-only" } });
    expect(login.statusCode).toBe(200);
    const other = { ...secureHeaders, authorization: "Bearer " + login.json().access_token };
    expect((await send(other, "", { ...credentials, test_id })).status).toBe(409);
    const otherTest = await send(other);
    expect(otherTest.status).toBe(200);
    expect((await send(other, "", { ...credentials, test_id: otherTest.body.test_id })).status).toBe(200);
    const status = await app.inject({ method: "GET", url: endpoint, headers });
    expect(status.json()).toMatchObject({ revision: 1, settings_https_url: "https://recruitment.example/settings" });
  } finally {
    await new Promise<void>(resolve => gatewayListener.close(() => resolve()));
  }
});

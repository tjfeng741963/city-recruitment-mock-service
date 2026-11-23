import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

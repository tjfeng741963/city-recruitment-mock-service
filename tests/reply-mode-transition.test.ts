import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { DeviceBridgeStore } from "../src/modules/messaging/device-bridge.js";

let app: ReturnType<typeof buildServer>;
afterEach(async () => { await app?.close(); delete process.env.REA_DATABASE_PATH; delete process.env.REA_DIFY_BASE_URL; delete process.env.REA_DIFY_API_KEY; });

it("persists an acknowledged two-way transition and rejects stale receipts", async () => {
  process.env.REA_DATABASE_PATH = ":memory:";
  process.env.REA_DIFY_BASE_URL = "https://example.test";
  process.env.REA_DIFY_API_KEY = "fixture";
  app = buildServer();
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
  const admin = { authorization: "Bearer " + login.json().access_token };
  const code = "switch-fixture";
  app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)")
    .run(code, JSON.stringify({ device_code: code, position_id: 1, agent_position_id: 2, factory_ids: [1, 2] }));
  const store = new DeviceBridgeStore(app.db);
  const device = { authorization: "Bearer " + store.pair(code) };
  const control = (payload: Record<string, unknown>, headers = device) => app.inject({ method: "POST", url: "/api/v1/bridge/devices/" + code + "/reply-mode", headers, payload });
  const change = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/agent/devices/" + code + "/reply-mode", headers: admin, payload });
  const account = async () => (await app.inject({ url: "/api/v1/agent/devices", headers: admin })).json().items
    .find((item: { device_code: string }) => item.device_code === code);
  expect((await change({ provider: "dify" })).statusCode).toBe(409);
  expect((await control({ wecom_online: true })).statusCode).toBe(200);
  const first = (await change({ provider: "dify" })).json();
  expect(first).toMatchObject({ phase: "waiting", effective: "agent", target: "dify" });
  expect((await change({ provider: "dify" })).json().id).toBe(first.id);
  expect((await control({ id: first.id, step: "prepared", wecom_online: true }, admin)).statusCode).toBe(403);
  expect((await control({ id: first.id, step: "prepared", wecom_online: false })).json()).toMatchObject({ phase: "waiting", issue: "wechat" });
  const pendingChat = await app.inject({ method: "POST", url: "/api/v1/agent/chat", headers: device, payload: { device_code: code, text: "测试" } });
  expect(pendingChat.json()).toMatchObject({ ok: false, code: "reply_mode_pending" });
  expect((await control({ id: first.id, step: "prepared", wecom_online: true })).json()).toMatchObject({ phase: "applying", effective: "agent" });
  expect(await account()).toMatchObject({ reply_provider: "agent", position_id: 2, factory_ids: [2] });
  expect((await control({ id: first.id, step: "applied", provider: "agent", wecom_online: true })).statusCode).toBe(409);
  expect((await control({ id: first.id, step: "applied", provider: "dify", wecom_online: true })).json()).toMatchObject({ phase: "completed", effective: "dify" });
  expect(await account()).toMatchObject({ reply_provider: "dify", position_id: 1, factory_ids: [1, 2] });
  const second = (await change({ provider: "agent" })).json();
  expect(second).toMatchObject({ phase: "waiting", effective: "dify", target: "agent" });
  expect((await control({ id: first.id, step: "applied", provider: "dify", wecom_online: true })).statusCode).toBe(409);
  expect((await control({ id: second.id, step: "prepared", wecom_online: true })).json().phase).toBe("applying");
  expect(await account()).toMatchObject({ reply_provider: "dify", position_id: 1, factory_ids: [1, 2] });
  expect((await app.inject({ url: "/api/v1/agent/flow?device_code=" + code, headers: device })).json().position_id).toBe(2);
  expect((await control({ id: second.id, step: "applied", provider: "agent", wecom_online: true })).json()).toMatchObject({ phase: "completed", effective: "agent" });
  expect(await account()).toMatchObject({ reply_provider: "agent", position_id: 2, factory_ids: [2] });
  expect((await control({ id: second.id, step: "applied", provider: "agent", wecom_online: true })).json().phase).toBe("completed");
  const third = (await change({ provider: "dify" })).json();
  expect((await control({ id: third.id, step: "prepared", wecom_online: true })).json().phase).toBe("applying");
  const undo = (await change({ cancel: true, id: third.id })).json();
  expect(undo).toMatchObject({ phase: "waiting", effective: "agent", target: "agent", rollback: true });
  expect(undo.id).not.toBe(third.id);
  expect((await change({ cancel: true, id: third.id })).json().id).toBe(undo.id);
  expect((await control({ id: third.id, step: "applied", provider: "dify", wecom_online: true })).statusCode).toBe(409);
  expect((await control({ id: undo.id, step: "prepared", wecom_online: true })).json().phase).toBe("applying");
  expect((await control({ id: undo.id, step: "applied", provider: "agent", wecom_online: true })).json()).toMatchObject({ phase: "cancelled", effective: "agent", generation: second.id });
});

it("mounts the actual mode switch in the account table with both options", () => {
  const page = readFileSync("frontend-vue/src/views/AgentDeviceView.vue", "utf8");
  const control = readFileSync("frontend-vue/src/components/agent/ReplyModeSwitch.vue", "utf8");
  const location = page.indexOf("<ReplyModeSwitch");
  expect(location).toBeGreaterThan(page.indexOf('label="回复来源" width='));
  expect(location).toBeLessThan(page.indexOf('label="负责人" min-width='));
  expect(page.match(/<ReplyModeSwitch\b/g)).toHaveLength(1);
  expect(control.includes("<el-select")).toBe(true);
  expect(control.includes('value="agent"')).toBe(true);
  expect(control.includes('value="dify"')).toBe(true);
  expect(control.includes("devicesApi.requestReplyMode")).toBe(true);
});

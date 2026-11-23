import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("device position binding", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it("replaces a stale position when the bound factory changes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "position-device", factory_ids: [1] },
    });
    expect(created.statusCode).toBe(200);
    const id = Number(created.json().id);
    expect(JSON.parse(created.json().data_json)).toMatchObject({ factory_ids: [1], position_id: 1 });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/agent/devices/${id}`,
      headers: admin,
      payload: { factory_ids: [2] },
    });
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.json().data_json)).toMatchObject({ factory_ids: [2], position_id: 2 });

    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/position-device/pair", headers: admin });
    const device = { authorization: `Bearer ${pair.json().device_token}` };
    const flow = await app.inject({ method: "GET", url: "/api/v1/agent/flow?device_code=position-device", headers: device });
    expect(flow.statusCode).toBe(200);
    expect(flow.json().position_id).toBe(2);
  });

  it("rejects an explicitly selected position from another factory", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agent/devices",
      headers: admin,
      payload: { device_code: "position-device-2", factory_ids: [1], position_id: 2 },
    });
    expect(created.statusCode).toBe(422);
    expect(created.json().detail).toContain("绑定岗位必须属于已绑定工厂");
  });

  it("keeps Agent on one position across the account list, saved settings and device replies", async () => {
    const code = "single-position-device";
    const row = app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?) RETURNING id")
      .get(code, JSON.stringify({ device_code: code, position_id: 1, factory_ids: [1, 2] }))!;
    const accounts = async () => (await app.inject({ url: "/api/v1/agent/devices", headers: admin })).json().items
      .find((item: { device_code: string }) => item.device_code === code);
    expect(await accounts()).toMatchObject({ reply_provider: "agent", position_id: 1, factory_ids: [1] });

    const update = (payload: object) => app.inject({
      method: "PUT", url: `/api/v1/agent/devices/${row.id}`, headers: admin, payload,
    });
    expect((await update({ factory_ids: [1, 2] })).statusCode).toBe(422);
    expect((await update({ position_id: 2, expected_reply_provider: "dify" })).statusCode).toBe(409);
    const next = app.db.prepare("INSERT INTO service_positions(position_name,status) VALUES ('单岗测试','enabled') RETURNING id").get()!;
    expect((await update({ position_id: next.id })).statusCode).toBe(200);
    expect(await accounts()).toMatchObject({ reply_provider: "agent", position_id: next.id, factory_ids: [] });
    const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/pair`, headers: admin });
    const token = { authorization: `Bearer ${pair.json().device_token}` };
    const scripts = app.db.prepare("INSERT INTO position_scripts(position_id,stage,title,content) VALUES (?,'greet','示例','话术')");
    for (const positionId of [0, 1, Number(next.id)]) scripts.run(positionId);
    const config = await app.inject({ url: `/api/v1/bridge/devices/${code}/config`, headers: token });
    expect(config.json()).toMatchObject({ position_id: next.id, factory_ids: [] });
    expect(config.json().position_scripts.map((script: { position_id: number }) => script.position_id)).toEqual([0, next.id]);
    const flow = await app.inject({ url: `/api/v1/agent/flow?device_code=${code}`, headers: token });
    expect(flow.json().position_id).toBe(next.id);
    const opening = await app.inject({ url: `/api/v1/agent/opening?device_code=${code}`, headers: token });
    expect(opening.json().position_id).toBe(next.id);
    const chat = (payload: object) => app.inject({
      method: "POST", url: "/api/v1/agent/chat", headers: token,
      payload: { device_code: code, text: "你好", dry: true, ...payload },
    });
    expect((await chat({})).json().position_id).toBe(next.id);
    expect((await chat({ position_id: 2 })).statusCode).toBe(409);
    expect((await chat({ device_code: "", position_id: 2 })).statusCode).toBe(403);

    const stored = app.db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(Number(row.id))!;
    expect(JSON.parse(String(stored.data_json))).toMatchObject({ position_id: 1, factory_ids: [1, 2] });
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.reply_provider','dify') WHERE id=?").run(Number(row.id));
    expect(await accounts()).toMatchObject({ reply_provider: "dify", position_id: 1, factory_ids: [1, 2] });
    expect((await update({ position_id: 2, factory_ids: [1, 2] })).statusCode).toBe(200);
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.reply_provider','agent') WHERE id=?").run(Number(row.id));
    expect(await accounts()).toMatchObject({ reply_provider: "agent", position_id: next.id, factory_ids: [] });
  });
});

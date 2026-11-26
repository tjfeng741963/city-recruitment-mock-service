import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { restoreLegacyFlowOpenings } from "../src/modules/agent/shared-opening.js";

describe("shared Agent opening", () => {
  let app: FastifyInstance;
  let admin: { authorization: string };
  let device: { authorization: string };
  let positionId: number;

  beforeEach(async () => {
    vi.stubEnv("REA_DATABASE_PATH", ":memory:");
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    positionId = Number(app.db.prepare("INSERT INTO service_positions(position_name) VALUES ('共享开场测试')").run().lastInsertRowid);
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.agent_position_id',?) WHERE json_extract(data_json,'$.device_code')='local-device-001'").run(positionId);
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const canvas = async () => (await app.inject({ url: `/api/v1/agent-flow?position_id=${positionId}`, headers: admin })).json();
  const persona = async () => (await app.inject({ url: `/api/v1/agent-persona?position_id=${positionId}`, headers: admin })).json();
  const upsert = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/v1/agent-flow", headers: admin, payload });
  const pull = async (route: "opening" | "flow", query = "") =>
    (await app.inject({ url: `/api/v1/agent/${route}?device_code=local-device-001${query}`, headers: device })).json();

  function runOpeningUpgrade() {
    app.db.exec(`DROP TRIGGER shared_opening_insert;
      DROP TRIGGER shared_opening_update;
      DROP TRIGGER shared_opening_delete;
      DELETE FROM schema_migrations WHERE version=65;`);
    migrateDatabase(app.db);
  }

  const seed = async (status: string, words: string[]) => {
    for (const content of words) {
      const result = await app.inject({ method: "POST", url: "/api/v1/agent-opening", headers: admin,
        payload: { position_id: positionId, kind: "text", content, delay_ms: 2000 } });
      expect(result.statusCode).toBe(200);
    }
    const nodes = words.map((body, index) => ({ node_key: `n${index}`, node_type: "text",
      parts: [{ kind: "text", body, delay_ms: status === "enabled" ? 2000 : 0 }],
      await_reply: index === words.length - 1, wait_minutes: 10 }));
    const saved = await upsert({ position_id: positionId, status, entry_key: "n0", nodes,
      edges: nodes.map((node, index) => ({ from_key: node.node_key,
        to_key: nodes[index + 1]?.node_key ?? "", trigger: node.await_reply ? "any_reply" : "default" })) });
    expect(saved.statusCode).toBe(200);
  };

  it("preserves the live opening delay and shares edits in both directions, including device pulls", async () => {
    await seed("disabled", ["正在招聘"]);
    const first = await canvas();
    expect(first.nodes[0].parts[0].delay_ms).toBe(2000);
    const { openings, opening_revision } = await persona();
    const edit = await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${openings[0].id}`, headers: admin,
      payload: { content: "岗位入口修改", delay_ms: 4000, revision: opening_revision } });
    expect(edit.statusCode).toBe(200);
    const second = await canvas();
    expect(second.version).toBeGreaterThan(first.version);
    expect(second.nodes[0].parts[0]).toMatchObject({ body: "岗位入口修改", delay_ms: 4000 });
    expect((await upsert(first)).statusCode).toBe(409);
    second.nodes[0].parts[0].body = "画布入口修改";
    expect((await upsert(second)).statusCode).toBe(200);
    expect(app.db.prepare("SELECT parts_json,body FROM agent_flow_node WHERE flow_id=(SELECT id FROM agent_flow WHERE position_id=?)")
      .get(positionId)).toMatchObject({ parts_json: "[]", body: "" });
    expect((await persona()).openings[0]).toMatchObject({ id: openings[0].id, content: "画布入口修改", delay_ms: 4000 });
    for (const revision of [undefined, opening_revision]) {
      expect((await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${openings[0].id}`, headers: admin,
        payload: { revision, content: "过期编辑" } })).statusCode).toBe(409);
    }
    expect((await pull("opening")).items[0]).toMatchObject({ content: "画布入口修改", delay_ms: 4000 });
    expect((await pull("flow")).nodes).toEqual([]);
    const published = await canvas();
    expect((await upsert({ ...published, status: "enabled" })).statusCode).toBe(200);
    expect((await pull("flow")).nodes[0]).toMatchObject({ await_reply: true, wait_minutes: 10,
      parts: [expect.objectContaining({ body: "画布入口修改", delay_ms: 4000 })] });
  });

  it("keeps each existing group and wait gate while the list controls order", async () => {
    await seed("enabled", ["招聘介绍", "薪资说明", "邀约见面"]);
    const { openings, opening_revision } = await persona();
    const reordered = await app.inject({ method: "POST", url: "/api/v1/agent-opening/reorder", headers: admin,
      payload: { position_id: positionId, ids: [openings[1].id, openings[0].id, openings[2].id], revision: opening_revision } });
    expect(reordered.statusCode).toBe(200);
    const live = await pull("flow");
    expect(live.nodes.map((node: { parts: { body: string }[] }) => node.parts[0].body)).toEqual(["薪资说明", "招聘介绍", "邀约见面"]);
    expect(live.nodes.map((node: { await_reply: boolean }) => node.await_reply)).toEqual([false, false, true]);
    expect(live.edges).toMatchObject([{ from_key: "n0", to_key: "n1" }, { from_key: "n1", to_key: "n2" }, { from_key: "n2", trigger: "any_reply" }]);
  });

  it("adopts position messages across existing waits while preserving later replies", async () => {
    for (const content of ["岗位入口", "第二段"]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/agent-opening", headers: admin,
        payload: { position_id: positionId, content } })).statusCode).toBe(200);
    }
    const nodes = ["旧入口", "第二段", "后续邀约"].map((body, index) => ({
      node_key: `n${index}`, parts: [{ kind: "text", body }], await_reply: true,
    }));
    const edges = nodes.map((node, index) => ({ from_key: node.node_key, to_key: nodes[index + 1]?.node_key ?? "", trigger: "any_reply" }));
    const response = await upsert({ position_id: positionId, status: "enabled", nodes, edges, use_position_opening: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().shared_opening).toEqual(["n0", "n1"]);
    expect(response.json().nodes.map((node: { parts: Array<{ body: string }>; await_reply: boolean }) =>
      [node.parts.map(part => part.body), node.await_reply])).toEqual([[["岗位入口"], true], [["第二段"], true], [["后续邀约"], true]]);
  });

  it("keeps blank editor placeholders out of the live opening when the canvas is stopped", async () => {
    const response = await upsert({ position_id: positionId, status: "disabled", create_shared_opening: true,
      nodes: [{ node_key: "intro", parts: [{ kind: "text", body: "请填写此节点要发送的内容" }] }],
      edges: [{ from_key: "intro", to_key: "", trigger: "default" }] });
    expect(response.statusCode).toBe(422);
    expect((await persona()).openings).toEqual([]);
  });

  it("migrates a previously saved matching graph once and preserves different drafts", async () => {
    await seed("disabled", ["岗位介绍"]);
    app.db.prepare("UPDATE agent_flow SET canvas_json=json_remove(canvas_json,'$.opening_layout') WHERE position_id=?").run(positionId);
    app.db.prepare(`UPDATE agent_flow_node SET parts_json='[{"kind":"text","body":"岗位介绍","media_name":"","delay_ms":0}]'
      WHERE flow_id=(SELECT id FROM agent_flow WHERE position_id=?)`).run(positionId);
    runOpeningUpgrade();
    expect((await canvas()).nodes[0].parts[0].delay_ms).toBe(2000);
    const linked = await canvas();
    migrateDatabase(app.db);
    expect(await canvas()).toEqual(linked);
    app.db.prepare("UPDATE agent_flow SET canvas_json=json_remove(canvas_json,'$.opening_layout') WHERE position_id=?").run(positionId);
    app.db.prepare(`UPDATE agent_flow_node SET parts_json='[{"kind":"text","body":"另一份草稿","media_name":"","delay_ms":0}]'
      WHERE flow_id=(SELECT id FROM agent_flow WHERE position_id=?)`).run(positionId);
    runOpeningUpgrade();
    expect((await canvas()).shared_opening).toEqual([]);
    expect((await canvas()).nodes[0].parts[0].body).toBe("另一份草稿");
    expect((await pull("opening")).items[0].content).toBe("岗位介绍");
  });

  it("reconciles Shenzhen and Guangzhou openings and serves the same location through both device protocols", async () => {
    const metro = app.db.prepare("INSERT INTO service_positions(id,position_name) VALUES (?,?)");
    metro.run(22, "深圳_地铁安检员");
    metro.run(23, "广州_地铁安检员");
    const insert = app.db.prepare("INSERT INTO position_opening(position_id,seq,kind,content,media_name,delay_ms) VALUES (?,?,?,?,?,?)");
    const location = { lng: 113.4, lat: 23.1, address: "广州测试地址", name: "面试入口" };
    insert.run(22, 1, "text", "深圳现行开场", "", 2000);
    insert.run(22, 2, "text", "深圳现行介绍", "", 2000);
    insert.run(22, 7, "video", "深圳视频配文", "安检.mp4", 2000);
    insert.run(23, 1, "text", "广州现行开场", "", 2000);
    insert.run(23, 2, "text", "广州岗位介绍", "", 2000);
    insert.run(23, 3, "text", "广州面试通知", "", 2000);
    insert.run(23, 4, "location", JSON.stringify(location), "", 2000);
    insert.run(23, 5, "video", "广州视频配文", "安检.mp4", 2000);
    app.db.prepare("INSERT INTO media_assets(name,kind,storage_path,sha256,position_id) VALUES ('安检.mp4','video','media/tour.mp4','fixture',0)").run();
    const flowId = app.db.prepare(`INSERT INTO agent_flow(position_id,status,canvas_json)
      VALUES (22,'disabled','{"entry_key":"opening_1"}')`).run().lastInsertRowid;
    const keys = ["opening_1", "opening_2", "opening_3", "opening_7"];
    keys.forEach((key, index) => {
      app.db.prepare(`INSERT INTO agent_flow_node(flow_id,node_key,await_reply,wait_minutes,parts_json)
        VALUES (?,?,1,20,?)`).run(flowId, key, JSON.stringify([{ kind: "text", body: "旧稿", media_name: "", delay_ms: 2000 }]));
      app.db.prepare(`INSERT INTO agent_flow_edge(flow_id,from_key,to_key,trigger) VALUES (?,?,?,'any_reply')`)
        .run(flowId, key, keys[index + 1] ?? "");
    });
    runOpeningUpgrade();
    positionId = 22;
    const shenzhen = await canvas();
    expect(shenzhen).toMatchObject({ status: "disabled", shared_opening: keys.slice(0, 2) });
    expect(shenzhen.nodes.map((node: { await_reply: boolean; wait_minutes: number }) => [node.await_reply, node.wait_minutes]))
      .toEqual([[true, 20], [true, 20]]);
    expect(shenzhen.nodes[1].parts.map((part: { body: string }) => part.body)).toEqual(["深圳现行介绍", "深圳视频配文"]);
    positionId = 23;
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.agent_position_id',?) WHERE json_extract(data_json,'$.device_code')='local-device-001'").run(positionId);
    const guangzhou = await canvas();
    expect(guangzhou).toMatchObject({ status: "disabled", shared_opening: ["intro"] });
    expect((await pull("flow")).nodes).toEqual([]);
    expect((await pull("opening")).items[3]).toMatchObject({ kind: "location", location, delay_ms: 2000 });
    expect(guangzhou.nodes[0].parts.map((part: { kind: string }) => part.kind))
      .toEqual(["text", "text", "text", "location", "video"]);
    const { openings, opening_revision } = await persona();
    const unsafeOrder = [openings[3], ...openings.filter((_: unknown, index: number) => index !== 3)].map(row => row.id);
    expect((await app.inject({ method: "POST", url: "/api/v1/agent-opening/reorder", headers: admin,
      payload: { position_id: positionId, ids: unsafeOrder, revision: opening_revision } })).statusCode).toBe(422);
    expect((await upsert({ ...guangzhou, nodes: [{ ...guangzhou.nodes[0], parts: [guangzhou.nodes[0].parts[3]] }] })).statusCode)
      .toBe(422);
    expect(await canvas()).toEqual(guangzhou);
    guangzhou.nodes[0].parts[3].location.address = "广州新地址";
    guangzhou.nodes[0].parts[3].delay_ms = 3300;
    expect((await upsert({ ...guangzhou, status: "enabled" })).statusCode).toBe(200);
    expect((await persona()).openings[3]).toMatchObject({ kind: "location", location: { address: "广州新地址" }, delay_ms: 3300 });
    for (const query of ["", "&location_links=1"]) {
      const deviceFlow = await pull("flow", query);
      expect(deviceFlow.nodes[0].parts[3]).toEqual({ kind: "text",
        body: "面试入口：广州新地址\n导航：https://uri.amap.com/marker?position=113.4,23.1", media_name: "", delay_ms: 3300 });
    }
    expect((await pull("opening", "&mode=flow")).items[3])
      .toMatchObject({ kind: "location", location: { address: "广州新地址" }, delay_ms: 3300 });
    expect(restoreLegacyFlowOpenings(app.db)).toBe(2);
    const restored = app.db.prepare("SELECT parts_json FROM agent_flow_node WHERE flow_id=(SELECT id FROM agent_flow WHERE position_id=23)").get();
    expect(JSON.parse(String(restored?.parts_json))[3]).toMatchObject({ kind: "text", delay_ms: 3300,
      body: expect.stringContaining("广州新地址") });
  });

  it("exposes added image and video with captions and delays, and rolls invalid updates back", async () => {
    await seed("enabled", ["招聘介绍"]);
    for (const [name, kind] of [["front.jpg", "image"], ["tour.mp4", "video"]]) {
      app.db.prepare("INSERT INTO media_assets(name,kind,storage_path,sha256,position_id,status) VALUES (?,?,?,?,?,'enabled')")
        .run(name, kind, `media/${name}`, name, positionId);
      const saved = await app.inject({ method: "POST", url: "/api/v1/agent-opening", headers: admin,
        payload: { position_id: positionId, kind, media_name: name, caption: "请看素材", delay_ms: 5000,
          revision: (await persona()).opening_revision } });
      expect(saved.statusCode).toBe(200);
    }
    const actual = await pull("flow");
    expect(actual.nodes[0].parts.map((part: { kind: string; delay_ms: number }) => [part.kind, part.delay_ms])).toEqual(
      [["text", 2000], ["text", 5000], ["image", 5000], ["text", 5000], ["video", 5000]],
    );
    const list = await persona();
    const invalid = await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${list.openings[0].id}`, headers: admin,
      payload: { content: "工价99999元", revision: list.opening_revision } });
    expect(invalid.statusCode).toBe(422);
    expect(await pull("flow")).toEqual(actual);
    const fromCanvas = await canvas();
    fromCanvas.nodes[0].parts[4].delay_ms = 4000;
    expect((await upsert(fromCanvas)).statusCode).toBe(200);
    expect((await persona()).openings[4]).toMatchObject({ kind: "video", delay_ms: 4000 });
    expect((await pull("opening")).items[4]).toMatchObject({ kind: "video", delay_ms: 4000 });
  });
});

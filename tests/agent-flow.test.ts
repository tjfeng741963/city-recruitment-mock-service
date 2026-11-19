import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("node workflow and conversation state API", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_SEED_FIXTURES = "1";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.REA_DATABASE_PATH;
    delete process.env.REA_SEED_FIXTURES;
  });

  const flow = {
    position_id: 1,
    entry_key: "qualify",
    canvas: { viewport: { x: 0, y: 0, z: 1 } },
    nodes: [
      {
        node_key: "qualify", node_type: "text", title: "用人要求", await_reply: true,
        parts: [{ kind: "text", body: "请先看下招聘要求，符合的话回复我。", delay_ms: 1000 }],
      },
      {
        node_key: "wage", node_type: "text", title: "薪资", await_reply: true, wait_minutes: 15,
        parts: [{ kind: "text", body: "薪资按岗位安排，具体面试时说明。" }],
      },
      {
        node_key: "wage_followup", node_type: "followup", title: "薪资复聊", max_times: 3,
        parts: [{ kind: "text", body: "薪资这块看明白了吗？" }],
      },
      { node_key: "end", node_type: "end", title: "结束" },
    ],
    edges: [
      { from_key: "qualify", to_key: "wage", trigger: "any_reply", priority: 10 },
      { from_key: "wage", to_key: "end", trigger: "any_reply", priority: 10 },
      { from_key: "wage", to_key: "wage_followup", trigger: "timeout", priority: 5 },
      { from_key: "wage_followup", to_key: "end", trigger: "default" },
    ],
  };

  it("saves a graph, forces followup max_times to one, and increments version", async () => {
    const first = await app.inject({ method: "PUT", url: "/api/v1/agent-flow", headers: admin, payload: flow });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ position_id: 1, version: 1, entry_key: "qualify" });
    expect(first.json().nodes.find((node: { node_key: string }) => node.node_key === "wage_followup").max_times).toBe(1);

    const second = await app.inject({
      method: "PUT", url: "/api/v1/agent-flow", headers: admin,
      payload: { ...flow, nodes: flow.nodes.map((node) => node.node_key === "wage" ? { ...node, title: "新薪资" } : node) },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(2);
    expect(second.json().nodes.find((node: { node_key: string }) => node.node_key === "wage").title).toBe("新薪资");

    const read = await app.inject({ method: "GET", url: "/api/v1/agent-flow?position_id=1", headers: admin });
    expect(read.statusCode).toBe(200);
    expect(read.json().edges).toHaveLength(4);
  });

  it("rejects orphan nodes and timeout edges from non-await nodes", async () => {
    const orphan = await app.inject({
      method: "PUT", url: "/api/v1/agent-flow", headers: admin,
      payload: { ...flow, nodes: [...flow.nodes, { node_key: "orphan", node_type: "end" }] },
    });
    expect(orphan.statusCode).toBe(422);

    const badTimeout = await app.inject({
      method: "PUT", url: "/api/v1/agent-flow", headers: admin,
      payload: {
        ...flow,
        edges: flow.edges.map((edge) => edge.trigger === "timeout" ? { ...edge, from_key: "end" } : edge),
      },
    });
    expect(badTimeout.statusCode).toBe(422);
  });

  it("validates and persists the eight conversation phases", async () => {
    const posted = await app.inject({
      method: "POST", url: "/api/v1/agent/state", headers: device,
      payload: {
        device_code: "local-device-001",
        items: [{
          session_key: "S:demo_123", position_id: 1, flow_version: 2, node_key: "wage",
          step_index: 0, phase: "awaiting", await_since: "2026-11-19T03:20:00Z", followup_round: 0,
        }],
      },
    });
    expect(posted.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: "/api/v1/agent/state?device_code=local-device-001", headers: device });
    expect(read.json().items).toHaveLength(1);
    expect(read.json().items[0]).toMatchObject({ session_key: "S:demo_123", phase: "awaiting", node_key: "wage" });

    const invalid = await app.inject({
      method: "POST", url: "/api/v1/agent/state", headers: device,
      payload: { device_code: "local-device-001", items: [{ session_key: "S:bad", phase: "failed" }] },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("rejects invalid graph updates without replacing the saved graph or version", async () => {
    const original = (await app.inject({method:"GET",url:"/api/v1/agent-flow?position_id=1",headers:admin})).json();
    for (const invalid of [
      {...flow, entry_key:"missing"},
      {...flow, nodes:flow.nodes.map(node => node.node_key === "qualify" ? {...node,node_type:"await"} : node)},
      {...flow, edges:[...flow.edges,{from_key:"end",to_key:"qualify",trigger:"default"}]},
      {...flow, edges:flow.edges.map(edge => edge.from_key === "qualify" ? {...edge,to_key:"qualify"} : edge)},
    ]) {
      const response = await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:invalid});
      expect(response.statusCode).toBe(422);
    }
    const conflict = await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:{...flow,version:0}});
    expect(conflict.statusCode).toBe(409);
    const latest = (await app.inject({method:"GET",url:"/api/v1/agent-flow?position_id=1",headers:admin})).json();
    expect(latest).toEqual(original);
  });

  it("blocks foreign media and prices not present in position facts", async () => {
    const foreignId = Number(app.db.prepare("INSERT INTO service_positions(position_name,status) VALUES ('另一岗位','enabled')").run().lastInsertRowid);
    app.db.prepare("INSERT INTO media_assets(name,kind,storage_path,sha256,position_id,status) VALUES ('foreign.jpg','image','foreign.jpg','test-hash',?,'enabled')").run(foreignId);
    const media = await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:{...flow,nodes:flow.nodes.map(node =>
      node.node_key === "qualify" ? {...node,parts:[{kind:"image",media_name:"foreign.jpg"}]} : node)}});
    expect(media.statusCode).toBe(422);
    const price = await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:{...flow,nodes:flow.nodes.map(node =>
      node.node_key === "qualify" ? {...node,parts:[{kind:"text",body:"工资987654元/天"}]} : node)}});
    expect(price.statusCode).toBe(422);
    expect(price.json().detail).toContain("岗位事实");
  });

  it("migrates once into a disabled draft and leaves legacy opening data unchanged", async () => {
    const pid = Number(app.db.prepare("INSERT INTO service_positions(position_name,status) VALUES ('迁移岗位','enabled')").run().lastInsertRowid);
    app.db.prepare("INSERT INTO position_opening(position_id,seq,kind,content,status) VALUES (?,1,'text','原始介绍','enabled')").run(pid);
    const first = await app.inject({method:"POST",url:"/api/v1/agent-flow/migrate",headers:admin,payload:{position_id:pid}});
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({version:1,status:"disabled"});
    expect(first.json().nodes[0]).toMatchObject({await_reply:true,parts:[{kind:"text",body:"原始介绍"}]});
    const again = await app.inject({method:"POST",url:"/api/v1/agent-flow/migrate",headers:admin,payload:{position_id:pid}});
    expect(again.json()).toEqual(first.json());
    expect(app.db.prepare("SELECT content FROM position_opening WHERE position_id=?").get(pid)).toMatchObject({content:"原始介绍"});
  });

  it("binds flow and state to the authenticated device and rejects stale revisions", async () => {
    expect((await app.inject({method:"GET",url:"/api/v1/agent/flow?device_code=another-device",headers:device})).statusCode).toBe(403);
    expect((await app.inject({method:"GET",url:"/api/v1/agent-flow?position_id=1",headers:device})).statusCode).toBe(401);
    const state = {session_key:"S:revisions",position_id:1,flow_version:2,node_key:"wage",step_index:1,phase:"awaiting",followup_round:0,revision:3};
    expect((await app.inject({method:"POST",url:"/api/v1/agent/state",headers:device,payload:{device_code:"local-device-001",items:[state]}})).statusCode).toBe(200);
    const stale = await app.inject({method:"POST",url:"/api/v1/agent/state",headers:device,payload:{device_code:"local-device-001",items:[{...state,phase:"running",revision:2}]}});
    expect(stale.json().stale).toEqual(["S:revisions"]);
    const read = await app.inject({method:"GET",url:"/api/v1/agent/state?device_code=local-device-001&session_key=S:revisions",headers:device});
    expect(read.json().items[0]).toMatchObject({phase:"awaiting",revision:3});
  });

  it("only expands the first flow gate when mode=flow is explicit", async () => {
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.position_id',1) WHERE json_extract(data_json,'$.device_code')='local-device-001'").run();
    app.db.prepare("INSERT INTO position_opening(position_id,seq,kind,content,status) VALUES (1,999,'text','legacy-marker','enabled')").run();
    const normal = await app.inject({method:"GET",url:"/api/v1/agent/opening?device_code=local-device-001",headers:device});
    expect(normal.json().items.some((item:{content:string})=>item.content === "legacy-marker")).toBe(true);
    const segment = await app.inject({method:"GET",url:"/api/v1/agent/opening?device_code=local-device-001&mode=flow",headers:device});
    expect(segment.json().items).toHaveLength(1);
    expect(segment.json().items[0].content).toBe(flow.nodes[0].parts?.[0].body);
    const result = await app.inject({method:"GET",url:"/api/v1/agent/flow?device_code=local-device-001",headers:device});
    expect(result.json()).toMatchObject({position_id:1,version:2});
    await app.inject({method:"PUT",url:"/api/v1/agent-flow",headers:admin,payload:{...flow,status:"disabled"}});
    const disabled = await app.inject({method:"GET",url:"/api/v1/agent/flow?device_code=local-device-001",headers:device});
    expect(disabled.json().nodes).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { addFlowNode, normalizeFlow, removeFlowNode } from "../frontend-vue/src/components/basic/flow-graph.js";

/**
 * 编辑器里的增删节点必须产出一张后端 validateGraph 能接受的图。
 * 这里直接把这些图 PUT 到真实路由，用后端校验器当断言。
 */

function migratedFlow() {
  const nodes = [1, 2, 3].map((i) => ({
    node_key: `opening_${i}`,
    node_type: "text",
    title: `开场 ${i}`,
    await_reply: true,
    wait_minutes: 15,
    max_times: 1,
    status: "enabled",
    parts: [{ kind: "text", body: `第 ${i} 段介绍内容`, delay_ms: 2000 }],
  }));
  return {
    position_id: 1,
    version: 0,
    status: "disabled",
    entry_key: "opening_1",
    canvas: { viewport: {} },
    nodes,
    edges: nodes.map((node, i) => ({
      from_key: node.node_key,
      to_key: nodes[i + 1]?.node_key ?? "",
      trigger: "any_reply",
      condition_value: "",
      priority: 0,
    })),
  };
}

describe("node flow editor graph edits", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_SEED_FIXTURES = "1";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.REA_DATABASE_PATH;
    delete process.env.REA_SEED_FIXTURES;
  });

  /** 所有用例共用同一个内存库，保存前先取当前 version，避免并发编辑冲突 409。 */
  async function currentVersion(): Promise<number> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent-flow?position_id=1",
      headers: admin,
    });
    return Number(response.json().version) || 0;
  }

  async function save(flow: unknown) {
    const version = await currentVersion();
    return app.inject({
      method: "PUT",
      url: "/api/v1/agent-flow",
      headers: admin,
      payload: { ...(flow as object), version },
    });
  }

  it("saves a chain after appending a text node", async () => {
    const flow = addFlowNode(migratedFlow(), "text");
    expect(flow.nodes).toHaveLength(4);
    expect(flow.nodes[3].node_key).toBe("node_1");
    // 链尾改指向新节点，新节点用 any_reply 兜底
    expect(flow.edges.find((e) => e.from_key === "opening_3")?.to_key).toBe("node_1");
    expect(flow.edges.find((e) => e.from_key === "node_1")?.trigger).toBe("any_reply");

    const response = await save(flow);
    expect(response.statusCode).toBe(200);
    expect(response.json().nodes.map((n: { node_key: string }) => n.node_key)).toContain("node_1");
  });

  it("saves a chain after appending an end node and then deleting the middle node", async () => {
    const withText = addFlowNode(migratedFlow(), "text");
    const withEnd = addFlowNode(withText, "end");
    expect(withEnd.nodes.at(-1)?.node_type).toBe("end");
    // end 节点不能有出边
    expect(withEnd.edges.some((e) => e.from_key === "node_2")).toBe(false);

    const first = await save(withEnd);
    expect(first.statusCode).toBe(200);

    const removed = removeFlowNode({ ...withEnd, version: first.json().version }, "node_1");
    expect(removed.blocked).toBeUndefined();
    expect(removed.flow.nodes.map((n) => n.node_key)).not.toContain("node_1");
    // 前驱直接接到被删节点的后继
    expect(removed.flow.edges.find((e) => e.from_key === "opening_3")?.to_key).toBe("node_2");

    const second = await save(removed.flow);
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(first.json().version + 1);
  });

  it("refuses to delete the entry node or the last remaining node", () => {
    const flow = migratedFlow();
    expect(removeFlowNode(flow, "opening_1").blocked).toBe("entry");
    const single = normalizeFlow({
      ...flow,
      entry_key: "opening_2",
      nodes: flow.nodes.slice(1, 2),
      edges: [{ from_key: "opening_2", to_key: "", trigger: "any_reply", condition_value: "", priority: 0 }],
    });
    expect(removeFlowNode(single, "opening_2").blocked).toBe("last");
  });

  it("drops a timeout edge instead of retargeting it when the followup node is deleted", async () => {
    const flow = {
      position_id: 1,
      version: 0,
      status: "disabled",
      entry_key: "qualify",
      canvas: { viewport: {} },
      nodes: [
        {
          node_key: "qualify",
          node_type: "text",
          title: "要求",
          await_reply: true,
          parts: [{ kind: "text", body: "先看要求，符合回复我。", delay_ms: 2000 }],
        },
        { node_key: "end", node_type: "end", title: "结束", parts: [] },
        {
          node_key: "wage_followup",
          node_type: "followup",
          title: "复聊",
          max_times: 1,
          parts: [{ kind: "text", body: "还在看吗？", delay_ms: 2000 }],
        },
      ],
      edges: [
        { from_key: "qualify", to_key: "end", trigger: "any_reply", condition_value: "", priority: 0 },
        { from_key: "qualify", to_key: "wage_followup", trigger: "timeout", condition_value: "", priority: 0 },
        { from_key: "wage_followup", to_key: "end", trigger: "default", condition_value: "", priority: 0 },
      ],
    };

    const first = await save(flow);
    expect(first.statusCode).toBe(200);

    const removed = removeFlowNode({ ...flow, version: first.json().version }, "wage_followup");
    expect(removed.blocked).toBeUndefined();
    // timeout 只能指向 followup，后继不是 followup 时这条边必须消失
    expect(removed.flow.edges.some((e) => e.trigger === "timeout")).toBe(false);

    const second = await save(removed.flow);
    expect(second.statusCode).toBe(200);
  });

  it("normalizes a node that came back without parts", () => {
    const filled = normalizeFlow({
      position_id: 1,
      version: 1,
      status: "disabled",
      entry_key: "intro",
      canvas: {},
      nodes: [
        { node_key: "intro", node_type: "text", title: "介绍", body: "欢迎咨询" },
        { node_key: "done", node_type: "end" },
      ],
      edges: [{ from_key: "intro", to_key: "done", trigger: "default" }],
    });
    expect(filled.nodes[0].parts).toEqual([{ kind: "text", body: "欢迎咨询", delay_ms: 2000 }]);
    expect(filled.nodes[0].await_reply).toBe(false);
    expect(filled.nodes[0].wait_minutes).toBe(15);
    expect(filled.nodes[1].parts).toEqual([]);
    expect(filled.edges[0].condition_value).toBe("");
  });
});

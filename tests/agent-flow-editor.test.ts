import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  addBranchNode,
  addFlowEdge,
  addFlowNode,
  addFollowupNode,
  createBlankFlow,
  changeFlowEntry,
  dragFlowPoint,
  flowActivationIssues,
  flowRequiresEnableConfirmation,
  moveFlowNode,
  newlyDisabledNodeKeys,
  normalizeFlow,
  removeFlowEdge,
  removeFlowNode,
  updateFlowEdge,
} from "../frontend-vue/src/components/basic/flow-graph.js";

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

  it("moves only the selected node and preserves all edges", () => {
    const flow = migratedFlow();
    const moved = moveFlowNode(flow, "opening_2", 420, 260);
    expect(moved.nodes.find((node) => node.node_key === "opening_2")).toMatchObject({ x: 420, y: 260 });
    expect(moved.nodes.find((node) => node.node_key === "opening_1")).toEqual(flow.nodes[0]);
    expect(moved.edges).toEqual(flow.edges);
    expect(flow.nodes.find((node) => node.node_key === "opening_2")).not.toHaveProperty("x");
  });

  it("persists dragged node coordinates through the real flow API", async () => {
    const moved = moveFlowNode(migratedFlow(), "opening_2", 420, 260);
    const response = await save(moved);
    expect(response.statusCode).toBe(200);
    const readback = await app.inject({
      method: "GET",
      url: "/api/v1/agent-flow?position_id=1",
      headers: admin,
    });
    expect(readback.json().nodes.find((node: { node_key: string }) => node.node_key === "opening_2"))
      .toMatchObject({ x: 420, y: 260 });
  });

  it("converts pointer movement into graph coordinates at the current zoom", () => {
    expect(dragFlowPoint({ x: 80, y: 40 }, { x: 200, y: 160 }, { x: 240, y: 200 }, 2))
      .toEqual({ x: 100, y: 60 });
    expect(dragFlowPoint({ x: 80, y: 40 }, { x: 200, y: 160 }, { x: 240, y: 200 }, 0))
      .toEqual({ x: 120, y: 80 });
  });

  it("updates only the selected edge and preserves the rest of the graph", () => {
    const flow = migratedFlow();
    const edited = updateFlowEdge(flow, 0, { trigger: "keyword", condition_value: "工资", priority: 3 });
    expect(edited.edges[0]).toMatchObject({ trigger: "keyword", condition_value: "工资", priority: 3 });
    expect(edited.edges.slice(1)).toEqual(flow.edges.slice(1));
    expect(flow.edges[0].trigger).toBe("any_reply");
  });

  it("adds an optional keyword edge without removing the waiting fallback", () => {
    const flow = migratedFlow();
    const edited = addFlowEdge(flow, "opening_3");
    expect(edited.edges).toContainEqual(expect.objectContaining({
      from_key: "opening_3", to_key: "", trigger: "keyword", condition_value: expect.any(String),
    }));
    expect(edited.edges).toContainEqual(expect.objectContaining({ from_key: "opening_3", trigger: "any_reply" }));
  });

  it("only allows keyword edges from a waiting node or a branch", () => {
    const continuous = migratedFlow();
    continuous.nodes[2].await_reply = false;
    continuous.edges[2].trigger = "default";
    expect(() => addFlowEdge(continuous, "opening_3")).toThrow("等待回复节点");
    expect(addFlowEdge(addBranchNode(migratedFlow(), "opening_1"), "node_1").edges.some((edge) => edge.trigger === "keyword"))
      .toBe(true);
  });

  it("blocks required fallback removal and removes an optional keyword edge", () => {
    const withKeyword = addFlowEdge(migratedFlow(), "opening_3");
    const requiredIndex = withKeyword.edges.findIndex((edge) => edge.from_key === "opening_3" && edge.trigger === "any_reply");
    expect(removeFlowEdge(withKeyword, requiredIndex).blocked).toBe("required-fallback");
    const keywordIndex = withKeyword.edges.findIndex((edge) => edge.from_key === "opening_3" && edge.trigger === "keyword");
    const removed = removeFlowEdge(withKeyword, keywordIndex);
    expect(removed.blocked).toBeUndefined();
    expect(removed.flow.edges).toHaveLength(withKeyword.edges.length - 1);
  });

  it("allows deleting an unused timeout route and protects one leading to an enabled followup", () => {
    const flow = addFollowupNode(migratedFlow(), "opening_3");
    const timeoutIndex = flow.edges.findIndex((edge) => edge.trigger === "timeout");
    expect(removeFlowEdge(flow, timeoutIndex).blocked).toBe("required-fallback");

    const disabledFlow = {
      ...flow,
      nodes: flow.nodes.map((node) => node.node_type === "followup" ? { ...node, status: "disabled" } : node),
    };
    expect(removeFlowEdge(disabledFlow, timeoutIndex).blocked).toBeUndefined();

    const optionalTimeout = {
      ...migratedFlow(),
      edges: [...migratedFlow().edges, { from_key: "opening_3", to_key: "", trigger: "timeout", condition_value: "", priority: 0 }],
    };
    const optionalIndex = optionalTimeout.edges.length - 1;
    expect(removeFlowEdge(optionalTimeout, optionalIndex).blocked).toBeUndefined();
  });

  it("appends message nodes with a matching message part", () => {
    for (const kind of ["text", "image", "video"] as const) {
      const appended = addFlowNode(migratedFlow(), kind);
      const node = appended.nodes.at(-1)!;
      expect(node.node_type).toBe(kind);
      expect(node.parts).toHaveLength(1);
      expect(node.parts![0]).toMatchObject({ kind });
      expect(Number.isFinite(Number(node.x))).toBe(true);
      expect(Number.isFinite(Number(node.y))).toBe(true);
      expect(Math.abs(Number(node.x) - 80) >= 316 || Math.abs(Number(node.y) - 48) >= 184).toBe(true);
      expect(appended.edges.find((edge) => edge.from_key === "opening_3")?.to_key).toBe(node.node_key);
    }
  });

  it("appends an end node through the current open exit", () => {
    const flow = migratedFlow();
    const appended = addFlowNode(flow, "end");
    const end = appended.nodes.at(-1)!;
    expect(end).toMatchObject({ node_type: "end", parts: [], await_reply: false });
    expect(Number.isFinite(Number(end.x))).toBe(true);
    expect(Number.isFinite(Number(end.y))).toBe(true);
    expect(appended.edges.find((edge) => edge.from_key === "opening_3")?.to_key).toBe(end.node_key);
    expect(appended.edges.some((edge) => edge.from_key === end.node_key)).toBe(false);
  });

  it("adds a branch after the selected node and leaves a valid fallback", () => {
    const branched = addBranchNode(migratedFlow(), "opening_3");
    const branch = branched.nodes.at(-1)!;
    expect(branch).toMatchObject({ node_type: "branch", parts: [], await_reply: false });
    expect(Number.isFinite(Number(branch.x))).toBe(true);
    expect(Number.isFinite(Number(branch.y))).toBe(true);
    expect(branched.edges.find((edge) => edge.from_key === "opening_3" && edge.trigger === "any_reply")?.to_key)
      .toBe(branch.node_key);
    expect(branched.edges).toContainEqual(expect.objectContaining({
      from_key: branch.node_key, to_key: "", trigger: "default",
    }));
  });

  it("preserves the previous successor when inserting a branch", () => {
    const flow = migratedFlow();
    const branched = addBranchNode(flow, "opening_1");
    const branch = branched.nodes.at(-1)!;
    expect(branched.edges).toContainEqual(expect.objectContaining({
      from_key: branch.node_key, to_key: "opening_2", trigger: "default",
    }));
  });

  it("adds one timeout followup only after a waiting node", () => {
    const followed = addFollowupNode(migratedFlow(), "opening_3");
    const followup = followed.nodes.at(-1)!;
    expect(followup).toMatchObject({ node_type: "followup", max_times: 1, await_reply: false });
    expect(followup.parts).toHaveLength(1);
    expect(followup.parts![0]).toMatchObject({ kind: "text" });
    expect(Number.isFinite(Number(followup.x))).toBe(true);
    expect(Number.isFinite(Number(followup.y))).toBe(true);
    expect(followed.edges).toContainEqual(expect.objectContaining({
      from_key: "opening_3", to_key: followup.node_key, trigger: "timeout",
    }));
    expect(followed.edges).toContainEqual(expect.objectContaining({
      from_key: followup.node_key, to_key: "", trigger: "default",
    }));
    expect(() => addFollowupNode({
      ...migratedFlow(),
      nodes: migratedFlow().nodes.map((node) => ({ ...node, await_reply: false })),
    }, "opening_3")).toThrow("等待回复");
  });

  it("creates an empty disabled draft with one visible waiting text node", () => {
    expect(createBlankFlow(42)).toMatchObject({
      position_id: 42,
      version: 0,
      status: "disabled",
      entry_key: "intro",
      nodes: [{ node_key: "intro", node_type: "text", await_reply: true, x: expect.any(Number), y: expect.any(Number) }],
      edges: [{ from_key: "intro", to_key: "", trigger: "any_reply" }],
    });
  });

  it("asks for confirmation only when moving a disabled flow to enabled", () => {
    expect(flowRequiresEnableConfirmation("disabled", "enabled")).toBe(true);
    expect(flowRequiresEnableConfirmation("enabled", "enabled")).toBe(false);
    expect(flowRequiresEnableConfirmation("enabled", "disabled")).toBe(false);
  });

  it("lists only nodes newly disabled by the current edit", () => {
    const before = migratedFlow();
    const after = { ...before, nodes: before.nodes.map((node) => node.node_key === "opening_2" ? { ...node, status: "disabled" } : node) };
    expect(newlyDisabledNodeKeys(before, after)).toEqual(["opening_2"]);
    expect(newlyDisabledNodeKeys(after, after)).toEqual([]);
  });

  it("moves the entry forward and disables nodes that would become unreachable", () => {
    const result = changeFlowEntry(migratedFlow(), "opening_2");
    expect(result.flow.entry_key).toBe("opening_2");
    expect(result.disabledNodeKeys).toEqual(["opening_1"]);
    expect(result.flow.nodes.find((node) => node.node_key === "opening_1")?.status).toBe("disabled");
    expect(result.flow.nodes.find((node) => node.node_key === "opening_3")?.status).toBe("enabled");
  });

  it("blocks activation while enabled nodes contain placeholder text or missing media", () => {
    const draft = createBlankFlow(1);
    expect(flowActivationIssues(draft)).toContain("招聘介绍：请替换占位话术");

    const missingMedia = {
      ...draft,
      nodes: [{ ...draft.nodes[0], parts: [{ kind: "image", media_name: "", body: "" }] }],
    };
    expect(flowActivationIssues(missingMedia)).toContain("招聘介绍：请选择图片素材");

    const disabled = { ...draft, nodes: draft.nodes.map((node) => ({ ...node, status: "disabled" })) };
    expect(flowActivationIssues(disabled)).toEqual([]);
  });

  it("saves optional keyword, branch, and timeout edges through the server graph validator", async () => {
    const keywordFlow = addFlowEdge(migratedFlow(), "opening_3");
    const keywordSaved = await save(keywordFlow);
    expect(keywordSaved.statusCode).toBe(200);

    const branchFlow = addBranchNode(migratedFlow(), "opening_1");
    const branchSaved = await save(branchFlow);
    expect(branchSaved.statusCode).toBe(200);

    const followupFlow = addFollowupNode(migratedFlow(), "opening_3");
    const followupSaved = await save(followupFlow);
    expect(followupSaved.statusCode).toBe(200);
  });
});

# 招聘流程图页面实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在知识管理菜单下展示并编辑每个岗位真实保存的招聘流程图。

**Architecture:** 复用 4222 的 `agent-flow` API；纯图状态变更放在 `flow-graph.ts`，单独的 `AgentFlowCanvas.vue` 渲染节点/边并负责拖拽，`AgentFlowView.vue` 负责岗位选择、节点/边属性、状态与保存。岗位抽屉只跳转到新页面。

**Tech Stack:** Vue 3、TypeScript、Element Plus、SVG、Pointer Events、Vitest、Fastify `app.inject`。

## Global Constraints

- 页面沿用当前 Vue 3 + Element Plus 后台的布局、组件、色彩、间距和文案风格。
- 不新增后端接口、数据库字段或节点类型。
- 不启动自动回复、不打开企业微信、不扫码、不发送消息。
- 流程保存保留服务端 `version`；409 不覆盖旧版本；启用前要确认。
- 只 stage 本计划列出的具体文件；不得提交 `.env*`、密钥、数据库、过程截图/日志、`dist/` 或 `node_modules/`。

---

### Task 1: 可测试的流程图变更函数

**Files:**
- Modify: `frontend-vue/src/components/basic/flow-graph.ts`
- Test: `tests/agent-flow-editor.test.ts`

**Interfaces:**
- `moveFlowNode<T extends FlowLike>(source: T, nodeKey: string, x: number, y: number): T`
- `updateFlowEdge<T extends FlowLike>(source: T, index: number, patch: Partial<FlowEdgeLike>): T`
- `addBranchNode<T extends FlowLike>(source: T, fromKey: string): T`
- `addFollowupNode<T extends FlowLike>(source: T, awaitNodeKey: string): T`
- `addFlowNode<T extends FlowLike>(source: T, kind: "text" | "image" | "video" | "end"): T`
- `dragFlowPoint(nodeOrigin, pointerOrigin, pointerCurrent, zoom): { x: number; y: number }`
- `flowRequiresEnableConfirmation(previousStatus, nextStatus): boolean`

- [ ] **Step 1: Add failing tests**

Add these tests to the existing `node flow editor graph edits` suite:

```ts
it("moves only the selected node and preserves all edges", () => {
  const flow = migratedFlow();
  const moved = moveFlowNode(flow, "opening_2", 420, 260);
  expect(moved.nodes.find((node) => node.node_key === "opening_2")).toMatchObject({ x: 420, y: 260 });
  expect(moved.nodes.find((node) => node.node_key === "opening_1")).toEqual(flow.nodes[0]);
  expect(moved.edges).toEqual(flow.edges);
});

it("appends a reachable branch after a node with an open primary exit", () => {
  const flow = migratedFlow();
  const branched = addBranchNode(flow, "opening_3");
  expect(branched.nodes.at(-1)?.node_type).toBe("branch");
  expect(branched.edges.find((edge) => edge.from_key === "opening_3" && edge.trigger === "any_reply")?.to_key)
    .toBe(branched.nodes.at(-1)?.node_key);
  expect(branched.edges.some((edge) => edge.from_key === branched.nodes.at(-1)?.node_key && edge.trigger === "default"))
    .toBe(true);
});

it.each(["text", "image", "video"] as const)("appends a %s message node with a valid part", (kind) => {
  const flow = migratedFlow();
  const appended = addFlowNode(flow, kind);
  const node = appended.nodes.at(-1)!;
  expect(node.node_type).toBe(kind);
  expect(node.parts).toHaveLength(1);
  expect(node.parts![0].kind).toBe(kind);
  expect(appended.edges.find((edge) => edge.from_key === "opening_3")?.to_key).toBe(node.node_key);
});

it("adds one timeout followup only from a waiting node", () => {
  const flow = migratedFlow();
  const followed = addFollowupNode(flow, "opening_3");
  const followup = followed.nodes.at(-1)!;
  expect(followup.node_type).toBe("followup");
  expect(followed.edges).toContainEqual(expect.objectContaining({ from_key: "opening_3", to_key: followup.node_key, trigger: "timeout" }));
  expect(followed.edges).toContainEqual(expect.objectContaining({ from_key: followup.node_key, to_key: "", trigger: "default" }));
  expect(() => addFollowupNode({ ...flow, nodes: flow.nodes.map((node) => ({ ...node, await_reply: false })) }, "opening_3"))
    .toThrow("等待回复");
});

it("updates only the selected edge", () => {
  const flow = migratedFlow();
  const edited = updateFlowEdge(flow, 0, { trigger: "keyword", condition_value: "工资", priority: 3 });
  expect(edited.edges[0]).toMatchObject({ trigger: "keyword", condition_value: "工资", priority: 3 });
  expect(edited.edges.slice(1)).toEqual(flow.edges.slice(1));
});

it("converts pointer movement into graph coordinates at the current zoom", () => {
  expect(dragFlowPoint({ x: 80, y: 40 }, { x: 200, y: 160 }, { x: 240, y: 200 }, 2))
    .toEqual({ x: 100, y: 60 });
});

it("requests confirmation only when enabling a flow", () => {
  expect(flowRequiresEnableConfirmation("disabled", "enabled")).toBe(true);
  expect(flowRequiresEnableConfirmation("enabled", "enabled")).toBe(false);
  expect(flowRequiresEnableConfirmation("enabled", "disabled")).toBe(false);
});
```

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/agent-flow-editor.test.ts` from the repository root. Expected: the six new imports fail because the helpers are absent.

- [ ] **Step 3: Implement the tested helpers**

`moveFlowNode` clones the graph and only changes the matching node's `x/y`. `updateFlowEdge` clones the graph and only merges fields into the indexed edge. `addBranchNode` requires a selected node with an open `default` or `any_reply` edge, redirects that edge to a new branch, and gives the branch a terminal `default` edge. `addFollowupNode` requires `await_reply=true`, appends a one-text-part followup, adds one `timeout` edge from the waiting node and one terminal `default` edge from the followup. Missing nodes or invalid source nodes throw a user-readable error; no existing edge is silently deleted. `dragFlowPoint` adds pointer delta divided by finite positive zoom to the persisted origin. `flowRequiresEnableConfirmation` returns true only for `disabled -> enabled`.

- [ ] **Step 4: Verify GREEN against both helper and server graph validation**

Run `npx vitest run tests/agent-flow-editor.test.ts tests/agent-flow.test.ts`. Expected: all appended/modified graphs accepted by `PUT /api/v1/agent-flow`; the invalid followup source is rejected before saving.

### Task 2: Flow canvas component

**Files:**
- Create: `frontend-vue/src/components/agent/AgentFlowCanvas.vue`
- Modify: `frontend-vue/src/components/basic/flow-graph.ts`
- Test: `tests/agent-flow-editor.test.ts`

**Interfaces:**
- Props: `{ flow: AgentFlow; selectedNodeKey: string; selectedEdgeIndex: number | null }`.
- Emits: `select-node(nodeKey)`, `select-edge(index)`, `move-node(nodeKey, x, y)`.
- Canvas reads node `x/y`; it never invents a flow or writes coordinates just by loading.

- [ ] **Step 1: Add the failing coordinate-conversion test in Task 1 before implementing `dragFlowPoint`.**
- [ ] **Step 2: Run `npx vitest run tests/agent-flow-editor.test.ts`; confirm RED on the missing helper, implement it, then rerun to GREEN.**
- [ ] **Step 3: Implement the component with SVG paths and arrow markers for each `from_key/to_key`, trigger labels on edges, fixed-size Element Plus-style node surfaces, selection state, and pointer capture. On pointer move, call `dragFlowPoint` with pointer start/current coordinates and current canvas zoom, then emit `move-node`; release pointer capture on pointer-up/cancel.
- [ ] **Step 4: Run `npm run build --prefix frontend-vue` and `npx vitest run tests/agent-flow-editor.test.ts`.**

### Task 3: Standalone page, property inspector, and save protocol

**Files:**
- Create: `frontend-vue/src/views/AgentFlowView.vue`
- Modify: `frontend-vue/src/api/agent.ts`
- Test: `tests/agent-flow-editor.test.ts`

**Interfaces:**
- Load positions with `positionsApi.list({ page: 1, page_size: 1000 })`.
- Load one graph with `agentApi.flowGet(positionId)` and save with `agentApi.flowSave(flow)`.
- Route query `position_id` selects the initial position and is updated when the user changes positions.

- [ ] **Step 1: Add the failing enable-confirmation test in Task 1 before implementing `flowRequiresEnableConfirmation`.**
- [ ] **Step 2: Run `npx vitest run tests/agent-flow-editor.test.ts`; verify RED, implement the helper, then rerun to GREEN.**
- [ ] **Step 3: Implement the page with a top position/status/version toolbar, graph canvas, and right-side inspector. The inspector edits node title/status, 1–6 parts, part kind/body/media/delay, `await_reply`, `wait_minutes`, `max_times`, and selected-edge `trigger/to_key/condition_value/priority`. Enforce backend enums and only offer enabled media for the selected position or common pool.**
- [ ] **Step 4: Add toolbar actions for text/image/video, branch, followup, and end nodes. Message nodes append through `addFlowNode`; branch and followup use the selected source node through `addBranchNode`/`addFollowupNode`. Show helper validation errors beside the toolbar and do not mutate the graph on an invalid operation.**
- [ ] **Step 5: Add an empty state with “create disabled draft” and “migrate opening to disabled draft” actions. Initialize a new flow with one text node and a terminal `any_reply` edge; never auto-enable a new or migrated flow.**
- [ ] **Step 6: Save with the loaded `version`; preserve dirty edits on HTTP 409, show an explicit reload action, and call `flowRequiresEnableConfirmation` before changing `disabled` to `enabled`.**
- [ ] **Step 7: Run `npx vitest run tests/agent-flow-editor.test.ts tests/agent-flow.test.ts` and `npm run build --prefix frontend-vue`.**

### Task 4: Navigation unification and visual verification

**Files:**
- Modify: `frontend-vue/src/router/index.ts`
- Modify: `frontend-vue/src/layouts/MainLayout.vue`
- Modify: `frontend-vue/src/components/basic/PositionAgentDrawer.vue`
- Verify: `frontend-vue` dev server in browser

- [ ] **Step 1: Add the `recruitment-flow` route and “流程图” item immediately below “知识库配置”; use existing router metadata and menu component styles.**
- [ ] **Step 2: Replace the drawer's node-editing tab with a status summary and link to `/recruitment-flow?position_id=<id>`; leave persona and opening editors intact.**
- [ ] **Step 3: Build with `npm run build --prefix frontend-vue`; expected: `vue-tsc -b` and Vite build succeed.**
- [ ] **Step 4: Start `npm run dev --prefix frontend-vue`, open `/recruitment-flow`, and verify the existing shell, spacing, colors, menu placement, real empty/loaded states, dragging, node/edge properties, 409 preservation, and narrow-width layout.**
- [ ] **Step 5: Run `npx vitest run tests/agent-flow-editor.test.ts tests/agent-flow.test.ts` and `npx tsc --noEmit`.**

## Self-Review

- Page route/menu and drawer unification are covered by Task 4.
- Real per-position flow loading, graph display, editing, and persistence are covered by Tasks 2–3.
- Existing API enums, optimistic versioning, disabled draft, and activation confirmation are covered by Task 3.
- UI consistency is enforced by reusing the existing Vue/Element Plus shell and controls; no component library is added.
- No backend or frozen WeCom input/send core is modified.

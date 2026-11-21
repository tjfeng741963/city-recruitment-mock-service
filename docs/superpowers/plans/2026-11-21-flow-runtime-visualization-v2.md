# 招聘流程运行可视化改进实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让用户在全屏画布看懂真实岗位发送路径、设备绑定、媒体处理、AI 接管和运行状态，并修复终端等待节点吞掉客户首条回复。

**Architecture:** 现有流程 API 仍是节点/边配置的唯一来源。流程页按设备绑定、流程启停和旧开场配置计算有效路径；单独的只读汇总接口展示客户端状态镜像而不暴露会话明细。Windows 流程等待节点有下一节点时照旧推进，无下一节点时把原入站文本交给现有 AI 对话链路。

**Tech Stack:** Vue 3、TypeScript、Element Plus、Fastify、SQLite、Python、Vitest、pytest。

## Global Constraints

- 不修改 `agent/wecom_io_core/{win.py,send.py,store.py,crypto.py}`。
- 不改变深圳岗位状态、Windows 设备绑定、设备配置或任何客户会话数据。
- 浏览器只编辑配置和读取汇总，不新增浏览器发消息能力。
- 不启动自动回复、企微、扫码或真实消息发送。
- 状态摘要不给管理员返回会话 ID、会话名、正文、错误详情或流程快照。
- 用具体 `git add <paths>`；不得提交 `.env*`、token、密码、数据库、日志、截图、`dist/` 或 `node_modules/`。

---

### Task 1: 等待节点结束时交给 AI

**Files:**
- Modify: `agent/autopilot.py`
- Test: `backend/tests/test_node_flow.py`

**Interfaces:**
- 保留原 `drain()` 编排接口；通过真实 drain 回归验证，没有后继时原入站文本传给 `_brain.chat`，有后继时仅推进节点。
- 不新增只用于测试的决策 helper，避免只测 helper 而遗漏实际 drain 分支。

- [x] 先写测试：终端等待节点任意回复返回 AI handoff；带 `any_reply` 后继的等待节点仍返回节点并且不 handoff。
- [x] 运行 `backend/.venv/Scripts/python.exe -m pytest -q backend/tests/test_node_flow.py -k terminal_wait_reply`，确认新测试因 chat 未被调用而失败。
- [x] 调整 awaiting 分支：只有继续推进节点时才标记消息跳过；终端 handoff 继续进入现有 `_brain.chat`，传入当前 `hint` 和流程发送摘要。
- [x] 重跑上述用例和完整 `backend/tests/test_node_flow.py`。

### Task 2: 管理员只读状态汇总

**Files:**
- Modify: `src/modules/agent/agent-flow.routes.ts`
- Test: `tests/agent-flow.test.ts`
- Update: `docs/API-接口清单.md`
- Modify: `frontend-vue/src/api/agent.ts`

**Interfaces:**
- 管理员调用 `GET /api/v1/agent/state?device_code=<code>&summary=1` 时返回 `{device_code, items:[{position_id,flow_version,node_key,phase,count,updated_at}]}`。
- 设备令牌调用原查询时继续返回兼容的逐会话响应。
- 管理员汇总请求必须提供单个 device_code；不得查询所有设备或返回会话标识/内容/快照。

- [x] 先写测试：管理员收到去标识汇总且不含快照；无设备码的管理员请求拒绝；设备令牌原响应不变。
- [x] 运行 `npx vitest run tests/agent-flow.test.ts -t "admin flow state summary"`，确认失败原因是现接口拒绝管理员汇总。
- [x] 实现仅限管理员的 summary 读取，SQL 按岗位/流程版本/节点/阶段分组；更新 API 文档和前端类型/API 方法。
- [x] 重跑定向 API 测试、`node scripts/check-api-doc.mjs` 与 `npx tsc --noEmit`。

### Task 3: 全屏画布和精细缩放

**Files:**
- Modify: `frontend-vue/src/components/agent/AgentFlowCanvas.vue`
- Create: `frontend-vue/src/components/agent/canvas-navigation.ts`
- Test: `tests/agent-flow-canvas-navigation.test.ts`
- Modify: `frontend-vue/src/views/AgentFlowView.vue`
- Test: `tests/agent-flow-page-contract.test.ts`

**Interfaces:**
- `AgentFlowCanvas` 保持 `fitToCanvas()` 暴露，并新增 `setZoom(value: number)`、`zoomBy(delta: number)`、`zoomPercent`。
- 页面 fullscreen 状态只控制布局，不更改流程 JSON 或 API 契约。

- [x] 先写页面合同测试，要求缩放按钮、百分比、全屏/退出、属性栏宽度调整可见。
- [x] 运行 `npx vitest run tests/agent-flow-page-contract.test.ts`，确认合同测试因控件缺失而失败。
- [x] 为画布加 25%–150% 缩放、加减/滑块/100%/适配、点击适配后居中；加应用内全屏切换和 Escape 退出。
- [x] 将检查器保持在画布右侧，添加可键盘操作的拖动分隔条，宽度限制 300–520px；窄屏改为纵向检查器。
- [x] 重跑页面合同测试和 Vue build。

### Task 4: 有效发送路径、岗位设备和解释面板

**Files:**
- Modify: `frontend-vue/src/views/AgentFlowView.vue`
- Modify: `frontend-vue/src/components/agent/AgentFlowCanvas.vue`
- Modify: `frontend-vue/src/api/agent.ts`
- Test: `tests/agent-flow-page-contract.test.ts`
- Create: `frontend-vue/src/components/agent/flow-runtime.ts`
- Create: `frontend-vue/src/components/agent/FlowRuntimeInspector.vue`
- Test: `tests/agent-flow-runtime.test.ts`

**Interfaces:**
- 页面读取岗位旧开场、设备列表和每个绑定设备的只读状态汇总。
- Effective route view derives from the selected position's flow status, bound devices and legacy openings; `no-bound-device`, `flow-enabled`, `flow-disabled-legacy`, and `runtime-mirror-unavailable` remain distinct states.

- [x] 先写合同测试：disabled + no device is shown as not running; enabled flow shows first-contact trigger, configured nodes and AI handoff; media sends and mirror-vs-delivery distinction have explicit labels.
- [x] 运行 `npx vitest run tests/agent-flow-page-contract.test.ts`，确认新增断言失败。
- [x] Load `devicesApi.list`, `agentApi.personaGet` openings and summary for only devices bound to selected position; no sender controls or write APIs are added.
- [x] Add a runtime path strip above the saved graph. Mark start conditions, continuous steps, reply gates, timeout followups, AI handoff and legacy fallback as descriptive system stages, visually distinct from editable persisted nodes.
- [x] Add inspector explanations for text, image/video, keyword/default, wait, timeout, disabled nodes and AI handoff. Preserve exact node body and media name; state that local state summaries are not delivery receipts.
- [x] Re-run targeted tests, `npx tsc --noEmit`, `npm run build --prefix frontend-vue`, and full Vitest.

### Task 5: End-to-end validation and delivery

**Files:**
- Verify: `docs/superpowers/specs/2026-11-21-flow-runtime-visualization-v2-design.md`
- Verify: `frontend-vue` desktop and narrow layouts
- Verify: active and disabled position effective-path states

- [ ] Run migration/API checks, all Vitest tests, the Python flow suite and frontend production build.
- [ ] Review the complete diff; confirm frozen WeCom hashes are unchanged and business flow/device records were not edited.
- [ ] Commit only the planned paths on `codex/flow-canvas-runtime-visualization`.
- [ ] Push branch, open PR, and merge after green checks under the user's standing test-server authorization.
- [ ] Confirm `main` deployment and the deployed login/flow page HTTP response; report the exact URL and evidence limits.

## Self-Review

- Every spec requirement maps to Tasks 1–5.
- The route state summary is explicitly scoped to one device and omits session identifiers and content.
- UI path stages are descriptive; only stored nodes/edges remain editable and saveable.
- No step sends messages or changes Shenzhen/device assignments.

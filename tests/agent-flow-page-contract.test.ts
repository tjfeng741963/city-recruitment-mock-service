import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

describe("招聘流程图入口接线", () => {
  it("registers the flow page under the existing knowledge-management route group", () => {
    const router = read("frontend-vue/src/router/index.ts");
    const menu = read("frontend-vue/src/layouts/MainLayout.vue");

    expect(router).toContain("path: 'recruitment-flow'");
    expect(router).toContain("component: () => import('../views/AgentFlowView.vue')");
    expect(router).toContain("title: '话术流程', group: 'AI 接待'");
    expect(read("frontend-vue/src/layouts/navigation.ts")).toContain("path: '/recruitment-flow'");
    expect(read("frontend-vue/src/layouts/navigation.ts")).toContain("label: '话术流程'");
  });

  it("routes the job list to the same position configuration page", () => {
    const list = read("frontend-vue/src/views/ServicePositionView.vue");
    expect(list).toContain("positionLink('/recruitment-flow', row.id)");
    expect(list).not.toContain("PositionAgentDrawer");
    expect(list).not.toContain("aiLinks");
  });

  it("shows the canvas by default in the page layout and keeps one configuration menu", () => {
    const page = read("frontend-vue/src/views/AgentFlowView.vue");
    const inspector = read("frontend-vue/src/components/agent/FlowRuntimeInspector.vue");
    expect(page).toContain("const fullscreen = ref(false)");
    expect(page.includes("canvasExpanded")).toBe(false);
    expect(page).toContain('id="flow-canvas-panel"');
    expect(page).toContain("岗位配置");
    expect(page).toContain('@command="openConfiguration"');
    expect(inspector).not.toContain("edit-opening");
    expect(inspector).not.toContain("manage-knowledge");
  });

  it('keeps shared knowledge and media accessible before a flow has loaded', () => {
    const page = read('frontend-vue/src/views/AgentFlowView.vue');
    const configurationMenu = page.match(/<el-dropdown[^>]*@command="openConfiguration"[^>]*>/)?.[0] || '';
    expect(configurationMenu.includes('!savedFlow')).toBe(false);
    expect(page).toContain('positionLink(command');
    expect(page).toContain('command="knowledge"');
    expect(page).toContain('command="media"');
  });

  it("keeps the selected position in the flow page route and reads its real graph", () => {
    const page = read("frontend-vue/src/views/AgentFlowView.vue");

    expect(page).toContain("route.query.position_id");
    expect(page).toContain("agentApi.flowGet(id)");
    expect(page).toContain("agentApi.flowSave(flow.value)");
    expect(page).toContain("flowRequiresEnableConfirmation");
    expect(page).toContain("Number(error?.response?.status) === 409");
  });

  it("confirms before leaving the route with unsaved edits", () => {
    const page = read("frontend-vue/src/views/AgentFlowView.vue");

    expect(page).toContain("onBeforeRouteLeave");
    expect(page).toContain("if (!isDirty.value) return true");
    expect(page).toContain("离开页面会丢弃尚未保存的流程修改");
  });

  it("reloads only the selected position when opening the location dropdown", () => {
    const page = read("frontend-vue/src/views/AgentFlowView.vue");
    expect(page).toMatch(/<el-select v-model="part\.interview_point"[^>]*@visible-change="refreshLocationPoints"/);

    const refresh = page.match(/async function refreshLocationPoints\([^]*?\n}/)?.[0] ?? "";
    expect(refresh).toContain("positionsApi.get(id)");
    expect(refresh).toContain("positions.value =");
    expect(refresh).not.toMatch(/loadFlow\(|\bflow\.value\s*=|baseline\.value\s*=/);
  });

  it("prevents selecting cached location options while refreshing or after a read failure", () => {
    const page = read("frontend-vue/src/views/AgentFlowView.vue");
    expect(page).toMatch(/<el-option v-for="point in locationPoints"[^>]*:disabled="locationPointsLoading \|\| Boolean\(locationPointsError\)"/);
    expect(page).toContain(':no-data-text="locationPointsError ||');
  });

  it('provides a full-screen workspace with a keyboard-accessible resizable inspector', () => {
    const page = read('frontend-vue/src/views/AgentFlowView.vue');
    expect(page).toMatch(/<el-button v-if="fullscreen"[^>]*@click="exitFullscreen"[^>]*>\s*返回普通视图/);
    expect(page).toContain('role="separator"');
    expect(page).toContain('inspectorWidth');
    expect(page).toContain("event.key === 'Escape'");
  });

  it('separates saved editing from the actual device path and labels evidence limits', () => {
    const page = read('frontend-vue/src/views/AgentFlowView.vue');
    expect(page).toContain('实际执行路径');
    expect(page).toContain('编辑流程');
    expect(page).toContain('未绑定设备');
    expect(page).toContain('不是送达回执');
    expect(page).toContain('agentApi.flowStateSummary');
    expect(page).toContain('FlowRuntimeInspector');
  });

  it('uses real media previews and shows the optional AI media sources', () => {
    const page=read('frontend-vue/src/views/AgentFlowView.vue');
    const inspector=read('frontend-vue/src/components/agent/FlowRuntimeInspector.vue');
    expect(page).toContain('buildAiMediaBranches');
    expect(page).toContain('agentApi.context');
    expect(inspector).toContain('FlowMediaPreview');
  });

  it('connects the existing opening editor, reports actual sync evidence and removes the unused node delay',()=>{
    const page=read('frontend-vue/src/views/AgentFlowView.vue');
    expect(page).toContain('PositionAgentDrawer');
    expect(page).toContain('command="opening"');
    expect(page).toContain('agentApi.configSync');
    expect(page).not.toContain('label="节点间隔（秒）"');
    expect(page).not.toContain('function setNodeDelay');
  });
});

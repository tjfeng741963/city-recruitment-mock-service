import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../frontend-vue/src/${path}`, import.meta.url), 'utf8');
}

describe('visible action labels', () => {
  it('uses the sidebar as the single navigation for AI reception pages', () => {
    const context = source('components/agent/PositionContext.vue');
    expect(context).not.toMatch(/RouterLink|position-links/);
    expect(source('layouts/MainLayout.vue')).toContain(':route="menuTarget(item.path)"');
  });

  it.each([
    ['views/KnowledgeView.vue', 'load', '刷新'],
    ['views/ConversationView.vue', 'leftCollapsed = true', '收起'],
    ['components/agent/AgentFlowCanvas.vue', 'zoomBy(-0.1)', '缩小'],
    ['components/agent/AgentFlowCanvas.vue', 'zoomBy(0.1)', '放大'],
    ['components/agent/AgentFlowCanvas.vue', 'setZoom(1)', '重置缩放'],
    ['components/basic/PositionAgentDrawer.vue', 'move(index, -1)', '上移'],
    ['components/basic/PositionAgentDrawer.vue', 'move(index, 1)', '下移'],
    ['views/AgentFlowView.vue', 'removePart(selectedNode!, index)', '删除内容'],
    ['views/AgentFlowView.vue', 'removeSelectedEdge', '删除连接'],
  ])('renders an action label in %s for %s', (path, click, label) => {
    const buttons = source(path).matchAll(/<el-button\b((?:"[^"]*"|[^"<>])*?)(?<!\/)>([^<]+)<\/el-button>/g);
    const labels = Array.from(buttons)
      .filter(([, attrs]) => attrs.includes(`@click="${click}"`))
      .map(([, , text]) => text.trim());
    expect(labels).toContain(label);
  });
});

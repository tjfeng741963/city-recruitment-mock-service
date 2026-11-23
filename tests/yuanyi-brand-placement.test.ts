import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('../frontend-vue/src/layouts/MainLayout.vue', import.meta.url), 'utf8');

describe('console brand placement', () => {
  it('shows the static Yuanyi mark beside the sidebar title, even when collapsed', () => {
    expect(layout).toMatch(/<div class="sidebar-logo">\s*<YuanyiMark\s+label="源绎"\s+class="sidebar-brand"\s*\/>/);
    expect(layout).toContain('<span v-if="!collapsed" class="logo-text">城市配置管理</span>');
  });

  it('keeps the original account avatar and account controls in the right header', () => {
    const header = layout.match(/<header class="top-header">([\s\S]+?)<\/header>/)?.[1] ?? '';
    expect(header).toContain('<el-avatar :size="32" class="user-avatar">{{ initial }}</el-avatar>');
    expect(header).toContain('class="user-name"');
    expect(header).toContain('@click="handleLogout"');
    expect(header).not.toContain('YuanyiMark');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('../frontend-vue/src/layouts/MainLayout.vue', import.meta.url), 'utf8');

describe('console brand placement', () => {
  it('keeps the static Yuanyi mark visible even when the sidebar is collapsed', () => {
    expect(layout).toMatch(/<div class="sidebar-logo">\s*<YuanyiMark\s+label="源绎"\s+class="sidebar-brand"\s*\/>/);
  });

  it('shows the signed-in username above the system name when expanded', () => {
    expect(layout).toMatch(
      /<div v-if="!collapsed" class="sidebar-brand-copy">\s*<span[^>]*class="sidebar-brand-account"[^>]*>\s*\{\{\s*auth\.user\?\.username\s*\}\}\s*<\/span>\s*<span class="sidebar-brand-name">源绎 AI 系统<\/span>/,
    );
    expect(layout).not.toContain('城市配置管理');
  });

  it('keeps the original account avatar and account controls in the right header', () => {
    const header = layout.match(/<header class="top-header">([\s\S]+?)<\/header>/)?.[1] ?? '';
    expect(header).toContain('<el-avatar :size="32" class="user-avatar">{{ initial }}</el-avatar>');
    expect(header).toContain('class="user-name"');
    expect(header).toContain('@click="handleLogout"');
    expect(header).not.toContain('YuanyiMark');
  });
});

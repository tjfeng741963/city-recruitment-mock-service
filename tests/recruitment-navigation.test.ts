import { describe, expect, it } from 'vitest';
import { navigationForRole, positionLink } from '../frontend-vue/src/layouts/navigation.js';

describe('招聘导航', () => {
  it('groups real tasks and keeps the two core windows accessible', () => {
    const groups = navigationForRole('admin');
    expect(groups.map(group => group.label)).toEqual(['首页', '日常招聘', '招聘资料', 'AI 接待', '账号与设置']);
    const items = groups.flatMap(group => group.items);
    expect(items.find(item => item.path === '/conversations')?.label).toBe('对话管理');
    expect(items.find(item => item.path === '/candidates')?.label).toBe('候选人管理');
    expect(items.find(item => item.path === '/recruitment-flow')?.label).toBe('话术流程');
    expect(new Set(items.map(item => item.path)).size).toBe(items.length);
    expect(items.some(item => item.path === '/city-links')).toBe(false);
  });
  it('lists one AI configuration entry in the sidebar', () => {
    const group = navigationForRole('admin').find(group => group.key === 'knowledge');
    expect(group?.items.map(item => item.path)).toEqual(['/recruitment-flow']);
  });
  it('only exposes account administration to admins and keeps role-specific recommendations reachable', () => {
    expect(navigationForRole('customer').some(group => group.key === 'system')).toBe(false);
    expect(navigationForRole('recruiter').flatMap(group => group.items).some(item => item.path === '/recruiter-featured')).toBe(true);
  });
  it('carries the selected position to each AI workspace', () => {
    expect(positionLink('/knowledge', 28)).toEqual({ path: '/knowledge', query: { position_id: '28' } });
    expect(positionLink('/media', 0)).toEqual({ path: '/media', query: {} });
  });
});

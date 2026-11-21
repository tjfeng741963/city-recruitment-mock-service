import { describe, expect, it } from 'vitest';
import { navigationForRole, positionLink, activeNavigationPath, cityPositionsLink } from '../frontend-vue/src/layouts/navigation.js';

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
  it('keeps knowledge and media independently discoverable for each existing role', () => {
    for (const role of ['admin','customer','recruiter']) {
      const group = navigationForRole(role).find(group => group.key === 'knowledge');
      expect(group?.items).toEqual([
        {path:'/recruitment-flow',label:'话术流程'},
        {path:'/knowledge',label:'问答知识库'},
        {path:'/media',label:'图片与视频'},
      ]);
    }
  });
  it('highlights knowledge and media as their own pages',()=>{
    expect(activeNavigationPath('/knowledge')).toBe('/knowledge');
    expect(activeNavigationPath('/media')).toBe('/media');
    expect(activeNavigationPath('/recruitment-flow')).toBe('/recruitment-flow');
    expect(activeNavigationPath('/device-report')).toBe('/dashboard');
  });
  it('only exposes account administration to admins and keeps role-specific recommendations reachable', () => {
    expect(navigationForRole('customer').some(group => group.key === 'system')).toBe(false);
    expect(navigationForRole('recruiter').flatMap(group => group.items).some(item => item.path === '/recruiter-featured')).toBe(true);
  });
  it('opens recruitment positions using the city ID', () => {
    expect(cityPositionsLink(42)).toEqual({ path: '/service-positions', query: { city_id: '42' } });
  });
  it('carries the selected position to each AI workspace', () => {
    expect(positionLink('/knowledge', 28)).toEqual({ path: '/knowledge', query: { position_id: '28' } });
    expect(positionLink('/media', 0)).toEqual({ path: '/media', query: {} });
  });
});

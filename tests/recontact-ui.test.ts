import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { navigationForRole } from '../frontend-vue/src/layouts/navigation.js';
import {
  conversationRoute, recontactReturnRoute, reorderParts, selectedTemplateIds, toMinute,
} from '../frontend-vue/src/components/recontact/recontact-view.js';

describe('复聊板块页面行为', () => {
  it('opens a standalone recruitment page immediately after 对话管理', () => {
    for (const role of ['admin', 'recruiter']) {
      const items = navigationForRole(role).find(group => group.key === 'operations')?.items ?? [];
      const index = items.findIndex(item => item.path === '/conversations');
      expect(items[index + 1]).toEqual({ path: '/recontact', label: '复聊板块' });
    }
    expect(navigationForRole('customer').flatMap(group => group.items).some(item => item.path === '/recontact')).toBe(false);
    const routes = readFileSync(new URL('../frontend-vue/src/router/index.ts', import.meta.url), 'utf8');
    expect(routes).toMatch(/path: 'recontact'[\s\S]*?import\('\.\.\/views\/RecontactView\.vue'\)/);
  });

  it('keeps the interval with its message when reordering mixed parts', () => {
    const text = { kind: 'text', value: '想来面试吗？', delay_ms: 0 } as const;
    const location = { kind: 'location', value: 'interview-1', delay_ms: 3000 } as const;
    const image = { kind: 'image', value: 'photo.jpg', delay_ms: 1000 } as const;
    const original = [text, location, image];
    expect(reorderParts(original, 1, -1)).toEqual([location, text, image]);
    expect(original).toEqual([text, location, image]);
    expect(reorderParts(original, 0, -1)).toEqual(original);
    expect(toMinute('09:30')).toBe(570);
  });

  it('associates each selected position with its own template', () => {
    expect(selectedTemplateIds([18, 21, 18], { 18: 2, 21: 6, 99: 9 })).toEqual({ 18: 2, 21: 6 });
    expect(selectedTemplateIds([18, 21], { 18: 2 })).toEqual({ 18: 2 });
  });

  it('opens the exact conversation and preserves filters on return', () => {
    const query = { position_id: '18', device_code: 'other-pc', status: 'unknown' };
    const link = conversationRoute({ device_code: 'test-pc', customer_id: 73 }, query);
    expect(link).toMatchObject({ name: 'conversations', query: { device_code: 'test-pc', customer_id: '73' } });
    expect(recontactReturnRoute(link.query)).toEqual({
      name: 'recontact', query: { tab: 'records', ...query },
    });
  });
});

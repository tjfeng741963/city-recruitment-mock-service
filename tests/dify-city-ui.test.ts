import {existsSync,readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('city settings and recruitment entry points',()=>{
 it('keeps city basics editable and retires the old city materials popup',()=>{
  const drawer=readFileSync('frontend-vue/src/components/basic/CityFormDrawer.vue','utf8');
  expect(drawer).toContain('citiesApi.updateBasics');
  expect(drawer).not.toContain('data-city-default-materials');
  expect(drawer).not.toContain('编辑城市默认资料');
  expect(drawer).not.toContain('薪资原文');
  expect(drawer).not.toContain('面试通知模板');
  expect(readFileSync('frontend-vue/src/views/CityView.vue','utf8')).not.toContain('复制城市');
  expect(existsSync('public/theme/city-dify-sources.js')).toBe(false);
  expect(readFileSync('public/index.html','utf8')).not.toContain('/theme/city-dify-sources.js');
 });
 it('shows existing city overrides in the position form and sends knowledge tests to the canvas',()=>{
  const position=readFileSync('frontend-vue/src/components/basic/PositionFormDrawer.vue','utf8');
  const knowledge=readFileSync('frontend-vue/src/views/KnowledgeView.vue','utf8');
  expect(position).toContain('Dify 当前城市取值');
  expect(knowledge).toContain("receptionTestHref('dify', { positionId })");
  expect(knowledge).not.toContain('<PositionQa');
 });
});

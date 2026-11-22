import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('restored original city and knowledge entries',()=>{
 it('keeps current Dify city materials reachable in the collapsed settings area',()=>{
  const drawer=readFileSync('frontend-vue/src/components/basic/CityFormDrawer.vue','utf8');
  const script=readFileSync('public/theme/city-dify-sources.js','utf8');
  const extra=drawer.match(/<details[^>]*class="city-defaults"[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
  expect(extra).toContain('城市默认资料');
  expect(extra).toContain('data-city-default-materials');
  expect(drawer).not.toContain('薪资原文');
  expect(drawer).not.toContain('面试通知模板');
  expect(readFileSync('frontend-vue/src/views/CityView.vue','utf8')).not.toContain('复制城市');
  expect(script).toContain('data-city-default-materials');
  expect(script).not.toContain('data-city-dify-editor');
  expect(script).toContain('base.prompt_sections');
  expect(script).toContain('base.prompt_section_labels');
  expect(script).toContain('base.interview_site_name');
  expect(script).toContain('base.available_lines');
  expect(script).toContain("'/api/v1/dify/cities/'");
  expect(readFileSync('public/index.html','utf8')).toContain('/theme/city-dify-sources.js');
 });
 it('keeps city material editing and sends knowledge tests to the canvas',()=>{
  const theme=readFileSync('public/theme/city-dify-sources.js','utf8');
  const knowledge=readFileSync('frontend-vue/src/views/KnowledgeView.vue','utf8');
  expect(theme).not.toContain('/api/v1/dify/preview');
  expect(theme).not.toContain('/dify-connection');
  expect(knowledge).toContain("receptionTestHref('dify', { positionId })");
  expect(knowledge).not.toContain('<PositionQa');
 });
});

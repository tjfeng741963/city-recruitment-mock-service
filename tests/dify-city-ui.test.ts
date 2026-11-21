import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('restored original city and knowledge entries',()=>{
 it('restores visible city fields and links complete materials from the city drawer',()=>{
  const guidance=readFileSync('public/theme/recruitment-page-guidance.js','utf8');
  expect(guidance).not.toContain('城市默认资料仅用于新建岗位');
  expect(guidance).toContain('const HIDDEN_CITY_FIELDS = new Set([])');
  const script=readFileSync('public/theme/city-dify-sources.js','utf8');
  expect(script).toContain('编辑完整城市原文资料');
  expect(script).toContain("base.prompt_sections");
  expect(script).toContain("base.prompt_section_labels");
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

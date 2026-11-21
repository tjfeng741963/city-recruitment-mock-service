import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('reply sources in the canvas',()=>{
 it('uses the canvas to host both reply sources and removes the extra sidebar block',()=>{
  const shell=readFileSync('public/index.html','utf8');
  const canvas=readFileSync('frontend-vue/src/views/AgentFlowView.vue','utf8');
  expect(shell).not.toContain('/theme/reply-modes.js');
  expect(canvas).toContain('<ReceptionTestDrawer');
  const drawer=readFileSync('frontend-vue/src/components/agent/ReceptionTestDrawer.vue','utf8');
  expect(drawer).toContain('系统 Agent');
  expect(drawer).toContain('Dify 工作流');
 });
});

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
  expect(drawer.includes('saveReplyProvider')).toBe(false);
  expect(drawer).toContain('to="/agent-devices"');
 });

 it('explains both reception scopes in the existing machine switch confirmation',()=>{
  const control=readFileSync('frontend-vue/src/components/agent/ReplyModeSwitch.vue','utf8');
  expect(control).toContain('Agent 使用一个绑定岗位');
  expect(control).toContain('Dify 可在配置范围内接待多个岗位');
  expect(control).toMatch(/ElMessageBox\.confirm\(\s*`机器码 \$\{props\.deviceCode\}。\$\{scopeHint\(target\)\}/);
 });
});

import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('distinct reply mode labels',()=>{
 it('exposes Dify mode separately from the original Agent in the public shell',()=>{
  const shell=readFileSync('public/index.html','utf8');
  expect(shell).toContain('/theme/reply-modes.js');
  const script=readFileSync('public/theme/reply-modes.js','utf8');
  expect(script).toContain('模式一 · 系统 Agent');
  expect(script).toContain('模式二 · Dify 工作流');
  expect(script).toContain('/dify-connection');
  expect(script).not.toContain('/recruitment-flow');
 });
 it('labels the separate connection page and selector consistently',()=>{
  const html=readFileSync('public/dify-connection.html','utf8');
  expect(html).toContain('模式二 · Dify 工作流');
  expect(html).toContain('模式一 · 系统 Agent');
 });
});

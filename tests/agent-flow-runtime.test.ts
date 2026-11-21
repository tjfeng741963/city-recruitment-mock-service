import { describe, expect, it } from 'vitest';
import { buildRuntimeFlow, describeRuntimeNode, compareOpeningContents } from '../frontend-vue/src/components/agent/flow-runtime.js';

const legacy = [
  { id: 1, seq: 1, kind: 'text', content: '招聘要求', status: 'enabled', delay_ms: 2000 },
  { id: 2, seq: 2, kind: 'video', media_name: '安检.mp4', status: 'enabled', delay_ms: 2000 },
];
const flow = {
  position_id: 25, version: 3, status: 'enabled', entry_key: 'intro',
  nodes: [{ node_key: 'intro', node_type: 'text', status: 'enabled', await_reply: true, parts: [{ kind: 'text', body: '招聘要求' }] }],
  edges: [{ from_key: 'intro', to_key: '', trigger: 'any_reply' }],
};

describe('actual recruitment flow presentation', () => {
  it('shows the legacy continuous opening path when the saved node flow is disabled', () => {
    const displayed = buildRuntimeFlow({ ...flow, status: 'disabled' }, legacy);
    expect(displayed.nodes.find(n => n.node_key === 'legacy_2')?.parts?.[0]).toMatchObject({ kind: 'video', media_name: '安检.mp4' });
    expect(displayed.edges).toContainEqual(expect.objectContaining({ from_key: 'legacy_1', to_key: 'legacy_2', trigger: 'default' }));
    expect(displayed.nodes.some(n => n.node_key === 'intro')).toBe(false);
    expect(displayed.nodes.at(-1)?.node_type).toBe('system_ai');
  });

  it('connects persisted flow entry and terminal waiting reply to AI without modifying the saved graph', () => {
    const displayed = buildRuntimeFlow(flow, legacy);
    expect(displayed.edges).toContainEqual(expect.objectContaining({ from_key: '__runtime_start', to_key: 'intro' }));
    expect(displayed.edges).toContainEqual(expect.objectContaining({ from_key: 'intro', to_key: '__runtime_ai', trigger: 'any_reply' }));
    expect(flow.edges[0].to_key).toBe('');
  });

  it('describes media prefetch, target verification and waiting gates in plain language', () => {
    const media = { node_key: 'video', node_type: 'text', status: 'enabled', await_reply: true, wait_minutes: 15, parts: [{ kind: 'video', media_name: '安检.mp4' }] };
    const explanation = describeRuntimeNode(media, { ...flow, nodes: [media] }, false).join(' ');
    expect(explanation).toContain('先查 Windows 本地素材');
    expect(explanation).toContain('本轮先成功发送文本');
    expect(explanation).toContain('等待客户回复');
    expect(explanation).toContain('15 分钟');
  });

  it('does not claim configured node order or waits match just because legacy message bodies match', () => {
    expect(compareOpeningContents(flow, [legacy[0]])).toBe(true);
    expect(compareOpeningContents(flow, legacy)).toBe(false);
  });

  it('draws only the bypass edge of a disabled node and does not turn disabled followup into a wait', () => {
    const disabled = { ...flow, entry_key: 'skip', nodes: [
      { node_key: 'skip', node_type: 'text', status: 'disabled', await_reply: true, parts: [] },
      { node_key: 'followup', node_type: 'followup', status: 'disabled', parts: [] },
      ...flow.nodes,
    ], edges: [
      { from_key: 'skip', to_key: 'intro', trigger: 'any_reply' },
      { from_key: 'skip', to_key: 'followup', trigger: 'timeout' },
      { from_key: 'followup', to_key: 'intro', trigger: 'default' },
      ...flow.edges,
    ] };
    const displayed = buildRuntimeFlow(disabled, []);
    expect(displayed.edges.some(edge => edge.from_key === 'skip' && edge.trigger === 'timeout')).toBe(false);
    expect(displayed.edges.find(edge => edge.from_key === 'followup')?.to_key).toBe('intro');
    expect(displayed.edges.find(edge => edge.from_key === 'skip')?.runtime_label).toContain('停用');
  });

  it('shows branch keyword empty target as its actual default fallback', () => {
    const branched = { ...flow, entry_key: 'branch', nodes: [{ node_key: 'branch', node_type: 'branch', status: 'enabled', parts: [] }, ...flow.nodes], edges: [
      { from_key: 'branch', to_key: '', trigger: 'keyword', condition_value: '工资' },
      { from_key: 'branch', to_key: 'intro', trigger: 'default' },
      ...flow.edges,
    ] };
    const displayed = buildRuntimeFlow(branched, []);
    expect(displayed.edges.find(edge => edge.from_key === 'branch' && edge.trigger === 'keyword')?.to_key).toBe('intro');
  });

  it('describes legacy media timing and failure behavior without promising node-flow guarantees', () => {
    const displayed = buildRuntimeFlow({ ...flow, status: 'disabled' }, legacy);
    const video = displayed.nodes.find(node => node.node_key === 'legacy_2')!;
    const explanation = describeRuntimeNode(video, displayed, true).join(' ');
    expect(explanation).toContain('冷却配置');
    expect(explanation).toContain('媒体失败会记录失败并继续');
    expect(explanation).not.toContain('本轮先成功发送文本');
  });

  it('compares actual graph order rather than stored array order', () => {
    const other = { node_key: 'next', node_type: 'text', status: 'enabled', parts: [{kind:'text',body:'薪资待遇'}] };
    const ordered = {...flow,nodes:[other,...flow.nodes],edges:[{from_key:'intro',to_key:'next',trigger:'any_reply'},{from_key:'next',to_key:'',trigger:'any_reply'}]};
    expect(compareOpeningContents(ordered,[legacy[0],{seq:2,kind:'text',content:'薪资待遇',status:'enabled'}])).toBe(true);
  });

  it('does not display keyword routes that a continuous message node never evaluates', () => {
    const continuous = {...flow,nodes:flow.nodes.map(node=>({...node,await_reply:false})),edges:[
      {from_key:'intro',to_key:'',trigger:'default'},
      {from_key:'intro',to_key:'',trigger:'keyword',condition_value:'工资'},
    ]};
    expect(buildRuntimeFlow(continuous,[]).edges.some(edge=>edge.from_key==='intro'&&edge.trigger==='keyword')).toBe(false);
  });
});

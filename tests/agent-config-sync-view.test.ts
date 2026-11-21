import { describe, expect, it } from 'vitest';
import { configurationSyncView } from '../frontend-vue/src/components/agent/config-sync-view.js';

const now=Date.parse('2026-11-21T10:00:30Z');
const device={available:true,device_code:'pc',client_commit:'a'.repeat(40),server_received_at:'2026-11-21T10:00:20Z',
  flow:{position_id:25,version:3,status:'enabled',state:'synced',synced_at:'2026-11-21T10:00:00Z',checked_at:'2026-11-21T10:00:00Z',error:''},
  opening:{position_id:25,version:'b'.repeat(64),state:'synced',synced_at:'2026-11-21T10:00:00Z',checked_at:'2026-11-21T10:00:00Z',error:''}};

describe('configuration sync evidence shown to operators',()=>{
  it('marks matching device pull evidence as synced but never as delivery',()=>{
    const view=configurationSyncView(device,{mode:'flow',positionId:25,version:3},now);
    expect(view.state).toBe('synced');
    expect(view.label).toContain('已拉取');
    expect(view.label).not.toContain('送达');
  });
  it('does not substitute server versions for missing client evidence',()=>{
    expect(configurationSyncView(null,{mode:'flow',positionId:25,version:3},now).state).toBe('unknown');
    expect(configurationSyncView({...device,available:false},{mode:'flow',positionId:25,version:3},now).state).toBe('unknown');
  });
  it('distinguishes stale data, old positions, pending versions and old heartbeats',()=>{
    expect(configurationSyncView({...device,flow:{...device.flow,state:'stale',error:'network'}},{mode:'flow',positionId:25,version:3},now).state).toBe('stale');
    expect(configurationSyncView(device,{mode:'flow',positionId:22,version:3},now).state).toBe('pending');
    expect(configurationSyncView(device,{mode:'flow',positionId:25,version:4},now).state).toBe('pending');
    expect(configurationSyncView({...device,server_received_at:'2026-11-21T09:00:00Z'},{mode:'flow',positionId:25,version:3},now).state).toBe('stale');
  });
  it('compares the actual opening fingerprint when the node flow is disabled',()=>{
    const legacy={...device,flow:{...device.flow,status:'disabled'}};
    expect(configurationSyncView(legacy,{mode:'opening',positionId:25,version:'b'.repeat(64),flowVersion:3},now).state).toBe('synced');
    expect(configurationSyncView(legacy,{mode:'opening',positionId:25,version:'c'.repeat(64),flowVersion:3},now).state).toBe('pending');
    expect(configurationSyncView({...legacy,opening:{...device.opening,state:'blocked',error:'auth'}},{mode:'opening',positionId:25,version:'b'.repeat(64),flowVersion:3},now).state).toBe('blocked');
  });
  it('shows a first-pull authentication block even before any success exists',()=>{
    expect(configurationSyncView({...device,flow:{...device.flow,state:'blocked',version:0,synced_at:null,error:'auth'}},{mode:'flow',positionId:25,version:3},now).state).toBe('blocked');
  });
  it('does not show legacy sync as green while cached enabled flow can still control routing',()=>{
    const expected={mode:'opening' as const,positionId:25,version:'b'.repeat(64),flowVersion:4};
    expect(configurationSyncView(device,expected,now).state).toBe('pending');
    expect(configurationSyncView({...device,flow:{...device.flow,state:'stale',error:'network'}},expected,now).state).toBe('stale');
    expect(configurationSyncView({...device,flow:null},expected,now).state).toBe('unknown');
    expect(configurationSyncView({...device,flow:{...device.flow,status:'disabled',version:4}},expected,now).state).toBe('synced');
  });
});

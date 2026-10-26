import { describe, expect, it } from 'vitest';
import { WeComClient } from '../src/modules/wecom/wecom-client.js';

describe('official WeCom API client', () => {
  it('caches credentials, refreshes an expired token once and never returns credentials in errors', async () => {
    const calls: string[] = [];
    let token = 0, sync = 0;
    const fakeFetch = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname; calls.push(path);
      if (path.endsWith('/gettoken')) return Response.json({ access_token: `secret-token-${++token}`, expires_in: 7200 });
      if (path.endsWith('/sync_msg') && sync++ === 0) return Response.json({ errcode: 42001, errmsg: 'DO-NOT-LOG-secret-token' });
      return Response.json({ errcode: 0, next_cursor: 'cursor', has_more: 0, msg_list: [] });
    };
    const client = new WeComClient({ corpId: 'corp', secret: 'secret' }, fakeFetch as typeof fetch);
    await client.call('kf/sync_msg', { open_kfid: 'kf' });
    await client.call('kf/sync_msg', { open_kfid: 'kf' });
    expect(calls.filter(p => p.endsWith('/gettoken'))).toHaveLength(2);
    const failed = new WeComClient({ corpId: 'corp', secret: 'secret' }, (async () => Response.json({ errcode: 40013, errmsg: 'DO-NOT-LOG-secret' })) as typeof fetch);
    await expect(failed.call('kf/sync_msg', {})).rejects.toThrow('WeCom API error 40013');
  });
  it('treats network loss as uncertain and does not automatically repeat a send', async () => {
    let sends = 0;
    const client = new WeComClient({ corpId: 'corp', secret: 'secret' }, (async (url: string) => {
      if (String(url).includes('gettoken')) return Response.json({ access_token: 'token', expires_in: 7200 });
      sends++; throw new Error('network failure with token in URL');
    }) as typeof fetch);
    await expect(client.call('kf/send_msg', {})).rejects.toMatchObject({ uncertain: true });
    expect(sends).toBe(1);
  });
});

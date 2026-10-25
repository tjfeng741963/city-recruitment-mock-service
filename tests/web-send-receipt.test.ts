import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
// @ts-expect-error standalone device ESM module
import { sendWebTextWithReceipt } from '../bridge/web-send-receipt.mjs';

const request = (to = '@contact', text = 'hello') => ({
  method: () => 'POST',
  url: () => 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxsendmsg?pass_ticket=not-logged',
  postData: () => JSON.stringify({ Msg: { Type: 1, FromUserName: '@self', ToUserName: to, Content: text } }),
});
const response = (req: object, data: object, status = 200) => ({
  request: () => req, status: () => status, json: async () => data,
});

describe('Web WeChat physical send receipts', () => {
  it('gets the exact server message ID when SDK say resolves without a result', async () => {
    const page = new EventEmitter();
    let sends = 0;
    const id = '4520385745174034093';
    const actual = await sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: 'hello', send: async () => {
      sends++;
      const unrelated = request('@other');
      page.emit('request', unrelated);
      page.emit('response', response(unrelated, { BaseResponse: { Ret: 0 }, MsgID: '111' }));
      const matching = request();
      page.emit('request', matching);
      // An old response with the same recipient/body must not match this send.
      page.emit('response', response(request(), { BaseResponse: { Ret: 0 }, MsgID: '222' }));
      page.emit('response', response(matching, { BaseResponse: { Ret: 0 }, MsgID: id }));
      return undefined;
    } });
    expect(actual).toBe(id);
    expect(sends).toBe(1);
    expect(page.eventNames()).toEqual([]);
  });

  it.each([
    { BaseResponse: { Ret: 1205 }, MsgID: '123' },
    { BaseResponse: { Ret: 0 } },
    { BaseResponse: { Ret: 0 }, MsgID: Number.MAX_SAFE_INTEGER + 1 },
  ])('keeps rejected or unverifiable sends uncertain: %j', async data => {
    const page = new EventEmitter();
    await expect(sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: 'hello', send: async () => {
      const req = request();
      page.emit('request', req);
      page.emit('response', response(req, data));
    } })).rejects.toThrow();
    expect(page.eventNames()).toEqual([]);
  });

  it('times out without a receipt, cleans observers and never resends', async () => {
    const page = new EventEmitter();
    let sends = 0;
    await expect(sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: 'hello', timeoutMs: 20, send: async () => { sends++; } })).rejects.toThrow(/receipt/i);
    expect(sends).toBe(1);
    expect(page.eventNames()).toEqual([]);
  });

  it('does not confuse literal HTML entities with different message content', async () => {
    const page = new EventEmitter();
    const id = await sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: '&lt;', send: async () => {
      const other = request('@contact', '<');
      page.emit('request', other);
      page.emit('response', response(other, { BaseResponse: { Ret: 0 }, MsgID: '111' }));
      const correct = request('@contact', '&lt;');
      page.emit('request', correct);
      page.emit('response', response(correct, { BaseResponse: { Ret: 0 }, MsgID: '222' }));
    } });
    expect(id).toBe('222');
  });

  it('cannot confirm a failed HTTP send or a page that closes mid-send', async () => {
    for (const mode of ['http-failed', 'closed']) {
      const page = new EventEmitter();
      await expect(sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: 'hello', send: async () => {
        if (mode === 'closed') { page.emit('close'); return; }
        const req = request();
        page.emit('request', req);
        page.emit('response', response(req, { BaseResponse: { Ret: 0 }, MsgID: '123' }, 500));
      } })).rejects.toThrow(/receipt/);
      expect(page.eventNames()).toEqual([]);
    }
  });

  it('pauses the page after uncertainty so a late physical send cannot confirm a new one', async () => {
    const page = new EventEmitter();
    let release: () => void = () => {};
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const oldSend = async () => {
      await delayed;
      const oldRequest = request();
      page.emit('request', oldRequest);
      page.emit('response', response(oldRequest, { BaseResponse: { Ret: 0 }, MsgID: '111' }));
    };
    await expect(sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: 'hello', timeoutMs: 20, send: oldSend })).rejects.toThrow(/receipt/);
    let newSends = 0;
    const next = sendWebTextWithReceipt({ page, accountId: '@self', contactId: '@contact', text: 'hello', send: async () => { newSends++; } });
    release();
    await expect(next).rejects.toThrow(/paused/i);
    expect(newSends).toBe(0);
    expect(page.eventNames()).toEqual([]);
  });
});

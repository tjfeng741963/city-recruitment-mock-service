import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WeComCrypto, parseCallbackXml } from '../src/modules/wecom/wecom-crypto.js';

const aes = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
const key = aes.toString('base64').replace(/=+$/, '');
const signature = (cipher: string) => createHash('sha1').update(['test-token', '100', 'nonce', cipher].sort().join('')).digest('hex');
function encrypt(message: string, corp = 'ww-test') {
  const len = Buffer.alloc(4); len.writeUInt32BE(Buffer.byteLength(message));
  const data = Buffer.concat([Buffer.alloc(16, 1), len, Buffer.from(message), Buffer.from(corp)]);
  const padding = 32 - data.length % 32;
  const cipher = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([data, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}
describe('official WeCom callback authentication', () => {
  const crypto = new WeComCrypto('test-token', key, 'ww-test');
  it('verifies URL challenges and decrypts authenticated callback XML', () => {
    const cipher = encrypt('<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[sync-token]]></Token></xml>');
    expect(parseCallbackXml(crypto.decrypt(cipher, signature(cipher), '100', 'nonce')).Event).toBe('kf_msg_or_event');
    const echo = encrypt('url-challenge');
    expect(crypto.decrypt(echo, signature(echo), '100', 'nonce')).toBe('url-challenge');
  });
  it('rejects changed signatures, ciphertext and other enterprise identities', () => {
    const cipher = encrypt('hello');
    expect(() => crypto.decrypt(cipher, '0'.repeat(40), '100', 'nonce')).toThrow();
    expect(() => crypto.decrypt(cipher, signature(cipher), '101', 'nonce')).toThrow();
    const other = encrypt('hello', 'other-corp');
    expect(() => crypto.decrypt(other, signature(other), '100', 'nonce')).toThrow(/identity/i);
    const broken = Buffer.from(cipher, 'base64'); broken[broken.length - 1] ^= 1;
    const bad = broken.toString('base64');
    expect(() => crypto.decrypt(bad, signature(bad), '100', 'nonce')).toThrow();
  });
  it('rejects XML entity declarations and duplicate fields instead of resolving them', () => {
    expect(() => parseCallbackXml('<!DOCTYPE xml [<!ENTITY x SYSTEM "file:///etc/passwd">]><xml><Encrypt>&x;</Encrypt></xml>')).toThrow();
    expect(() => parseCallbackXml('<xml><Encrypt>a</Encrypt><Encrypt>b</Encrypt></xml>')).toThrow();
  });
});

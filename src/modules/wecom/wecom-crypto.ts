import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export function parseCallbackXml(xml: string): Record<string, string> {
  if (Buffer.byteLength(xml) > 131072 || /<!DOCTYPE|<!ENTITY|<!(?!\[CDATA\[)/i.test(xml)) throw new Error('Invalid callback XML');
  const root = /^\s*(?:<\?xml\b[^>]*\?>\s*)?<xml\s*>([\s\S]*)<\/xml>\s*$/i.exec(xml);
  if (!root) throw new Error('Invalid callback XML root');
  const fields: Record<string, string> = {};
  const body = root[1];
  let offset = 0;
  const tag = /<([A-Za-z][A-Za-z0-9_]*)\s*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))<\/\1\s*>/gy;
  while (offset < body.length) {
    tag.lastIndex = offset;
    const match = tag.exec(body);
    if (!match) {
      if (/^\s*$/.test(body.slice(offset))) break;
      throw new Error('Invalid callback XML field');
    }
    const name = match[1];
    if (Object.prototype.hasOwnProperty.call(fields, name)) throw new Error('Duplicate callback field');
    fields[name] = (match[2] ?? match[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    offset = tag.lastIndex;
  }
  if (!Object.keys(fields).length) throw new Error('Empty callback XML');
  return fields;
}
export class WeComCrypto {
  private readonly key: Buffer;
  constructor(private readonly token: string, key: string, private readonly corp: string) {
    this.key = Buffer.from(key + '=', 'base64');
    if (!/^[A-Za-z0-9+/]{43}$/.test(key) || this.key.length !== 32 || !token || !corp) throw new Error('Invalid WeCom callback configuration');
  }
  decrypt(cipher: string, signature: string, timestamp: string, nonce: string): string {
    const expected = createHash('sha1').update([this.token, timestamp, nonce, cipher].sort().join('')).digest('hex');
    if (!/^[a-f0-9]{40}$/i.test(signature) || !timestamp || !nonce || !timingSafeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected))) throw new Error('Invalid callback signature');
    const encrypted = Buffer.from(cipher, 'base64');
    if (!encrypted.length || encrypted.length % 16 !== 0) throw new Error('Invalid callback ciphertext');
    const decipher = createDecipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16)); decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const pad = padded[padded.length - 1];
    if (!pad || pad > 32 || padded.subarray(-pad).some(b => b !== pad)) throw new Error('Invalid callback padding');
    const data = padded.subarray(0, -pad);
    if (data.length < 20) throw new Error('Invalid callback frame');
    const size = data.readUInt32BE(16);
    if (size > data.length - 20) throw new Error('Invalid callback frame length');
    if (data.subarray(20 + size).toString('utf8') !== this.corp) throw new Error('Callback enterprise identity mismatch');
    return data.subarray(20, 20 + size).toString('utf8');
  }
}

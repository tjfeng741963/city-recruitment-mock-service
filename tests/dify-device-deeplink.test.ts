import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

async function openDifyPage(search:string) {
  const elements=new Map<string,any>();
  const element=()=>({value:'',textContent:'',className:'',children:[] as any[],append(child:any){this.children.push(child);},replaceChildren(){this.children=[];}});
  const document={getElementById:(id:string)=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element};
  const fetch=vi.fn(async(url:string)=>({ok:true,json:async()=>url==='/api/v1/agent/devices'?{items:[{device_code:'pc-win-01',name:'账号一'},{device_code:'dify-sandbox-only',name:'网页测试'}]}:{provider:'dify',configured:true}}));
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('document','crypto','localStorage','fetch','location','URLSearchParams',readFileSync('public/dify-connection.js','utf8'))
    (document,webcrypto,{getItem:()=> 'local-test-token'},fetch,{search},URLSearchParams);
  return {elements,fetch};
}

describe('Dify device deep link',()=>{
  it('selects the requested account and reads its actual provider without saving',async()=>{
    const {elements,fetch}=await openDifyPage('?device_code=pc-win-01');
    expect(elements.get('device').value).toBe('pc-win-01');
    expect(elements.get('provider').value).toBe('dify');
    expect(fetch.mock.calls.map(c=>c[0])).toContain('/api/v1/agent/devices/pc-win-01/reply-provider');
    expect(fetch.mock.calls.every(c=>(c as any)[1]?.method==='GET')).toBe(true);
  });
  it('does not silently select another account for an unavailable link',async()=>{
    const {elements,fetch}=await openDifyPage('?device_code=missing');
    expect(elements.get('device').value).toBe('');
    expect(elements.get('notice').textContent).toContain('不存在或无权访问');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

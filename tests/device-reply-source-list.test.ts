import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('account list reply source', () => {
  const previous=process.env.REA_DATABASE_PATH;
  let app: ReturnType<typeof buildServer>;
  afterEach(async()=>{await app?.close(); if(previous===undefined)delete process.env.REA_DATABASE_PATH;else process.env.REA_DATABASE_PATH=previous;});
  it('returns the effective source without returning Dify credentials', async()=>{
    process.env.REA_DATABASE_PATH=':memory:'; app=buildServer();await app.ready();
    const auth=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'local-admin',password:'local-demo-only'}});
    for(const [code,provider] of [['source-agent',undefined],['source-dify','dify'],['source-invalid','bad']]){
      app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)")
        .run(code,JSON.stringify({device_code:code,reply_provider:provider,dify_key:'secret-must-not-return'}));
    }
    const result=await app.inject({url:'/api/v1/agent/devices',headers:{authorization:`Bearer ${auth.json().access_token}`}});
    expect(result.statusCode).toBe(200);
    const items=result.json().items;
    expect(items.find((d:any)=>d.device_code==='source-agent').reply_provider).toBe('agent');
    expect(items.find((d:any)=>d.device_code==='source-dify').reply_provider).toBe('dify');
    expect(items.find((d:any)=>d.device_code==='source-invalid').reply_provider).toBe('agent');
    expect(result.body).not.toContain('secret-must-not-return');
  });
  it('uses fresh bridge heartbeat even when the legacy device flag is stale', async () => {
    process.env.REA_DATABASE_PATH=':memory:'; app=buildServer();await app.ready();
    const auth=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'local-admin',password:'local-demo-only'}});
    const add=app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)");
    const pair=app.db.prepare("INSERT INTO bridge_devices(device_code,token_hash,state,heartbeat_at) VALUES (?,?,?,?)");
    const now=Date.now();
    for (const [code,state,heartbeat] of [['expired','online',now-61000],['ready','online',now],['scan','scanning',now]] as const) {
      add.run(code,JSON.stringify({device_code:code,online:code!=='ready'}));
      pair.run(code,'secret',state,heartbeat);
    }
    const response=await app.inject({url:'/api/v1/agent/devices',headers:{authorization:`Bearer ${auth.json().access_token}`}});
    const items=response.json().items;
    const device=(code:string)=>items.find((row:{device_code:string})=>row.device_code===code);
    expect(device('expired')).toMatchObject({online:false,status:false,bridge_state:'offline',last_heartbeat_at:new Date(now-61000).toISOString()});
    expect(device('ready')).toMatchObject({online:true,status:true,bridge_state:'online',last_heartbeat_at:new Date(now).toISOString()});
    expect(device('scan')).toMatchObject({online:false,bridge_state:'scanning'});
  });
});

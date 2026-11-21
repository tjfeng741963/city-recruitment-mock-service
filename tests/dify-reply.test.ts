import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";
import { DeviceBridgeStore } from "../src/modules/messaging/device-bridge.js";

describe("Dify second reply route", () => {
  let app: FastifyInstance;
  let admin: Record<string,string>;
  let device: Record<string,string>;
  let position: number;
  const saved = { ...process.env };
  const code = "dify-test-device";
  beforeEach(async () => {
    process.env.REA_DATABASE_PATH=":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER="bridge";
    process.env.REA_DIFY_BASE_URL="http://127.0.0.1:5999/v1";
    process.env.REA_DIFY_API_KEY="test-only-key";
    delete process.env.AGENT_LLM_API_KEY;
    app=buildServer(); await app.ready();
    const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"local-admin",password:"local-demo-only"}});
    admin={authorization:`Bearer ${login.json().access_token}`};
    position=Number((app.db.prepare("INSERT INTO service_positions(position_name,status,data_json) VALUES ('测试打包岗','enabled',?) RETURNING id").get(JSON.stringify({wage_text:"22元/小时",hours_text:"长白班",age_text:"18-40",basic_requirements:"民族限制不得转交",place:"测试地址"})) as {id:number}).id);
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('Dify测试设备','enabled',?)").run(JSON.stringify({device_code:code,position_id:position,observe_only:true}));
    const bridge=new DeviceBridgeStore(app.db);
    device={authorization:`Bearer ${bridge.pair(code)}`};
    bridge.heartbeat(code,"online","test-account");
  });
  afterEach(async()=>{vi.unstubAllGlobals();await app.close();for(const key of ["REA_DATABASE_PATH","REA_MESSAGE_CHANNEL_PROVIDER","REA_DIFY_BASE_URL","REA_DIFY_API_KEY","AGENT_LLM_API_KEY"]) {if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
  const select=async()=>{
    const bridge=new DeviceBridgeStore(app.db);bridge.heartbeat(code,"offline");
    const result=await app.inject({method:"PUT",url:`/api/v1/agent/devices/${code}/reply-provider`,headers:admin,payload:{provider:"dify",fresh_client_state_confirmed:true}});
    bridge.heartbeat(code,"online","test-account");return result;
  };
  const chat=(session="S:test",text="工资多少？",headers=device)=>app.inject({method:"POST",url:"/api/v1/agent/chat",headers,payload:{device_code:code,session_key:session,text}});
  it("saves provider separately without exposing keys, rejects device writes",async()=>{
    expect([401,403]).toContain((await app.inject({method:"PUT",url:`/api/v1/agent/devices/${code}/reply-provider`,headers:device,payload:{provider:"dify"}})).statusCode);
    expect((await select()).json()).toMatchObject({provider:"dify",configured:true});
    const state=await app.inject({url:`/api/v1/agent/devices/${code}/reply-provider`,headers:admin});
    expect(state.json().provider).toBe("dify");expect(state.body).not.toContain("test-only-key");
    expect((await app.inject({url:`/api/v1/agent/opening?device_code=${code}`,headers:device})).json()).toMatchObject({items:[],provider:"dify"});
    expect((await app.inject({url:`/api/v1/agent/flow?device_code=${code}`,headers:device})).json()).toMatchObject({nodes:[],edges:[],provider:"dify"});
  });
  it("uses current position facts, returns client messages and reuses scoped Dify conversation",async()=>{
    await select();
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:"按资料22元/小时###长白班",conversation_id:"dify-conv-a",message_id:"dify-msg"}),{status:200}));vi.stubGlobal("fetch",fetchMock);
    expect((await chat()).json()).toMatchObject({ok:true,provider:"dify",reply:{messages:[{type:"text",content:"按资料22元/小时"},{type:"text",content:"长白班"}]}});
    const payload=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse(payload.inputs.position_data).wage_text).toBe("22元/小时");
    expect(payload.inputs.position_data).not.toMatch(/民族|18-40/);
    expect(payload).not.toHaveProperty("conversation_id");
    app.db.prepare("UPDATE service_positions SET data_json=? WHERE id=?").run(JSON.stringify({wage_text:"23元/小时"}),position);
    await chat("S:test","现在工资呢？");
    const next=JSON.parse(fetchMock.mock.calls[1][1].body);expect(next.conversation_id).toBe("dify-conv-a");expect(next.inputs.position_data).toContain("23元/小时");
    await chat("S:other");expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty("conversation_id");
  });
  it("keeps default Agent and blocks cross-device tokens",async()=>{
    const result=await chat();expect(result.json().provider).not.toBe("dify");
    await select();app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('Other','enabled',?)").run(JSON.stringify({device_code:"other"}));const bridge=new DeviceBridgeStore(app.db);const otherToken=bridge.pair("other");
    expect((await chat("S:test","你好",{authorization:`Bearer ${otherToken}`})).statusCode).toBe(403);
  });
  it("pauses when Dify configuration or response is invalid without falling back",async()=>{
    await select();delete process.env.REA_DIFY_API_KEY;expect((await chat()).json()).toMatchObject({ok:false,code:"dify_not_configured"});
    process.env.REA_DIFY_API_KEY="test-only-key";
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:"##INTERNAL:secret##",conversation_id:"id"}),{status:200})));
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_invalid_reply"});
  });
  it("does not run or return replies during human takeover",async()=>{
    await select();app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,external_conversation_id,takeover) VALUES (?,1,'S:test',1)").run(code);
    const network=vi.fn();vi.stubGlobal("fetch",network);expect((await chat()).json()).toMatchObject({ok:false,code:"human_takeover"});expect(network).not.toHaveBeenCalled();
  });
  it("rechecks human takeover after generation and only exposes neutral dry inputs",async()=>{
    await select();
    const dry=await app.inject({method:"POST",url:"/api/v1/agent/chat",headers:device,payload:{device_code:code,session_key:"S:test",text:"你好",dry:true}});
    expect(dry.json()).toMatchObject({provider:"dify",dry:true});expect(dry.body).not.toMatch(/民族|18-40|test-only-key/);
    vi.stubGlobal("fetch",vi.fn().mockImplementation(async()=>{
      app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,external_conversation_id,takeover) VALUES (?,1,'S:test',1)").run(code);
      return new Response(JSON.stringify({answer:"22元/小时",conversation_id:"race-conv"}),{status:200});
    }));
    expect((await chat()).json()).toMatchObject({ok:false,code:"human_takeover"});
    expect(app.db.prepare("SELECT COUNT(*) n FROM bridge_commands").get()).toMatchObject({n:0});
  });
  it("holds unsupported monetary amounts instead of sending another position's salary",async()=>{
    await select();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:"工资30元/小时",conversation_id:"wrong-wage"}),{status:200})));
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_fact_mismatch"});
  });
  it("pauses if the device changes position during generation",async()=>{
    await select();vi.stubGlobal("fetch",vi.fn().mockImplementation(async()=>{
      const row=app.db.prepare("SELECT id,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as {id:number;data_json:string};
      app.db.prepare("UPDATE agent_devices SET data_json=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.data_json),position_id:999}),row.id);
      return new Response(JSON.stringify({answer:"22元/小时",conversation_id:"old-position"}),{status:200});
    }));
    expect((await chat()).json()).toMatchObject({ok:false});
  });
  it("holds unsupported shorthand wages and allows matching source numbers",async()=>{
    await select();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:"30/小时，每天250/天",conversation_id:"wrong-shorthand"}),{status:200})));
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_fact_mismatch"});
  });
  it("rejects client-interpreted media markers and ignores generic source overrides",async()=>{
    await select();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:"【图片:宿舍.png】",conversation_id:"media"}),{status:200})));
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_invalid_reply"});
    const row=app.db.prepare("SELECT id FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as {id:number};
    await app.inject({method:"PUT",url:`/api/v1/agent/devices/${row.id}`,headers:admin,payload:{reply_provider:"agent"}});
    expect((await app.inject({url:`/api/v1/agent/devices/${code}/reply-provider`,headers:admin})).json().provider).toBe("dify");
  });
  it("refuses a live source switch until the client is stopped",async()=>{
    const result=await app.inject({method:"PUT",url:`/api/v1/agent/devices/${code}/reply-provider`,headers:admin,payload:{provider:"dify"}});
    expect(result.statusCode).toBe(409);
    expect((await select()).statusCode).toBe(200);
  });
  it("pauses if position facts change while Dify is generating",async()=>{
    await select();vi.stubGlobal("fetch",vi.fn().mockImplementation(async()=>{
      app.db.prepare("UPDATE service_positions SET data_json=? WHERE id=?").run(JSON.stringify({wage_text:"25元/小时"}),position);
      return new Response(JSON.stringify({answer:"22元/小时",conversation_id:"stale-facts"}),{status:200});
    }));
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_position_changed"});
  });
  it("blocks insecure lookalike Dify hosts before transmitting credentials",async()=>{
    await select();process.env.REA_DIFY_BASE_URL="http://localhost.attacker.example/v1";const network=vi.fn();vi.stubGlobal("fetch",network);
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_not_configured"});expect(network).not.toHaveBeenCalled();
  });
  it("rejects wages with an incorrect billing unit",async()=>{
    await select();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:"22元/月",conversation_id:"wrong-unit"}),{status:200})));
    expect((await chat()).json()).toMatchObject({ok:false,code:"dify_fact_mismatch"});
  });
  it("requires confirmation of a fresh client state directory",async()=>{
    new DeviceBridgeStore(app.db).heartbeat(code,"offline");
    const result=await app.inject({method:"PUT",url:`/api/v1/agent/devices/${code}/reply-provider`,headers:admin,payload:{provider:"dify"}});
    expect(result.statusCode).toBe(409);
  });
});

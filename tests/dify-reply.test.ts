import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";
import { DeviceBridgeStore } from "../src/modules/messaging/device-bridge.js";
import { difyContext, difyContextConflict, difyInput } from '../src/modules/dify/dify-context.js';
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
  it("sends configured media and map search through the existing text and media contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dify-media-"));
    const old = process.env.REA_MEDIA_DIR;
    process.env.REA_MEDIA_DIR = dir;
    try {
      const vertical=app.db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as {id:number};
      const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('验收市','测试省',?) RETURNING id")
        .get(JSON.stringify({knowledge_vertical_id:vertical.id})) as { id:number };
      app.db.prepare("INSERT INTO cities(city_name,province) VALUES ('另一市','测试省')").run();
      app.db.prepare("UPDATE service_positions SET city_id=?,data_json=json_set(data_json,'$.interview_points',json(?)) WHERE id=?")
        .run(city.id,JSON.stringify([{name:"东门接待处",address:"青竹路18号"}]),position);
      const insert=app.db.prepare("INSERT INTO media_assets (name,kind,storage_path,sha256,bytes,status,position_id) VALUES (?,?,?,?,?,?,?)");
      for(const [name,kind,scope,status] of [
        ["面试地点.png","image",position,"enabled"],["另一市面试点.jpg","image",0,"enabled"],
        ["工作内容(1).jpg","image",0,"enabled"],["安检.mp4","video",0,"enabled"],
        ["工作环境图片.jpg","image",position,"disabled"],["宿舍图.jpg","image",position,"enabled"],
      ] as const) {
        const bytes=Buffer.from(name);
        if(name!=="宿舍图.jpg") writeFileSync(join(dir,name),bytes);
        insert.run(name,kind,name,createHash("sha256").update(bytes).digest("hex"),bytes.length,status,scope);
      }
      await select();
      const network=vi.fn();
      vi.stubGlobal("fetch",network);
      const media=(await chat("S:media","发一下工作图片和视频")).json().reply.messages;
      expect(media.slice(1)).toEqual([
        {type:"image",name:expect.stringMatching(/^dify-asset-\d+-[a-f0-9]{64}\.jpg$/),content:"图片 · 工作内容(1).jpg"},
        {type:"video",name:expect.stringMatching(/^dify-asset-\d+-[a-f0-9]{64}\.mp4$/),content:"视频 · 安检.mp4"},
      ]);
      const assetDownload = await app.inject({url:`/api/v1/agent/media/${media[1].name}`,headers:device});
      expect(assetDownload.statusCode).toBe(200);
      expect(assetDownload.body).toBe("工作内容(1).jpg");
      app.db.prepare("UPDATE media_assets SET sha256=? WHERE name=?").run("a".repeat(64),"工作内容(1).jpg");
      expect((await app.inject({url:`/api/v1/agent/media/${media[1].name}`,headers:device})).statusCode).toBe(404);
      const map=(await chat("S:media","发面试地址和定位")).json().reply.messages;
      expect(map[0].content).toContain("青竹路18号");
      const link=new URL(map[0].content.match(/https:\/\/\S+/)[0]);
      expect(link.hostname).toBe("uri.amap.com");
      expect(link.searchParams.get("keyword")).toBe("青竹路18号");
      expect(link.searchParams.get("city")).toBe("验收市");
      expect(map.slice(1)).toEqual([{type:"image",name:expect.stringMatching(/\.png$/),content:"图片 · 面试地点.png"}]);
      const other=(await chat("S:media","发另一市的面试定位")).json().reply.messages;
      expect(other[0].content).toContain("推荐岗位");
      expect(other).toHaveLength(1);
      const missing=(await chat("S:media","有没有宿舍照片？")).json().reply.messages;
      expect(missing[0].content).toContain("暂无");
      expect(missing).toHaveLength(1);
      const dormMap=(await chat("S:media","发个宿舍地图图片")).json().reply.messages;
      expect(dormMap[0].content).toContain("宿舍");
      expect(dormMap[0].content).not.toContain("青竹路");
      app.db.prepare("UPDATE service_positions SET data_json=json_set(data_json,'$.interview_points',json(?)) WHERE id=?")
        .run(JSON.stringify([{name:"东门接待处",address:"青竹路18号"},{name:"西门面试点",address:"青竹路20号"}]),position);
      const ambiguous=(await chat("S:media","发面试定位")).json().reply.messages;
      expect(ambiguous).toEqual([{type:"text",content:expect.stringContaining("有多个面试点")}]);
      const explicit=(await chat("S:media","发西门面试点的定位")).json().reply.messages;
      expect(explicit).toEqual([{type:"text",content:expect.stringContaining("青竹路20号")}]);
      expect(explicit[0].content).not.toContain("青竹路18号");
      expect(network).not.toHaveBeenCalled();
    } finally {
      if(old===undefined)delete process.env.REA_MEDIA_DIR;
      else process.env.REA_MEDIA_DIR=old;
      rmSync(dir,{recursive:true,force:true});
    }
  });
  it("recommends a scoped job, keeps that choice, and records an explicitly confirmed interview once", async () => {
    const city = app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('验收市','验收省',?) RETURNING id")
      .get(JSON.stringify({ districts: ["青竹区"] })) as { id: number };
    const factory = app.db.prepare("INSERT INTO factories(city_id,factory_name,status) VALUES (?,'验收厂','enabled') RETURNING id")
      .get(city.id) as { id: number };
    app.db.prepare("UPDATE service_positions SET city_id=?,factory_id=? WHERE id=?").run(city.id,factory.id,position);
    const second = app.db.prepare("INSERT INTO service_positions(city_id,factory_id,position_name,status,data_json) VALUES (?,?,'青竹区分拣岗','enabled',?) RETURNING id")
      .get(city.id,factory.id,JSON.stringify({ wage_text:"26元/小时",district:"青竹区",interview_days:["周一","周二","周三","周四","周五","周六","周日"],interview_time:"每天 14:00-16:00",interview_points:[{name:"东门接待处",address:"青竹路18号"}] })) as { id: number };
    const outOfScope = app.db.prepare("INSERT INTO service_positions(position_name,status) VALUES ('外部私有岗','enabled') RETURNING id").get() as { id: number };
    app.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.factory_ids',json(?)) WHERE json_extract(data_json,'$.device_code')=?")
      .run(JSON.stringify([factory.id]),code);
    await select();
    const session = "S:test-account_registration";
    new DeviceBridgeStore(app.db).contact(code,session,"虚构验收联系人");
    const model = vi.fn().mockImplementation(async () => new Response(JSON.stringify({answer:"工资26元/小时",conversation_id:"recruit-chat"})));
    vi.stubGlobal("fetch",model);
    const options = (await chat(session,"我在青竹区，附近有什么岗位？")).json();
    expect(options.reply.messages[0].content).toContain("青竹区分拣岗");
    expect(JSON.stringify(options)).not.toContain("外部私有岗");
    expect((await chat(session,`选择岗位 ${outOfScope.id}`)).json().reply.messages[0].content).toContain("可选范围");
    await chat(session,`选择岗位 ${second.id}`);
    expect((await chat(session,"换岗之后的工资多少？")).json()).toMatchObject({ok:true,reply:{messages:[{type:"text",content:"工资26元/小时"}]}});
    const sent = JSON.parse(model.mock.calls.at(-1)![1].body);
    expect(JSON.parse(sent.inputs.position_data)).toMatchObject({ wage_text:"26元/小时", interview_points:[{name:"东门接待处",address:"青竹路18号"}] });
    const date = new Date(Date.now()+3*86400000).toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"});
    const draft = `报名 姓名：小陈 电话：13800000000 日期：${date} 时间：15:00 面试点：东门接待处`;
    await chat(session,draft);
    expect(app.db.prepare("SELECT count(*) n FROM agent_archive").get()).toMatchObject({n:0});
    app.db.prepare("UPDATE service_positions SET data_json=json_set(data_json,'$.interview_points[0].address','青竹路20号') WHERE id=?").run(second.id);
    expect((await chat(session,"确认报名")).json().reply.messages[0].content).toContain("请核对报名资料");
    expect(app.db.prepare("SELECT count(*) n FROM agent_archive").get()).toMatchObject({n:0});
    for (const _ of [1,2]) expect((await chat(session,"确认报名")).json().reply.messages[0].content).toContain("已登记");
    const candidates = (await app.inject({url:"/api/v1/agent/candidates?status=invited",headers:admin})).json();
    expect(candidates.items.filter((item:{device_code:string})=>item.device_code===code)).toEqual([
      expect.objectContaining({name:"小陈",device_code:code,position_id:second.id,interview_date:date,interview_time:"15:00",interview_point:"东门接待处",interview_confirmed:true,has_conversation:true}),
    ]);
    expect(app.db.prepare("SELECT count(*) n FROM bridge_commands").get()).toMatchObject({n:0});
    const previews = ["报名",draft,"确认报名"];
    for (const text of previews) await app.inject({method:"POST",url:"/api/v1/dify/preview",headers:admin,
      payload:{position_id:second.id,session_key:"dify-preview:registration",text}});
    expect(app.db.prepare("SELECT count(*) n FROM agent_archive").get()).toMatchObject({n:1});
  });
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
  it("reads live city materials and existing scoped knowledge for Dify only",async()=>{
    const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('测试城市','测试省',?) RETURNING id").get(JSON.stringify({salary:{raw:'综合月薪5000-8000元'},work_hours:{raw:'每天8小时'},interview:{time:'周一下午14:00',location:'城市面试点',interview_notice:'携带身份证原件'},prompt_sections:{meal_dorm:'包住不包吃',custom_intro:'入职前可先参观'}})) as {id:number};
    app.db.prepare('UPDATE service_positions SET city_id=? WHERE id=?').run(city.id,position);
    const insert=app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,scope_position_id,question,answer,status) VALUES (1,?,?,?,?,?)");
    insert.run('global',null,'怎么联系人工','请留言，招聘员接手后答复','enabled');
    insert.run('position',position,'发薪日','每月15号发薪','enabled');
    const other=app.db.prepare("INSERT INTO service_positions(position_name,status) VALUES ('其他岗位','enabled') RETURNING id").get() as {id:number};
    insert.run('position',other.id,'别家资料','这是其他岗位资料','enabled');
    insert.run('position',position,'停用问题','停用答案','disabled');
    await select();const network=vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:'综合月薪5000-8000元',conversation_id:'city-context'}),{status:200}));vi.stubGlobal('fetch',network);
    expect((await chat()).json()).toMatchObject({ok:true});
    const data=JSON.parse(JSON.parse(network.mock.calls[0][1].body).inputs.position_data);
    expect(data).toMatchObject({city:'测试城市',wage_text:'综合月薪5000-8000元',hours_text:'每天8小时',interview_address:'城市面试点',welfare_text:'包住不包吃'});
    expect(data.city_materials.custom_intro).toBe('入职前可先参观');
    expect(JSON.stringify(data.knowledge)).toContain('每月15号发薪');expect(JSON.stringify(data.knowledge)).toContain('招聘员接手');
    expect(JSON.stringify(data)).not.toMatch(/其他岗位资料|停用答案/);
    app.db.prepare('UPDATE cities SET data_json=? WHERE id=?').run(JSON.stringify({salary:{raw:'综合月薪6000-9000元'}}),city.id);
    network.mockResolvedValue(new Response(JSON.stringify({answer:'综合月薪6000-9000元',conversation_id:'city-context'}),{status:200}));
    await chat('S:test','现在工资呢？');
    expect(JSON.parse(JSON.parse(network.mock.calls[1][1].body).inputs.position_data).wage_text).toBe('综合月薪6000-9000元');
  });
  it("shares saved job sections with Dify and retains city precedence", async () => {
    const fields = {
      positions: '岗位工种说明', requirements: '岗位要求说明', factory_env: '岗位工厂环境',
      dorm_env: '岗位宿舍环境', work_env: '岗位工作环境', uniform: '岗位工衣说明',
      medical_fee: '岗位体检费用说明', interview_notice: '岗位面试通知',
      checkin_guide: '岗位面试指引', registration_form: '岗位报名说明',
    };
    const city = app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('表单核对城','测试省',?) RETURNING id")
      .get(JSON.stringify({prompt_sections:{uniform:'城市工衣说明',factory_env:'   '},interview:{interview_notice:'城市面试通知'}})) as {id:number};
    const saved = await app.inject({method:"PUT",url:`/api/v1/service-positions/${position}`, headers:admin,
      payload:{city_id:city.id,base_sections:fields}});
    expect(saved.statusCode).toBe(200);
    const preview = await app.inject({method:"POST",url:"/api/v1/dify/preview",headers:admin,
      payload:{position_id:position,text:"请介绍岗位、工衣和面试",dry:true}});
    const expected = {...fields,uniform:'城市工衣说明',interview_notice:'城市面试通知'};
    const input = JSON.parse(preview.json().inputs.position_data);
    expect(input.city_materials).toMatchObject(expected);
    expect(input).toMatchObject({interview_notice:'城市面试通知',interview_guide:'岗位面试指引'});
    expect(input.sources.sections).toEqual(Object.fromEntries(Object.keys(fields).map(key =>
      [key,key==='uniform'||key==='interview_notice'?'city':'position_fallback'])));
    await select();
    const fetchDify = vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:'岗位工衣由现场发放',conversation_id:'shared-materials'}),{status:200}));
    vi.stubGlobal('fetch',fetchDify);
    expect((await chat('S:materials','工衣和工作环境是什么样？')).json()).toMatchObject({ok:true});
    const outgoing = JSON.parse(JSON.parse(fetchDify.mock.calls[0][1].body).inputs.position_data);
    expect(outgoing.city_materials).toMatchObject(expected);
    expect(JSON.stringify(outgoing)).not.toMatch(/岗位工衣说明|民族限制不得转交/);
  });
  it("exposes administrator city and knowledge preview without switching device or sending",async()=>{
    const dry=await app.inject({method:'POST',url:'/api/v1/dify/preview',headers:admin,payload:{position_id:position,text:'工资？',dry:true}});
    expect(dry.statusCode).toBe(200);expect(dry.json()).toMatchObject({ok:true,provider:'dify',dry:true});
    expect(app.db.prepare('SELECT COUNT(*) n FROM bridge_commands').get()).toMatchObject({n:0});
    const anonymous=await app.inject({method:'POST',url:'/api/v1/dify/preview',payload:{position_id:position,text:'工资？',dry:true}});expect(anonymous.statusCode).toBe(403);
  });
  it("pauses when city or knowledge changes during generation",async()=>{
    await select();vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{
      app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,question,answer,status) VALUES (1,'global','咨询人工','请稍候','enabled')").run();
      return new Response(JSON.stringify({answer:'22元/小时',conversation_id:'changed-knowledge'}),{status:200});
    }));
    expect((await chat()).json()).toMatchObject({ok:false,code:'dify_position_changed'});
  });
  it("connects original dashboard to today's Dify calls instead of ordinary send failures",async()=>{
    app.db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status) VALUES (?,1,'outbound','old','failed')").run(code);
    const call=app.db.prepare("INSERT INTO dify_reply_calls(id,device_code,position_id,status,error_code,latency_ms,created_at) VALUES (?,?,?,?,?,?,?)");
    const now=new Date().toISOString();call.run('today',code,position,'failed','dify_http_error',5,now);call.run('ok',code,position,'generated','',5,now);call.run('old',code,position,'failed','dify_http_error',5,'2020-01-01 00:00:00');
    const result=await app.inject({url:'/api/v1/agent/status/dashboard',headers:admin});
    expect(result.json()).toMatchObject({errors:{failed_today:1},dify_health:[{device_code:code,fail_count:1}],degraded:[{device_code:code,fail_rate:50}]});
  });
  it("restores complete city material editing without losing existing nested or unknown data",async()=>{
    const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('编辑测试城','测试省',?) RETURNING id").get(JSON.stringify({salary:{raw:'旧工资',formal:{monthly:6000}},interview:{room:'A室'},untouched:'keep',prompt_sections:{legacy:'旧字段'},prompt_section_labels:{legacy:'历史原文'}})) as {id:number};
    const r=await app.inject({method:'PUT',url:`/api/v1/dify/cities/${city.id}/materials`,headers:admin,payload:{salary:{raw:'5000-8000元/月'},interview:{location:'新面试点'},prompt_sections:{legacy:'已编辑',meal_dorm:'包住'},prompt_section_labels:{legacy:'历史原文',meal_dorm:'吃住情况'}}});
    expect(r.statusCode).toBe(200);
    const raw=JSON.parse((app.db.prepare('SELECT data_json FROM cities WHERE id=?').get(city.id) as {data_json:string}).data_json);
    expect(raw).toMatchObject({untouched:'keep',salary:{raw:'5000-8000元/月',formal:{monthly:6000}},interview:{room:'A室',location:'新面试点'},prompt_sections:{legacy:'已编辑',meal_dorm:'包住'}});
    expect(app.db.prepare('SELECT COUNT(*) n FROM city_history WHERE city_id=?').get(city.id)).toMatchObject({n:1});
  });
  it('retrieves complete relevant knowledge within the real Dify input limit',()=>{
    const insert=app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,question,answer,status) VALUES (1,'global',?,?,'enabled')");
    for(let i=0;i<50;i++)insert.run('其他问答'+i,'一般说明'.repeat(300));
    insert.run('行李到达后放在哪里','行李暂存于蓝色接待区');
    const full=difyContext(app.db,position)!;expect(JSON.stringify(full).length).toBeGreaterThan(20000);
    const selected=difyInput(full,'行李到达后放在哪里')!;
    expect(JSON.stringify(selected).length).toBeLessThan(20000);
    expect(selected.knowledge.some(k=>k.answer==='行李暂存于蓝色接待区')).toBe(true);
    expect(selected.retrieval.omitted).toBeGreaterThan(0);
  });
  it('uses an explicitly selected city knowledge category without changing mode one',async()=>{
    const vertical=app.db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as {id:number};
    const other=app.db.prepare("SELECT id FROM vertical WHERE code='factory'").get() as {id:number};
    const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('品类验收城','测试省',?) RETURNING id").get(JSON.stringify({knowledge_vertical_id:vertical.id,salary:{raw:'5000-8000元'},work_hours:{raw:'每天8小时'}})) as {id:number};
    app.db.prepare('UPDATE service_positions SET city_id=? WHERE id=?').run(city.id,position);
    const add=app.db.prepare("INSERT INTO kb_faq(tenant_id,vertical_id,scope_level,question,answer,status) VALUES (1,?,'global',?,?,'enabled')");
    add.run(vertical.id,'专用品类薪资','{wage}');add.run(other.id,'别的品类描述','别的工厂模板');
    const context=difyContext(app.db,position)!;
    expect(context.knowledge.some(k=>k.question==='专用品类薪资'&&k.answer==='5000-8000元')).toBe(true);
    expect((await app.inject({url:`/api/v1/cities/${city.id}`,headers:admin})).json().knowledge_vertical_id).toBe(vertical.id);
    const view=(await app.inject({url:`/api/v1/cities/${city.id}`,headers:admin})).json();
    expect((await app.inject({method:'PUT',url:`/api/v1/cities/${city.id}`,headers:admin,payload:view})).statusCode).toBe(200);
    expect(difyContext(app.db,position)!.sources.knowledge_vertical_id).toBe(vertical.id);
    expect(JSON.stringify(context.knowledge)).not.toContain('别的工厂模板');
    const {positionKnowledge}=await import('../src/modules/agent/position-knowledge.js');
    expect(positionKnowledge(app.db,position,{wage_text:'22元/小时'}).some(k=>k.question==='专用品类薪资')).toBe(false);
    const r=await app.inject({method:'PUT',url:`/api/v1/dify/cities/${city.id}/materials`,headers:admin,payload:{knowledge_vertical_id:null}});
    expect(r.statusCode).toBe(200);expect(difyContext(app.db,position)!.knowledge.some(k=>k.question==='专用品类薪资')).toBe(false);
  });
  it('rejects unknown knowledge categories instead of silently accepting them',async()=>{
    const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('配置校验城','测试省','{}') RETURNING id").get() as {id:number};
    const r=await app.inject({method:'PUT',url:`/api/v1/dify/cities/${city.id}/materials`,headers:admin,payload:{knowledge_vertical_id:999999}});
    expect(r.statusCode).toBe(422);
  });
  it('holds an interview guide that contradicts the saved address floor',async()=>{
    const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('冲突测试城','测试省',?) RETURNING id").get(JSON.stringify({interview:{location:'青竹路18号三楼招聘接待处',interview_guide:'西门进入到二楼蓝色接待台'}})) as {id:number};
    app.db.prepare('UPDATE service_positions SET city_id=? WHERE id=?').run(city.id,position);
    await select();const network=vi.fn();vi.stubGlobal('fetch',network);
    expect((await chat('S:floor','到了怎么进去？')).json()).toMatchObject({ok:false,code:'dify_context_conflict'});
    expect(network).not.toHaveBeenCalled();
  });
  it('keeps work location distinct from the city interview location',()=>{
    const city=app.db.prepare("INSERT INTO cities(city_name,province,data_json) VALUES ('地点测试城','测试省',?) RETURNING id").get(JSON.stringify({interview:{location:'总部面试中心'}})) as {id:number};
    app.db.prepare('UPDATE service_positions SET city_id=?,data_json=? WHERE id=?').run(city.id,JSON.stringify({place:'全市地铁站安排',interview_address:'岗位面试地址'}),position);
    expect(difyContext(app.db,position)).toMatchObject({place:'全市地铁站安排',interview_address:'总部面试中心'});
  });
  it('checks both endpoints when the model formats a salary range with a long dash',async()=>{
    await select();app.db.prepare('UPDATE service_positions SET data_json=? WHERE id=?').run(JSON.stringify({wage_text:'5000–8000元'}),position);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({answer:'4000–8000元',conversation_id:'dash-mismatch'}),{status:200})));
    expect((await chat()).json()).toMatchObject({ok:false,code:'dify_fact_mismatch'});
  });
  it('normalizes Chinese floors and compares destinations rather than shared entrances',()=>{
    const context=difyContext(app.db,position)!;
    expect(difyContextConflict({...context,interview_address:'接待处11楼',interview_guide:'乘电梯到十一楼接待处'} as typeof context)).toBe('');
    expect(difyContextConflict({...context,interview_address:'一楼进门上三楼面试',interview_guide:'一楼入口上二楼面试'} as typeof context)).not.toBe('');
  });
});

import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {buildServer} from '../src/server.js';
describe('完整招聘名单',()=>{
 process.env.REA_DATABASE_PATH=':memory:';
 const app=buildServer();let h:Record<string,string>;
 beforeAll(async()=>{await app.ready();h={authorization:`Bearer ${(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'local-admin',password:'local-demo-only'}})).json().access_token}`};});
 afterAll(()=>app.close());
 it('includes unregistered conversations and historical candidate events without calling them registered',async()=>{
  app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES ('complete-test',99001,'仅沟通客户','complete-chat')").run();
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,status,name,phone,interview_date) VALUES ('complete-test','99002','历史报名','invited','invited','历史姓名','13900000000','2026-11-25')").run();
  const res=await app.inject({url:'/api/v1/agent/candidates?status=all',headers:h});
  expect(res.statusCode).toBe(200);
  expect(res.json().items).toEqual(expect.arrayContaining([
    expect.objectContaining({nickname:'仅沟通客户',status:'communicating',has_conversation:true}),
    expect.objectContaining({nickname:'历史报名',status:'invited',name:'历史姓名',has_conversation:false}),
  ]));
 });
 it('merges one real conversation with its event and archive rather than tripling it',async()=>{
  app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id,recruit_status) VALUES ('complete-test',99003,'统一客户','complete-merged','invited')").run();
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,status,name) VALUES ('complete-test','99003','统一客户','invited','invited','历史名')").run();
  app.db.prepare("INSERT INTO agent_archive(session_key,position_id,name,phone,interview_date) VALUES ('complete-merged',1,'最新名','13800000001','2026-11-26')").run();
  const rows=(await app.inject({url:'/api/v1/agent/candidates?status=all',headers:h})).json().items.filter((r:any)=>r.nickname==='统一客户');
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({name:'最新名',status:'invited'});
 });
 it('opens the exact unregistered conversation without requiring an archive',async()=>{
  const row=(await app.inject({url:'/api/v1/agent/candidates?status=all',headers:h})).json().items.find((r:any)=>r.nickname==='仅沟通客户');
  app.db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status) VALUES ('complete-test',99001,'inbound','未登记也有聊天','received')").run();
  expect(row).toBeDefined();
  const messages=await app.inject({url:`/api/v1/agent/candidates/${encodeURIComponent(row.id)}/messages`,headers:h});
  expect(messages.statusCode).toBe(200);expect(messages.json().items).toEqual(expect.arrayContaining([expect.objectContaining({content:'未登记也有聊天'})]));
 });
 it('uses the latest historical disposition without dropping a disqualified customer',async()=>{
  app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES ('complete-test',99004,'历史状态客户','history-state')").run();
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,event_type,status,event_at) VALUES ('complete-test','99004','invited','invited','2026-11-01')").run();
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,event_type,status,event_at) VALUES ('complete-test','99004','disqualified','disqualified','2026-11-02')").run();
  const rows=(await app.inject({url:'/api/v1/agent/candidates?status=all',headers:h})).json().items.filter((r:any)=>r.nickname==='历史状态客户');
  expect(rows).toHaveLength(1);expect(rows[0].status).toBe('disqualified');
 });
 it('applies a newer disqualification after an invitation and keeps a later explicit reset',async()=>{
  app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id,recruit_status,updated_at) VALUES ('complete-test',99005,'状态转换客户','status-transition','invited','2026-11-01 00:00:00')").run();
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,event_type,status,event_at,updated_at) VALUES ('complete-test','99005','disqualified','disqualified','2026-11-02 00:00:00','2026-11-02 00:00:00')").run();
  const get=async()=> (await app.inject({url:'/api/v1/agent/candidates?status=all',headers:h})).json().items.find((r:any)=>r.nickname==='状态转换客户');
  expect((await get()).status).toBe('disqualified');
  app.db.prepare("UPDATE agent_conversations SET recruit_status='none',state='active',updated_at='2026-11-03 00:00:00' WHERE device_code='complete-test' AND customer_id=99005").run();
  expect((await get()).status).toBe('communicating');
 });
 it('keeps known details from older events while the latest event determines status',async()=>{
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,status,name,phone,event_at,updated_at) VALUES ('complete-test','99006','旧资料客户','invited','invited','已知姓名','13900000006','2026-11-01','2026-11-01')").run();
  app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,status,event_at,updated_at) VALUES ('complete-test','99006','旧资料客户','disqualified','disqualified','2026-11-02','2026-11-02')").run();
  const row=(await app.inject({url:'/api/v1/agent/candidates?status=all',headers:h})).json().items.find((r:any)=>r.nickname==='旧资料客户');
  expect(row).toMatchObject({status:'disqualified',name:'已知姓名',phone:'13900000006'});
 });
});

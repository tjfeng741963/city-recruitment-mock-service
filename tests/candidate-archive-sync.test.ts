import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {buildServer} from '../src/server.js';
describe('面试档案同步候选名单',()=>{
 const app=(()=>{process.env.REA_DATABASE_PATH=':memory:';return buildServer()})();
 let headers:Record<string,string>;
 beforeAll(async()=>{await app.ready();const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'local-admin',password:'local-demo-only'}});headers={authorization:`Bearer ${r.json().access_token}`};});
 afterAll(()=>app.close());
 it('shows the same archive with exact conversation identity, latest fields and region',async()=>{
   app.db.prepare("UPDATE agent_conversations SET external_conversation_id='sync-session',name='张三',province='广东省',city='惠州市',district='博罗县',factory_name='惠州项目' WHERE device_code='local-device-001' AND customer_id=700001").run();
   app.db.prepare("INSERT INTO agent_archive(session_key,position_id,name,phone,interview_date,interview_time,updated_at) VALUES ('sync-session',1,'','13360426752','2026-11-22','10:00','2026-11-21 10:00:00')").run();
   const get=()=>app.inject({url:'/api/v1/agent/candidates',headers});
   const first=(await get()).json().items.find((r:any)=>r.id==='sync-session');
   expect(first).toMatchObject({name:'张三',phone:'13360426752',device_code:'local-device-001',customer_id:'700001',factory_name:'惠州项目',province:'广东省',city:'惠州市',district:'博罗县',has_conversation:true,remind_status:'not_reminded'});
   app.db.prepare("UPDATE agent_archive SET name='李四',phone='13300000000',interview_date='2026-11-23' WHERE session_key='sync-session'").run();
   expect((await get()).json().items.find((r:any)=>r.id==='sync-session')).toMatchObject({name:'李四',phone:'13300000000',interview_date:'2026-11-23'});
   const archive=(await app.inject({url:'/api/v1/agent/archive/list',headers})).json().items.find((r:any)=>r.session_key==='sync-session');
   expect(archive).toMatchObject({name:'李四',phone:'13300000000'});
 });
 it('persists manual registration and keeps it in both lists without inventing a chat',async()=>{
   const res=await app.inject({method:'POST',url:'/api/v1/agent/archive/manual',headers,payload:{name:'手动客人',phone:'13900000000',interview_date:'2026-11-24',city:'深圳',device_code:'local-device-001'}});
   expect(res.statusCode).toBe(200);
   const archive=(await app.inject({url:'/api/v1/agent/archive/list',headers})).json().items.find((r:any)=>r.session_key===res.json().session_key);
   expect(archive).toMatchObject({name:'手动客人',phone:'13900000000',city:'深圳',device_code:'local-device-001'});
   const row=(await app.inject({url:'/api/v1/agent/candidates',headers})).json().items.find((r:any)=>r.id===res.json().session_key);
   expect(row).toMatchObject({name:'手动客人',has_conversation:false});
 });
 it('reads only the linked chat without changing unread counts or sending anything',async()=>{
   app.db.prepare("UPDATE agent_conversations SET unread=4 WHERE device_code='local-device-001' AND customer_id=700001").run();
   const result=await app.inject({url:'/api/v1/agent/candidates/sync-session/messages',headers});
   expect(result.statusCode).toBe(200);
   expect(result.json().items).toEqual(expect.arrayContaining([expect.objectContaining({content:'想了解一下长白班岗位',direction:'inbound'})]));
   expect(app.db.prepare("SELECT unread FROM agent_conversations WHERE device_code='local-device-001' AND customer_id=700001").get()).toMatchObject({unread:4});
   const denied=await app.inject({url:'/api/v1/agent/candidates/nonexistent/messages',headers});
   expect(denied.statusCode).toBe(404);
 });
 it('moves the same record to checked-in when arrival is confirmed in interview registration',async()=>{
   const result=await app.inject({method:'PUT',url:'/api/v1/agent/archive/sync-session/arrival',headers,payload:{arrival_status:'arrived'}});
   expect(result.statusCode).toBe(200);
   const checked=(await app.inject({url:'/api/v1/agent/candidates?status=checked_in',headers})).json();
   expect(checked.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'sync-session',status:'checked_in'})]));
 });
 it('does not choose another device chat when a legacy session has ambiguous matches',async()=>{
   app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES ('another-device',700002,'不同设备客户','sync-session')").run();
   const row=(await app.inject({url:'/api/v1/agent/candidates?status=checked_in',headers})).json().items.find((r:any)=>r.id==='sync-session');
   expect(row).toMatchObject({has_conversation:false,association_status:'ambiguous',device_code:''});
   expect((await app.inject({url:'/api/v1/agent/candidates/sync-session/messages',headers})).statusCode).toBe(409);
   const archives=(await app.inject({url:'/api/v1/agent/archive/list',headers})).json().items;
   expect(archives.filter((r:any)=>r.session_key==='sync-session')).toHaveLength(1);
 });
 it('reports reminder delivery receipts for the current interview date instead of counting queued reminders as sent',async()=>{
   app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES ('local-device-001',700003,'提醒客户','reminder-session')").run();
   app.db.prepare("INSERT INTO agent_archive(session_key,position_id,name,phone,interview_date,updated_at) VALUES ('reminder-session',1,'提醒客户','13900000001','2026-11-26','2026-11-21 10:00:00')").run();
   app.db.prepare("INSERT INTO bridge_commands(id,device_code,customer_id,contact_id,content,idempotency_key,status,created_at) VALUES ('remind-test','local-device-001',700003,'contact','提醒','followup:local-device-001:700003:2026-11-26:1','queued',1)").run();
   const get=async()=> (await app.inject({url:'/api/v1/agent/candidates',headers})).json().items.find((r:any)=>r.id==='reminder-session');
   expect(await get()).toMatchObject({remind_status:'queued'});
   app.db.prepare("UPDATE bridge_commands SET status='failed' WHERE id='remind-test'").run();
   expect(await get()).toMatchObject({remind_status:'failed'});
   app.db.prepare("UPDATE agent_archive SET interview_date='2026-11-27' WHERE session_key='reminder-session'").run();
   expect(await get()).toMatchObject({remind_status:'not_reminded'});
 });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";
import { DeviceBridgeStore } from "../src/modules/messaging/device-bridge.js";
import { parseRecontactParts, queueRecontactBatch, recontactTarget, authorizeRecontactCommand,
  finishRecontactAnchor, markRecontactAnchor, recontactFlowStage, setRecontactDevice } from "../src/modules/recontact/recontact.js";

describe("recontact device delivery", () => {
  let db: DatabaseSync;
  let bridge: DeviceBridgeStore;
  let conversationId: number;
  let customerId: number;
  let now: number;
  const code = "recontact-device";
  const cid = "S:account_candidate";

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateDatabase(db);
    now = Date.parse("2026-11-27T12:00:00+08:00");
    bridge = new DeviceBridgeStore(db, () => now);
    db.prepare("INSERT INTO service_positions(id,position_name,status,data_json) VALUES (9,'测试安检','enabled','{}')").run();
    db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)").run(code, JSON.stringify({ device_code: code, agent_position_id: 9 }));
    bridge.pair(code);
    bridge.heartbeat(code, "online", "account");
    customerId = bridge.contact(code, cid, "测试联系人");
    expect(bridge.claim(code,"",true)).toBeNull();
    expect(setRecontactDevice(db,code,true,now)).toBe(true);
    db.prepare("UPDATE recontact_devices SET enabled_at=? WHERE device_code=?").run(now-86400_000,code);
    conversationId = (db.prepare("SELECT id FROM agent_conversations WHERE device_code=? AND customer_id=?").get(code, customerId) as {id:number}).id;
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status,created_at) VALUES (?,?,'inbound','在哪里上班','received',?)").run(code, customerId, new Date(now-86400_000*4).toISOString());
  });

  afterEach(() => db.close());

  function queue() {
    const target = recontactTarget(db, conversationId, 0, now)!;
    const parts = parseRecontactParts(db, 9, [
      { kind:"text", value:"测试一", delay_ms:0 },
      { kind:"text", value:"测试二", delay_ms:10000 },
    ]);
    return queueRecontactBatch(db,target,parts,"test-batch",target.baseline_inbound_id,now);
  }

  it("only claims on compatible clients and waits from the previous positive receipt", () => {
    expect(queue()).toBeGreaterThan(0);
    expect(bridge.claim(code)).toBeNull();
    const first = bridge.claim(code,"",true)!;
    expect(first).toMatchObject({ kind:"recontact", recontact_kind:"text", content:"测试一", recontact_account_id:"account" });
    expect(authorizeRecontactCommand(db,code,first.id,first.lease_token,now)).toEqual({ok:true});
    expect(bridge.claim(code,"",true)).toBeNull();
    bridge.receipt(code,first.id,first.lease_token,"succeeded",`${cid}:1`);
    now += 9999;
    expect(bridge.claim(code,"",true)).toBeNull();
    now += 1;
    expect(bridge.claim(code,"",true)?.content).toBe("测试二");
  });

  it("rejects new inbound after the claim and never offers the second step", () => {
    queue();
    const first = bridge.claim(code,"",true)!;
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status,created_at) VALUES (?,?,'inbound','我来了','received',?)").run(code, customerId, new Date(now).toISOString());
    expect(authorizeRecontactCommand(db,code,first.id,first.lease_token,now)).toMatchObject({ok:false});
    expect(bridge.claim(code,"",true)).toBeNull();
  });

  it("does not revive a leased message when the same account is paused and enabled again", () => {
    const id=queue();
    const first=bridge.claim(code,"",true)!;
    expect(authorizeRecontactCommand(db,code,first.id,first.lease_token,now)).toEqual({ok:true});
    expect(setRecontactDevice(db,code,false,now)).toBe(true);
    expect(setRecontactDevice(db,code,true,now)).toBe(true);
    expect(authorizeRecontactCommand(db,code,first.id,first.lease_token,now)).toMatchObject({ok:false});
    bridge.receipt(code,first.id,first.lease_token,"succeeded",`${cid}:already-sent`);
    expect(db.prepare("SELECT status FROM recontact_jobs WHERE id=?").get(id!)).toMatchObject({status:"cancelled"});
    expect(db.prepare("SELECT status FROM recontact_steps WHERE job_id=? ORDER BY seq").all(id!))
      .toEqual([{status:"sent"},{status:"cancelled"}]);
  });

  it("keeps the new login paused even if it changes back before a send is authorized", () => {
    queue();
    const first=bridge.claim(code,"",true)!;
    bridge.heartbeat(code,"online","replacement");
    bridge.heartbeat(code,"online","account");
    expect(authorizeRecontactCommand(db,code,first.id,first.lease_token,now)).toMatchObject({ok:false});
  });

  it.each(["agent","dify"] as const)("uses the confirmed %s answer and the exact inbound id even when sync runs late", (provider) => {
    now=Date.now();
    bridge.heartbeat(code,"online","account");
    db.prepare("UPDATE service_positions SET data_json=? WHERE id=9").run(JSON.stringify({work_address:"广州某站"}));
    if (provider==="dify") db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.position_id',9,'$.reply_provider','dify')").run();
    db.prepare("INSERT INTO recontact_rules(position_id,stage,enabled,wait_minutes,start_minute,end_minute,parts_json) VALUES (9,'work_location',1,30,540,1260,?)")
      .run(JSON.stringify([{kind:"text",value:"你方便来面试吗？",delay_ms:0}]));
    const eventId=bridge.inboundEvent(code,`${cid}:456`,cid,"在哪里上班");
    const mark=(traceId:string,turnId:string) => markRecontactAnchor(db,{traceId,deviceCode:code,sessionKey:cid,
      positionId:9,provider,turnId,question:"在哪里上班",messages:[{type:"text",content:"工作地点在广州某站。"}]});
    expect(mark("draft","456")).toBe(true);
    expect(bridge.claim(code,"",true)).toBeNull();
    finishRecontactAnchor(db,"draft",code,cid,now);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recontact_jobs").get()?.n).toBe(0);
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?,'inbound','在哪里上班','received',?,?)")
      .run(code,customerId,new Date(now).toISOString(),eventId);
    expect(bridge.claim(code,"",true)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM recontact_jobs").get()?.n).toBe(1);
    expect(mark("repeat","456")).toBe(true);
    finishRecontactAnchor(db,"repeat",code,cid,now);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recontact_jobs").get()?.n).toBe(1);
  });

  it("reconciles a media receipt and late outbound sync without creating a second bubble", () => {
    const hash="a".repeat(64);
    db.prepare("INSERT INTO media_assets(name,kind,storage_path,sha256) VALUES ('图.jpg','image',?,?)").run("media/"+hash+".jpg",hash);
    const target=recontactTarget(db,conversationId,0,now)!;
    queueRecontactBatch(db,target,parseRecontactParts(db,9,[{kind:"image",value:"图.jpg",delay_ms:0}]),"media",target.baseline_inbound_id,now);
    const first=bridge.claim(code,"",true)!;
    expect(first).toMatchObject({recontact_kind:"image"});
    bridge.receipt(code,first.id,first.lease_token,"succeeded",`${cid}:2`);
    bridge.observeOutbound(code,`${cid}:2`,cid,"[媒体]","测试联系人",new Date(now).toISOString());
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE direction='outbound'").get()?.n).toBe(1);
  });

  it("leaves a prior canvas timeout with the existing flow and recognizes only relevant new nodes", () => {
    db.prepare("INSERT INTO recontact_rules(position_id,stage,enabled,wait_minutes,start_minute,end_minute,parts_json) VALUES (9,'interview_invite',1,30,540,1260,'[]')").run();
    expect(recontactFlowStage(db,9,[{body:"方便的话，可以约个时间来面试。"}])).toBe("interview_invite");
    expect(recontactFlowStage(db,9,[{body:"如果你不方便来面试，可以以后再聊。"}])).toBeUndefined();
    db.prepare(`INSERT INTO agent_conversation_state(session_key,device_code,position_id,node_key,phase,snapshot_json)
      VALUES (?,?,9,'legacy','awaiting',?)`).run(cid,code,JSON.stringify({edges:[{from_key:"legacy",trigger:"timeout"}]}));
    expect(queue()).toBeUndefined();
    db.prepare("UPDATE agent_conversation_state SET snapshot_json=? WHERE device_code=?").run(JSON.stringify({edges:[]}),code);
    expect(queue()).toBeGreaterThan(0);
  });

  it("schedules from a durable canvas snapshot after restart and a new published flow version", () => {
    const part=[{kind:"text",value:"方便时来面试吗？",delay_ms:0}];
    db.prepare("INSERT INTO recontact_rules(position_id,stage,enabled,wait_minutes,start_minute,end_minute,parts_json) VALUES (9,'interview_invite',1,5,540,1260,?)")
      .run(JSON.stringify(part));
    const eventId=bridge.inboundEvent(code,`${cid}:42`,cid,"想找工作");
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?,'inbound','想找工作','received',?,?)")
      .run(code,customerId,new Date(now-5*60_000).toISOString(),eventId);
    db.prepare(`INSERT INTO agent_conversation_state
      (session_key,device_code,position_id,flow_version,node_key,phase,step_index,snapshot_json,await_since,recontact_inbound_id)
      VALUES (?,?,9,1,'invite','awaiting',1,?,?,'42')`).run(cid,code,JSON.stringify({reply_mode_id:"",edges:[],
      nodes:[{node_key:"invite",await_reply:true,recontact_stage:"interview_invite",parts:[{body:"你要不要来面试？"}]}]}),new Date(now-4*60_000).toISOString());
    db.prepare("INSERT INTO agent_flow(position_id,version,canvas_json,status) VALUES (9,2,'{}','enabled')").run();
    expect(new DeviceBridgeStore(db,()=>now).claim(code,"",true)).toBeNull();
    expect(db.prepare("SELECT source,stage,due_at FROM recontact_jobs").get()).toMatchObject({source:"auto",stage:"interview_invite",due_at:now+60_000});
    now+=60_000;
    bridge.heartbeat(code,"online","account");
    expect(bridge.claim(code,"",true)?.content).toBe(part[0].value);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recontact_jobs").get()?.n).toBe(1);
  });
});

import type {DatabaseSync} from 'node:sqlite';
type Row=Record<string,unknown>;
const value=(...values:unknown[])=>String(values.find(v=>v!==null&&v!==undefined&&String(v).trim())??'');
const object=(raw:unknown):Row=>{try{return JSON.parse(String(raw||'{}')) as Row}catch{return {}}};

/** One row per archive. Exact session association only; never join by nickname or phone. */
export function archiveCandidates(db:DatabaseSync, sessionKey?: string) {
  const rows=db.prepare(`SELECT a.*, c.device_code AS conversation_device,c.customer_id,c.nickname,c.recruit_status,
    c.name AS conversation_name,c.phone AS conversation_phone,c.province,c.city AS conversation_city,c.district,
    c.factory_name AS conversation_factory,c.profile_json,c.created_at AS conversation_created,
    sp.position_name,sp.data_json AS position_data,f.factory_name
    FROM agent_archive a LEFT JOIN agent_conversations c ON c.id=CASE
      WHEN a.session_key LIKE 'manual:%' OR a.session_key LIKE 'group:%' OR a.session_key LIKE 'R:%' THEN NULL
      WHEN a.dify_device_code<>'' OR a.session_key LIKE 'dify:%' THEN (SELECT cc.id FROM agent_conversations cc
        WHERE cc.id=a.dify_conversation_row_id AND cc.device_code=a.dify_device_code
          AND cc.external_conversation_id=a.dify_external_session
          AND a.dify_device_code<>'' AND a.dify_external_session<>''
          AND cc.external_conversation_id NOT LIKE 'group:%' AND cc.external_conversation_id NOT LIKE 'R:%')
      ELSE (
      SELECT cc.id FROM agent_conversations cc WHERE cc.external_conversation_id=a.session_key
      AND (SELECT COUNT(*) FROM agent_conversations same WHERE same.external_conversation_id=a.session_key)=1
      ORDER BY cc.updated_at DESC,cc.id DESC LIMIT 1) END
    LEFT JOIN service_positions sp ON sp.id=a.position_id
    LEFT JOIN factories f ON f.id=sp.factory_id
    WHERE (a.name<>'' OR a.phone<>'' OR a.interview_date<>'')
      ${sessionKey === undefined ? "" : "AND a.session_key=?"}
    ORDER BY a.updated_at DESC,a.session_key`).all(...(sessionKey === undefined ? [] : [sessionKey])) as Row[];
  return rows.map(row=>{
    const session=String(row.session_key),profile=object(row.profile_json),position=object(row.position_data);
    const canUseLegacyKey = !row.dify_device_code && !/^(?:dify:|manual:|group:|R:)/i.test(session);
    const matches = canUseLegacyKey
      ? (db.prepare('SELECT COUNT(*) n FROM agent_conversations WHERE external_conversation_id=?').get(session) as {n:number}).n
      : Number(Boolean(row.conversation_device));
    // Historical manual IDs carry the device code, but do not imply a customer chat exists.
    const manualDevice=session.startsWith('manual:')&&session.includes(':manual:')?session.slice(7,session.indexOf(':manual:')):'';
    const code=value(row.conversation_device,row.dify_device_code,manualDevice);
    const device=db.prepare("SELECT device_name,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? ORDER BY id DESC LIMIT 1").get(code) as Row|undefined;
    const deviceData=object(device?.data_json);
    const bridge=db.prepare('SELECT account_id FROM bridge_devices WHERE device_code=?').get(code) as Row|undefined;
    const event=db.prepare("SELECT remind_count FROM candidate_events WHERE device_code=? AND customer_id=? ORDER BY updated_at DESC,id DESC LIMIT 1").get(code,String(row.customer_id??'')) as Row|undefined;
    const name=value(row.name,row.conversation_name),phone=value(row.phone,row.conversation_phone);
    const city=value(row.city,row.conversation_city),province=value(row.province,profile.province),district=value(row.district,profile.district);
    const date=value(row.interview_date),time=value(row.interview_time);
    const reminderPrefix=`followup:${code}:${String(row.customer_id??'')}:${date}:`;
    const reminder=db.prepare("SELECT status FROM bridge_commands WHERE device_code=? AND customer_id=? AND substr(idempotency_key,1,?)=? ORDER BY created_at DESC LIMIT 1")
      .get(code,String(row.customer_id??''),reminderPrefix.length,reminderPrefix) as Row|undefined;
    const status=row.arrival_status==='arrived'?'checked_in':row.recruit_status==='disqualified'?'disqualified':'invited';
    return {id:session,session_key:session,position_id:Number(row.position_id),device_code:code,
      device_name:value(deviceData.name,device?.device_name,code),account:value(row.dify_account_id,bridge?.account_id),
      recruiter_id:value(deviceData.recruiter_id),customer_id:value(row.customer_id),nickname:value(row.nickname),
      name,phone,province,city,district,factory_name:row.dify_device_code?value(row.factory_name,position.factory_name,row.position_name):value(row.conversation_factory,row.factory_name,position.factory_name,row.position_name),
      interview_date:date,interview_time:time,interview_confirmed:Boolean(row.interview_confirmed),
      interview_point:value(row.interview_point),interview_address:value(row.interview_address),
      event_at:value(row.updated_at),created_at:value(row.updated_at,row.conversation_created),
      summary:[name||'姓名待补',phone,[date,time].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
      registration_text:value(profile.registration_text),status,
      has_conversation:matches===1&&Boolean(code&&row.customer_id!==null&&row.customer_id!==undefined),
      association_status:matches>1?'ambiguous':matches===1?'linked':'unlinked',
      remind_count:Number(event?.remind_count??0),remind_status:value(reminder?.status,'not_reminded'),
    };
  });
}

import type { DatabaseSync } from 'node:sqlite';
import { normalizePositionFacts } from '../../shared/position-facts.js';
import { positionKnowledge } from '../agent/position-knowledge.js';
import { interviewSchedule } from './dify-interview.js';

const record=(raw:unknown):Record<string,unknown>=>{
  if(typeof raw==='string'){try{return record(JSON.parse(raw));}catch{return {};}}
  return raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
};
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
const first=(...values:unknown[])=>values.map(text).find(Boolean)||'';

/** Mode two reads city materials live. Existing position facts only fill missing city fields. */
export function difyContext(db:DatabaseSync,id:number){
  const row=db.prepare(`SELECT p.position_name,p.status,p.data_json,c.id city_id,c.city_name,c.data_json city_json,f.factory_name
    FROM service_positions p LEFT JOIN factories f ON f.id=p.factory_id
    LEFT JOIN cities c ON c.id=COALESCE(p.city_id,f.city_id) WHERE p.id=?`).get(id) as
    {position_name:string;status:string;data_json:string;city_id:number|null;city_name:string|null;city_json:string|null;factory_name:string|null}|undefined;
  if(!row||row.status!=='enabled')return null;
  const position=normalizePositionFacts(record(row.data_json)),city=record(row.city_json);
  const sections=record(city.prompt_sections),salary=record(city.salary),hours=record(city.work_hours),interview=record(city.interview);
  const cityFields:Record<string,string>={
    wage_text:first(salary.raw,sections.salary_detail,sections.salary_ask),
    hours_text:first(hours.raw,sections.work_hours,sections.shift_info),
    welfare_text:[first(sections.meal_dorm),first(city.social_insurances,sections.social_insurance)].filter(Boolean).join('；'),
    place:first(city.work_location,sections.work_location),
    interview_address:first(interview.location,interview.raw_address,city.interview_site_name),
    interview_time:first(interview.time,interview.raw_time),
    job_content:first(sections.work_content),
    interview_notice:first(interview.interview_notice,sections.interview_notice),
    interview_guide:first(interview.interview_guide,sections.checkin_guide),
    interview_contact:first(interview.contact),coordinates:first(interview.coordinates),
    available_lines:Array.isArray(city.available_lines)?city.available_lines.map(String).join('、'):'',
  };
  const facts:Record<string,string>={job_title:row.position_name,city:first(row.city_name,position.city),factory_name:first(position.factory_name,row.factory_name)};
  const sources:Record<string,string>={};
  for(const key of Object.keys(cityFields)){
    const value=cityFields[key]||first(position[key]);
    if(value){facts[key]=value;sources[key]=cityFields[key]?'city':'position_fallback';}
  }
  // Preserve custom city sections as data, never as system instructions or eligibility decisions.
  const materials=Object.fromEntries(Object.entries(sections).filter(([,v])=>text(v)));
  const mapped:Record<string,string>={salary_detail:'wage_text',salary_ask:'wage_text',work_hours:'hours_text',shift_info:'hours_text',meal_dorm:'welfare_text',social_insurance:'welfare_text',work_content:'job_content',interview_notice:'interview_notice',checkin_guide:'interview_guide'};
  for(const[key,fact]of Object.entries(mapped))if(key in materials&&facts[fact])materials[key]=facts[fact];
  const verticalId=Number(city.knowledge_vertical_id)||null;
  const knowledge=positionKnowledge(db,id,facts,verticalId);
  const schedule=interviewSchedule(db,id,facts);
  return {...facts,city_materials:materials,knowledge,interview_days:schedule.dayLabels,interview_points:schedule.points,
    sources:{city_id:row.city_id,position_id:id,fields:sources,knowledge_scope:'global_and_current_position',knowledge_vertical_id:verticalId}};
}

/** Catch an explicit address/guide floor disagreement without guessing missing details. */
export function difyContextConflict(context:NonNullable<ReturnType<typeof difyContext>>){
  const number=(value:string)=>{
    if(/^\d+$/.test(value))return Number(value);
    const cn:Record<string,number>={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    let result=0,digit=0;for(const char of value){if(char==='十'||char==='百'){result+=(digit||1)*(char==='十'?10:100);digit=0;}else digit=cn[char]??0;}return result+digit;
  };
  const floors=(value:string)=>[...value.matchAll(/([0-9零一二两三四五六七八九十百]+)\s*(?:楼|层)/g)].map(m=>number(m[1]));
  const fields=context as Record<string,unknown>;
  const address=floors(String(fields.interview_address||'')),guide=floors(String(fields.interview_guide||''));
  return address.length&&guide.length&&address.at(-1)!==guide.at(-1)?'面试地址与面试指引的楼层不一致，请在城市资料中一并核对':'';
}

/** Keep complete relevant entries within the published Chatflow's 20k input limit. */
export function difyInput(context:NonNullable<ReturnType<typeof difyContext>>,query:string){
  const {city_materials,knowledge,...core}=context;
  const result={...core,city_materials:{} as Record<string,unknown>,knowledge:[] as typeof knowledge,
    retrieval:{omitted:0,limit:20000}};
  const tokens=[...new Set((query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g)||[]))];
  const rank=(s:string)=>tokens.reduce((n,t)=>n+(s.toLowerCase().includes(t)?t.length:0),0);
  const entries=[...Object.entries(city_materials).map(([key,value])=>({key,value,score:rank(key+' '+value),kind:'city' as const})),
    ...knowledge.map(value=>({key:String(value.id),value,score:rank(value.question+' '+value.answer),kind:'faq' as const}))]
    .sort((a,b)=>b.score-a.score);
  if(JSON.stringify(result).length>19000)return null;
  for(const entry of entries){
    if(entry.kind==='city')result.city_materials[entry.key]=entry.value;else result.knowledge.push(entry.value);
    if(JSON.stringify(result).length>19500){
      if(entry.kind==='city')delete result.city_materials[entry.key];else result.knowledge.pop();
      result.retrieval.omitted++;
    }
  }
  return result;
}

/** Shanghai calendar day, shared by the homepage and its existing Dify health table. */
export function difyDashboard(db:DatabaseSync,deviceCodes:string[]|null){
  const filter=deviceCodes===null?'':deviceCodes.length?` AND device_code IN (${deviceCodes.map(()=>'?').join(',')})`:' AND 1=0';
  const rows=db.prepare(`SELECT device_code,COUNT(*) total,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) fail_count,
    MAX(CASE WHEN status='failed' THEN created_at ELSE NULL END) last_fail,
    SUM(CASE WHEN error_code IN ('dify_invalid_reply','dify_invalid_response','dify_fact_mismatch') THEN 1 ELSE 0 END) abnormal
    FROM dify_reply_calls WHERE date(created_at,'+8 hours')=date('now','+8 hours')${filter} GROUP BY device_code`).all(...(deviceCodes||[])) as
    Array<{device_code:string;total:number;fail_count:number;last_fail:string|null;abnormal:number}>;
  return {failed:rows.reduce((n,r)=>n+Number(r.fail_count),0),abnormal:rows.reduce((n,r)=>n+Number(r.abnormal),0),
    health:rows.filter(r=>r.fail_count>0).sort((a,b)=>b.fail_count-a.fail_count).map(r=>({device_code:r.device_code,fail_count:r.fail_count,last_fail:r.last_fail})),
    degraded:rows.filter(r=>r.fail_count>0).map(r=>({device_code:r.device_code,fail_rate:Math.round(r.fail_count/r.total*100)}))};
}

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

const positionSectionKeys = [
  'positions', 'requirements', 'factory_env', 'dorm_env', 'work_env',
  'uniform', 'medical_fee', 'luggage_question', 'interview_notice', 'checkin_guide', 'registration_form',
  'salary_detail', 'salary_ask', 'work_hours', 'shift_info', 'meal_dorm', 'social_insurance', 'work_content',
] as const;

/** Saved form fields take precedence over city defaults. Older fact cards remain readable. */
export function difyContext(db:DatabaseSync,id:number){
  const row=db.prepare(`SELECT p.position_name,p.status,p.data_json,c.id city_id,c.city_name,c.data_json city_json,f.factory_name
    FROM service_positions p LEFT JOIN factories f ON f.id=p.factory_id
    LEFT JOIN cities c ON c.id=COALESCE(p.city_id,f.city_id) WHERE p.id=?`).get(id) as
    {position_name:string;status:string;data_json:string;city_id:number|null;city_name:string|null;city_json:string|null;factory_name:string|null}|undefined;
  if(!row||row.status!=='enabled')return null;
  const savedPosition=record(row.data_json);
  const position=normalizePositionFacts(savedPosition),city=record(row.city_json);
  const sections=record(city.prompt_sections),salary=record(city.salary),hours=record(city.work_hours),interview=record(city.interview);
  const positionSections = record(position.base_sections);
  const workAddress = text(savedPosition.work_address);
  const savedInterviewAddress = text(savedPosition.interview_address);
  // Old forms sometimes copied a list of work lines into both address inputs.
  const copiedWorkLines = savedInterviewAddress === workAddress && /全线路|就近安排|自选站点/.test(workAddress);
  const interviewAddress = copiedWorkLines ? '' : savedInterviewAddress;
  const cityInterviewAddress = first(interview.location, interview.raw_address, city.interview_site_name);
  const usableCityInterviewAddress = /^(?:.{0,8})示例面试点$/.test(cityInterviewAddress) ? '' : cityInterviewAddress;
  const defaultMeal = text(sections.meal_dorm);
  const defaultSocialInsurance = first(city.social_insurances, sections.social_insurance);
  const positionMeal = first(positionSections.meal_dorm, position.accommodation);
  const positionSocialInsurance = text(positionSections.social_insurance);
  const welfare = (...values: string[]) => [...new Set(values.filter(Boolean))].join('；');
  const cityFields:Record<string,string>={
    wage_text:first(salary.raw,sections.salary_detail,sections.salary_ask),
    hours_text:first(hours.raw,sections.work_hours,sections.shift_info),
    welfare_text:welfare(defaultMeal, defaultSocialInsurance),
    place:first(city.work_location,sections.work_location),
    interview_address:usableCityInterviewAddress,
    interview_time:first(interview.time,interview.raw_time),
    job_content:first(sections.work_content),
    interview_notice:first(interview.interview_notice,sections.interview_notice),
    interview_guide:first(interview.interview_guide,sections.checkin_guide),
    interview_contact:first(interview.contact),coordinates:first(interview.coordinates),
    available_lines:Array.isArray(city.available_lines)?city.available_lines.map(String).join('、'):'',
  };
  const facts:Record<string,string> & {job_title:string;city:string;wage_text?:string;hours_text?:string;
    welfare_text?:string;job_content?:string;place?:string;interview_time?:string;interview_address?:string}={
    job_title:row.position_name,city:first(row.city_name,position.city),factory_name:first(position.factory_name,row.factory_name),
  };
  const sources:Record<string,string>={};
  const positionFields: Record<string, string> = {
    wage_text: first(positionSections.salary_detail, positionSections.salary_ask),
    hours_text: first(positionSections.work_hours, positionSections.shift_info),
    welfare_text: positionMeal || positionSocialInsurance
      ? welfare(positionMeal || defaultMeal, positionSocialInsurance || defaultSocialInsurance) : '',
    place: workAddress,
    interview_address: interviewAddress,
    interview_time: text(savedPosition.interview_time),
    job_content: text(positionSections.work_content),
    interview_notice: first(positionSections.interview_notice, position.interview_notice),
    interview_guide: first(positionSections.checkin_guide, position.interview_guide),
    coordinates: text(savedPosition.coordinates),
  };
  for (const key of Object.keys(cityFields)) {
    const legacyValue = key === 'interview_address' && copiedWorkLines
      ? '' : position[key];
    const value = first(positionFields[key], cityFields[key], legacyValue);
    if (value) {
      facts[key] = value;
      sources[key] = positionFields[key] ? 'position' : cityFields[key] ? 'city' : 'position_fallback';
    }
  }
  // Keep the published Chatflow's city_materials input, including original custom city sections.
  const materials = Object.fromEntries(Object.entries(sections).flatMap(([key, value]) => {
    const content = text(value);
    return content ? [[key, content]] : [];
  }));
  const sectionSources: Record<string, string> = Object.fromEntries(Object.keys(materials).map(key => [key, 'city']));
  const aliases: Record<string, string> = {
    salary_detail:'wage_text', salary_ask:'wage_text', work_hours:'hours_text', shift_info:'hours_text',
    interview_notice:'interview_notice', checkin_guide:'interview_guide', work_content:'job_content',
  };
  for (const key of positionSectionKeys) {
    const fact = aliases[key];
    const content = text(positionSections[key]);
    if (content) {
      materials[key] = content;
      sectionSources[key] = 'position';
    } else if (fact && facts[fact] && (materials[key] || key === 'interview_notice' || key === 'checkin_guide')) {
      materials[key] = facts[fact];
      sectionSources[key] = sources[fact];
    }
  }
  if (positionMeal && !text(positionSections.meal_dorm) && materials.meal_dorm) {
    materials.meal_dorm = positionMeal;
    sectionSources.meal_dorm = 'position';
  }
  if (defaultSocialInsurance && !positionSocialInsurance && materials.social_insurance) {
    materials.social_insurance = defaultSocialInsurance;
  }
  const verticalId=Number(city.knowledge_vertical_id)||null;
  const knowledge=positionKnowledge(db,id,facts,verticalId);
  const schedule=interviewSchedule(db,id,facts,true);
  return {...facts,city_materials:materials,knowledge,interview_days:schedule.dayLabels,interview_points:schedule.points,
    sources:{city_id:row.city_id,position_id:id,fields:sources,sections:sectionSources,knowledge_scope:'global_and_current_position',knowledge_vertical_id:verticalId}};
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
  const notice=floors(String(fields.interview_notice||''));
  const guideDiffers = address.length && guide.length && address.at(-1) !== guide.at(-1);
  const noticeDiffers = address.length === 1 && notice.length === 1 && address[0] !== notice[0];
  return guideDiffers || noticeDiffers ? '面试地址、通知或指引的楼层不一致，请核对岗位和城市资料' : '';
}

/** Keep complete relevant entries within the published Chatflow's 20k input limit. */
export function difyInput(context:NonNullable<ReturnType<typeof difyContext>>,query:string){
  const {city_materials,knowledge,...core}=context;
  const result={...core,sources:{...core.sources,sections:{} as Record<string,string>},city_materials:{} as Record<string,unknown>,knowledge:[] as typeof knowledge,
    reply_style:'直接用简短、自然的接待话术回答。sources 中标为 position 的是当前已保存的岗位资料，同一事项优先用它。按本轮相关段落保留数字、条件和签到编号。知识库补充空白。候选人已选面试点时，优先使用该点的地址、时间和指引。',
    retrieval:{omitted:0,limit:20000}};
  const tokens=[...new Set((query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g)||[]))];
  const rank=(s:string)=>tokens.reduce((n,t)=>n+(s.toLowerCase().includes(t)?t.length:0),0);
  const entries=[...Object.entries(city_materials).map(([key,value])=>({
    key,value,score:rank(key+' '+value),isPosition:core.sources.sections[key] === 'position',kind:'city' as const,
  })), ...knowledge.map(value=>({
    key:String(value.id),value,score:rank(value.question+' '+value.answer),isPosition:false,kind:'faq' as const,
  }))].sort((a,b)=>Number(b.isPosition)-Number(a.isPosition) || b.score-a.score);
  if(JSON.stringify(result).length>19000)return null;
  for(const entry of entries){
    if (entry.kind === 'city') {
      result.city_materials[entry.key] = entry.value;
      const source = core.sources.sections[entry.key];
      if (source) result.sources.sections[entry.key] = source;
    } else result.knowledge.push(entry.value);
    if(JSON.stringify(result).length>19500){
      if (entry.kind === 'city') {
        delete result.city_materials[entry.key];
        delete result.sources.sections[entry.key];
      } else result.knowledge.pop();
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

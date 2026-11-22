import type { DatabaseSync } from "node:sqlite";
import { parseDeviceData, parseFactoryIds } from "../../shared/device-factories.js";
import { difyContext, difyContextConflict } from "./dify-context.js";
import { queueDifyGroupNotification } from "./dify-group-notification.js";
import { interviewDate, interviewSchedule, validateInterview } from "./dify-interview.js";

type Job = { id:number; title:string; city:string; district:string; factory:string; districts:string[] };
type Draft = { name?:string; phone?:string; date?:string; time?:string; point?:string; reviewed?:string };
type State = { position_id:number|null; draft_json:string; updated_at:string };
type Booking = { position_id:number; position_name:string|null; interview_date:string; interview_time:string; interview_point:string; interview_address:string };

function jobsForDevice(db:DatabaseSync, device:string, initial:number, preview:boolean) {
  const config = db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(device) as
    {data_json:string} | undefined;
  const factories = preview ? [] : parseFactoryIds(parseDeviceData(config?.data_json).factory_ids);
  const initialCity = db.prepare(`SELECT COALESCE(p.city_id,f.city_id) city_id FROM service_positions p
    LEFT JOIN factories f ON f.id=p.factory_id WHERE p.id=?`).get(initial) as {city_id:number|null} | undefined;
  const placeholders = factories.map(() => "?").join(",");
  const scope = factories.length ? `p.factory_id IN (${placeholders})` : "(p.id=? OR COALESCE(p.city_id,f.city_id)=?)";
  const rows = db.prepare(`SELECT p.id,p.position_name,p.data_json,c.city_name,c.data_json city_json,f.factory_name
    FROM service_positions p LEFT JOIN factories f ON f.id=p.factory_id
    LEFT JOIN cities c ON c.id=COALESCE(p.city_id,f.city_id)
    WHERE p.tenant_id=1 AND p.status='enabled' AND (p.factory_id IS NULL OR (f.status='enabled' AND f.tenant_id=p.tenant_id))
    AND (p.city_id IS NULL OR f.city_id IS NULL OR p.city_id=f.city_id) AND ${scope}
    ORDER BY p.featured DESC,p.id`).all(...(factories.length ? factories : [initial,initialCity?.city_id ?? null])) as
    {id:number; position_name:string; data_json:string; city_name:string|null; city_json:string|null; factory_name:string|null}[];
  return rows.map(row => {
    const position = parseDeviceData(row.data_json);
    const city = parseDeviceData(row.city_json);
    return {
      id:row.id, title:row.position_name, city:row.city_name || "", factory:row.factory_name || "",
      district:typeof position.district === "string" ? position.district.trim() : "",
      districts:Array.isArray(city.districts) ? city.districts.flatMap(d => {
        if (typeof d === "string") return [d.trim()];
        const item = d as { name?:string; district_name?:string } | null;
        return [item?.name || item?.district_name || ""];
      }).filter(Boolean) : [],
    };
  });
}

function matchingJobs(jobs:Job[], query:string) {
  const matches = jobs.map(job => ({
    job,
    rank: job.district && query.includes(job.district) ? 3
      : job.districts.some(district => query.includes(district)) ? 2
      : job.city && query.includes(job.city) ? 1 : 0,
  }));
  // A precise district outranks city-wide records. For an unrecognised region
  // the caller shows the device's job scope instead of asserting proximity.
  const best = Math.max(0, ...matches.map(match => match.rank));
  return matches.filter(match => best === 0 || match.rank === best).slice(0,8).map(match => match.job);
}

function parseDraft(query:string, previous:Draft):Draft {
  const next = {...previous};
  const fields = [...query.matchAll(/(姓名|名字|电话|手机号|日期|时间|面试点)\s*[:：]\s*(.*?)(?=\s*(?:姓名|名字|电话|手机号|日期|时间|面试点)\s*[:：]|$)/gs)];
  for (const [, label, raw] of fields) {
    const value = raw.trim().replace(/[，。、；,;]+$/, "");
    switch (label) {
      case "姓名": case "名字": next.name = /^[\p{L}· .'-]{1,40}$/u.test(value) ? value : ""; break;
      case "电话": case "手机号": next.phone = /^1[3-9]\d{9}$/.test(value) ? value : ""; break;
      case "日期": next.date = interviewDate(value); break;
      case "时间": next.time = /^\d{1,2}[:：]\d\d$/.test(value) ? value.normalize("NFKC") : ""; break;
      case "面试点": next.point = value.slice(0,200); break;
    }
  }
  if(fields.length)delete next.reviewed;
  return next;
}

export function recruitmentPositionAvailable(db:DatabaseSync,device:string,initial:number,selected:number,preview:boolean){
  return jobsForDevice(db,device,initial,preview).some(job=>job.id===selected);
}

export function selectedRecruitmentPosition(db:DatabaseSync,identity:string,initial:number){
  const row=db.prepare("SELECT position_id FROM dify_recruitment_state WHERE identity=?").get(identity) as
    {position_id:number|null} | undefined;
  return row?.position_id || initial;
}

export function recruitmentTurn(db:DatabaseSync, input:{
  identity:string; device:string; account:string; session:string; initial:number; query:string;
  preview:boolean; canWrite:boolean;
}):{positionId:number;message?:string} {
  const archiveKey = `dify:${input.identity}`;
  const state = db.prepare("SELECT position_id,draft_json,updated_at FROM dify_recruitment_state WHERE identity=?").get(input.identity) as State | undefined;
  const booking = () => db.prepare(`SELECT a.position_id,p.position_name,a.interview_date,a.interview_time,a.interview_point,a.interview_address
    FROM agent_archive a LEFT JOIN service_positions p ON p.id=a.position_id WHERE a.session_key=?`).get(archiveKey) as Booking | undefined;
  const saved = input.preview ? undefined : booking();
  const jobs = jobsForDevice(db,input.device,input.initial,input.preview);
  const chosen = state?.position_id || input.initial;
  const current = jobs.find(job => job.id === chosen);
  const respond = (message:string) => ({ message, positionId:current?.id ?? input.initial });
  const query = input.query.normalize("NFKC").trim().replace(/[。！？!?]+$/, "");
  const isChoose = /^(?:选择岗位|换岗|选岗位)(?:\s+|\s*[:：]\s*)(.+)$/.exec(query)
    ?? /^(?:选择岗位|换岗|选岗位)(\d+)$/.exec(query);
  const named = jobs.filter(job => query === job.title || query === `我选${job.title}` || query === `我要选${job.title}`);
  const wantsList = /有什么岗位|有哪些岗位|推荐.{0,8}(?:岗位|工作)|附近.{0,12}(?:岗位|工作)|^换岗$|换个岗位|看其他岗位/.test(query);
  const includesRegion = jobs.some(job => [job.city,job.district,...job.districts].some(name => name && query.includes(name)));
  const locationMessage = /^(?:我)?(?:现在)?(?:在|住在).{1,24}(?:区|市|县|镇|街道)$/.test(query);
  const scheduleRequest = /^(?:查看面试安排|可预约时间|面试有哪些时间|可选面试点)$/.test(query);
  const confirm = /^(?:确认报名|确认登记|同意并确认报名)$/.test(query);
  const cancel = /^(?:取消报名|撤销报名)$/.test(query);
  const bookingStatus = /报名(?:成功|好了|结果|状态|了吗)|(?:有|是否)登记|我的面试安排/.test(query);
  const starts = /^(?:我想|我要|帮我|可以)?(?:报名|登记面试|预约面试)(?:$|\s|[：:，,])/.test(query);
  const sendsFields = /(?:姓名|名字|电话|手机号|日期|时间|面试点)\s*[:：]/.test(query);
  const fresh = state?.position_id===chosen && Date.now()-Date.parse(state.updated_at.replace(" ","T")+"Z") < 86400000;
  const draft = fresh ? parseDeviceData(state.draft_json) as Draft : {};
  const phoneOnly = /^1[3-9]\d{9}$/.test(query);
  const save = (id:number, data:Draft) => {
    db.prepare(`INSERT INTO dify_recruitment_state(identity,position_id,draft_json) VALUES (?,?,?)
      ON CONFLICT(identity) DO UPDATE SET position_id=excluded.position_id,draft_json=excluded.draft_json,updated_at=CURRENT_TIMESTAMP`)
      .run(input.identity,id,JSON.stringify(data));
  };

  if (isChoose || named.length) {
    const requested = isChoose?.[1].trim();
    const matches = requested
      ? jobs.filter(job => String(job.id) === requested || job.title === requested)
      : named;
    if (matches.length !== 1) return respond("请选择本设备可选范围内的唯一岗位，可回复「选择岗位 编号」。");
    if (saved && saved.position_id !== matches[0].id) return respond("原面试已登记，如需换岗或改约，请联系招聘员处理。");
    save(matches[0].id,{});
    return {message:`已选择${matches[0].title}。可以继续问工资或工时，回复「查看面试安排」或「报名」可进入面试登记。`,positionId:matches[0].id};
  }
  if (wantsList || locationMessage || (!state && includesRegion && /找工作|想找|求职/.test(query))) {
    const options = matchingJobs(jobs,query);
    if (!options.length) return respond("当前设备未配置可推荐的岗位，请联系招聘员。");
    const list = options.map(job => `${job.id}．${[job.city,job.district,job.title,job.factory].filter(Boolean).join(" · ")}`);
    return respond(`当前可选岗位\n${list.join("\n")}\n回复「选择岗位 编号」即可继续咨询或报名。`);
  }
  if (saved && (bookingStatus || confirm || starts || sendsFields || phoneOnly)) {
    const savedJob = jobs.find(job => job.id === saved.position_id);
    if (confirm && input.canWrite && input.account && savedJob) {
      queueDifyGroupNotification(db, input.device, archiveKey, savedJob);
    }
    return respond(`已登记${saved.position_name || ""}面试，${saved.interview_date} ${saved.interview_time}，${saved.interview_point}，${saved.interview_address}。`);
  }
  if(saved&&cancel)return respond("面试已登记，请联系招聘员取消。");
  if (!current) return respond("当前岗位不可用或城市和厂区归属不一致，请联系招聘员核对，可回复「推荐岗位」查看其他岗位。");
  if (!scheduleRequest && !confirm && !cancel && !starts && !sendsFields && !phoneOnly && !bookingStatus) return {positionId:current.id};
  if (bookingStatus) return respond("当前会话还没有已确认的面试登记。回复「报名」可以开始。");

  const context = difyContext(db,current.id);
  if (!context || difyContextConflict(context)) return respond("该岗位的面试资料需要招聘员核对。");
  const schedule = interviewSchedule(db,current.id,context as Record<string,unknown>);
  const availability = [
    current.title,
    schedule.dayLabels.length ? `面试星期 ${schedule.dayLabels.join("、")}` : "面试星期待招聘员确认",
    schedule.timeText ? `面试时间 ${schedule.timeText}` : "面试时间待招聘员确认",
    schedule.points.length ? `面试点 ${schedule.points.map(point=>point.address && point.address!==point.name ? `${point.name}（${point.address}）` : point.name).join("、")}` : "面试点待招聘员确认",
  ].join("\n");
  if (scheduleRequest) return respond(availability);
  if (cancel) {
    save(current.id,{});
    return respond("已清除本次待确认的报名资料。");
  }
  if (!input.preview && !input.canWrite) return respond("请在当前企微会话中完成报名确认。");
  if (!schedule.days.length || !schedule.slots.length || !schedule.points.some(point=>point.address)) {
    if (draft.reviewed) save(current.id,{...draft,reviewed:undefined});
    return respond(`${availability}\n当前资料不足以自动登记，请联系招聘员确认。`);
  }
  if (sendsFields) Object.assign(draft,parseDraft(query,draft));
  if(sendsFields || phoneOnly)delete draft.reviewed;
  if(phoneOnly)draft.phone=query;
  if (!draft.point && schedule.points.length === 1) draft.point=schedule.points[0].name;
  save(current.id,draft);
  if (!draft.name || !draft.phone || !draft.date || !draft.time || !draft.point) {
    return respond(`${availability}\n请发「姓名：张三 电话：手机号 日期：YYYY-MM-DD 时间：HH:mm 面试点：名称」。用于安排本次面试，核对后回复「确认报名」。`);
  }
  const valid = validateInterview(db,current.id,schedule,draft.date,draft.time,draft.point);
  if ("error" in valid) {
    save(current.id,{...draft,reviewed:undefined});
    return respond(`${valid.error}\n${availability}`);
  }
  const appointment = `${current.title} · ${valid.date} ${valid.time} · ${valid.point.name}${valid.point.address===valid.point.name ? "" : `（${valid.point.address}）`}`;
  const review = JSON.stringify([current.id,valid.date,valid.time,valid.point.name,valid.point.address]);
  if (!confirm || draft.reviewed!==review) {
    save(current.id,{...draft,reviewed:review});
    return respond(`请核对报名资料\n${appointment}\n姓名 ${draft.name}，手机尾号 ${draft.phone.slice(-4)}。\n确认后回复「确认报名」。`);
  }
  if (input.preview) {
    save(current.id,{});
    return respond(`模拟登记成功。\n${appointment}`);
  }
  const conversation = db.prepare(`SELECT id FROM agent_conversations
    WHERE device_code=? AND external_conversation_id=? AND COALESCE(takeover,0)=0 ORDER BY id LIMIT 2`)
    .all(input.device,input.session) as {id:number}[];
  const members = /^S:([^_]+)_([^_]+)$/.exec(input.session);
  if (!input.account || !members || !members.slice(1).includes(input.account) || members[1]===members[2] || conversation.length !== 1) {
    return respond("当前企微单聊尚未同步到招聘后台，请稍后回复「确认报名」重试或联系招聘员。");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO agent_archive(session_key,position_id,name,phone,city,interview_date,
      interview_time,interview_confirmed,updated_at,dify_device_code,dify_conversation_row_id,
      dify_external_session,dify_account_id,interview_point,interview_address)
      VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,?,?,?,?,?,?) ON CONFLICT(session_key) DO NOTHING`)
      .run(archiveKey,current.id,draft.name,draft.phone,current.city,valid.date,valid.time,
        input.device,conversation[0].id,input.session,input.account,valid.point.name,valid.point.address);
    save(current.id,{});
    queueDifyGroupNotification(db, input.device, archiveKey, current);
    db.exec("COMMIT");
  } catch(error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return respond(`已登记面试。\n${appointment}`);
}

import type { DatabaseSync } from "node:sqlite";
import { parseDeviceData, parseFactoryIds } from "../../shared/device-factories.js";
import { difyContext, difyContextConflict } from "./dify-context.js";
import { queueDifyGroupNotification } from "./dify-group-notification.js";
import { bookableInterviewPoints, describeInterviewPoint, interviewDate, interviewSchedule, scheduleForPoint, validateInterview } from "./dify-interview.js";
import { invitationStage, setInvitationStage } from "./dify-invitation.js";
import { invitationMedia, type DifyMessage } from "./dify-material-reply.js";
import { queueInterviewReminder, stopInterviewReminder } from "./dify-interview-reminder.js";

type Job = { id:number; title:string; city:string; district:string; factory:string; districts:string[] };
type Draft = { name?:string; phone?:string; date?:string; time?:string; point?:string; reviewed?:string };
type State = { position_id:number|null; draft_json:string; updated_at:string };
type Booking = { position_id:number; position_name:string|null; interview_date:string; interview_time:string; interview_point:string; interview_address:string };
const cityLabel = (name: string) => name.trim().replace(/市$/, "");
const labelledField = /(?:姓名|名字|电话|手机号|日期|时间|面试点)\s*[:：]/;
const phonePattern = /^1[3-9]\d{9}$/;

function naturalContact(query: string, previous: Draft): Draft | undefined {
  const pair = /^(?:我叫\s*)?([\p{Script=Han}·]{2,8})[\s，,、]*?(?:手机(?:号)?|电话)?[\s：:，,]*?(1[3-9]\d{9})$/u.exec(query)
    ?? /^(1[3-9]\d{9})\s+(?:我叫\s*)?([\p{Script=Han}·]{2,8})$/u.exec(query);
  if (pair) return phonePattern.test(pair[1]) ? {name:pair[2],phone:pair[1]} : {name:pair[1],phone:pair[2]};
  if (previous.name) return;
  const named = /^我叫\s*([\p{Script=Han}·]{2,8})$/u.exec(query);
  if (named) return {name:named[1]};
  if (!previous.date || !previous.time || /可以|没问题|好的|谢谢|不用|算了|再说|等等|不要|不去|没时间|面试|没空|晚点|改约|看看|考虑|明天|后天|收到|行吧|行的|明白|太远|哪[里儿]|如何|几点|便宜|工资|班次/.test(query)) return;
  if (/^[\p{Script=Han}·]{2,4}$/u.test(query)) return {name:query};
}

function naturalAppointment(query: string, previousDate: string | undefined) {
  const choice = query.replace(/^(?:(?:我)?(?:可以|想约|想|能不能|能|就|约|定|选|那就))\s*/, "")
    .replace(/\s*(?:去|来)?(?:面试)?(?:行|可以|方便|吧|怎么样|吗)*[？?]?$/, "").trim();
  const datePart = /^(?:今天|明天|后天|(?:本|下)?(?:周|星期)[日一二三四五六天]|\d{1,2}月\d{1,2}[日号]|\d{4}-\d\d-\d\d)/.exec(choice)?.[0];
  if (!datePart && !previousDate) return;
  const tail = choice.slice(datePart?.length ?? 0).replace(/^的/, "").trim();
  const clock = /^(?:(上午|下午|晚上)\s*)?(\d{1,2}|[一二两三四五六七八九十]{1,3})(?:点(半)?|[:：](\d\d))$/.exec(tail);
  if (!clock && (!datePart || !/^(?:上午|下午|晚上)?$/.test(tail))) return;
  let date = datePart ? interviewDate(datePart) : previousDate || "";
  const weekday = datePart && /^(本|下)?(?:周|星期)([日一二三四五六天])$/.exec(datePart);
  if (weekday) {
    const today = new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"});
    const stamp = Date.parse(`${today}T00:00:00Z`);
    const day = "日一二三四五六".indexOf(weekday[2].replace("天","日"));
    const mondayIndex = (new Date(stamp).getUTCDay()+6)%7;
    const difference = (day+6)%7 - mondayIndex;
    const offset = weekday[1] === "下" ? difference+7 : weekday[1] === "本" ? difference : (difference+7)%7;
    date = interviewDate(new Date(stamp+offset*86_400_000).toISOString().slice(0,10));
  }
  if (!clock) return {date,time:""};
  const digit = (value:string) => "零一二三四五六七八九".indexOf(value.replace("两","二"));
  const [left,right] = clock[2].split("十");
  let hour = /^\d/.test(clock[2]) ? Number(clock[2]) : right === undefined ? digit(left) : (left ? digit(left) : 1)*10+(right ? digit(right) : 0);
  if ((clock[1] === "下午" || clock[1] === "晚上") && hour < 12) hour += 12;
  const minute = clock[4] ?? (clock[3] ? "30" : "00");
  return {date,time:hour >= 0 && hour < 24 && Number(minute)<60 ? `${String(hour).padStart(2,"0")}:${minute}` : ""};
}

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
  preview:boolean; canWrite:boolean; ordered?:boolean;
}):{positionId:number;message?:string;selected?:boolean;followups?:DifyMessage[]} {
  const archiveKey = `dify:${input.identity}`;
  const state = db.prepare("SELECT position_id,draft_json,updated_at FROM dify_recruitment_state WHERE identity=?").get(input.identity) as State | undefined;
  const booking = () => db.prepare(`SELECT a.position_id,p.position_name,a.interview_date,a.interview_time,a.interview_point,a.interview_address
    FROM agent_archive a LEFT JOIN service_positions p ON p.id=a.position_id WHERE a.session_key=?`).get(archiveKey) as Booking | undefined;
  const saved = input.preview ? undefined : booking();
  const jobs = jobsForDevice(db,input.device,input.initial,input.preview);
  let current = jobs.find(job => job.id === (saved?.position_id ?? state?.position_id))
    ?? jobs.find(job => job.id === input.initial);
  const respond = (message:string) => ({ message, positionId:current?.id ?? input.initial });
  const query = input.query.normalize("NFKC").trim().replace(/[。！？!?]+$/, "");
  const isChoose = /^(?:选择岗位|换岗|选岗位)(?:\s+|\s*[:：]\s*)(.+)$/.exec(query)
    ?? /^(?:选择岗位|换岗|选岗位)(\d+)$/.exec(query);
  const named = jobs.filter(job => query === job.title || query === `我选${job.title}` || query === `我要选${job.title}`);
  const wantsList = /有什么岗位|有哪些岗位|推荐.{0,8}(?:岗位|工作)|附近.{0,12}(?:岗位|工作)|^换岗$|换个岗位|看其他岗位/.test(query);
  const locationMessage = /^(?:我)?(?:现在)?(?:在|住在).{1,24}(?:区|市|县|镇|街道)$/.test(query);
  const scheduleRequest = /^(?:查看面试安排|可预约时间|面试有哪些时间|可选面试点)$/.test(query);
  const confirm = /^(?:确认报名|确认登记|同意并确认报名)$/.test(query);
  const cancel = /^(?:取消报名|撤销报名)$/.test(query);
  const bookingStatus = /报名(?:成功|好了|结果|状态|了吗)|(?:有|是否)登记|我的面试安排/.test(query);
  const starts = /^(?:我想|我要|帮我|可以)?(?:报名|登记面试|预约面试)(?:$|\s|[：:，,])/.test(query);
  const sendsFields = labelledField.test(query);
  const phoneOnly = phonePattern.test(query);
  const reportsResidence = /^(?:我)?(?:现在|目前)?(?:在|住在).{2,24}$/.test(query)
    && !/想|找|了解|工资|面试|岗位|[，,？?]/.test(query);
  if (input.ordered && !saved && !state?.position_id && reportsResidence && new Set(jobs.map(job=>job.city)).size > 1) {
    return respond("你想在现在这个城市找工作，还是想看看其他城市？可以直接告诉我想去哪座城市。");
  }
  const save = (id:number, data:Draft) => {
    db.prepare(`INSERT INTO dify_recruitment_state(identity,position_id,draft_json) VALUES (?,?,?)
      ON CONFLICT(identity) DO UPDATE SET position_id=excluded.position_id,draft_json=excluded.draft_json,updated_at=CURRENT_TIMESTAMP`)
      .run(input.identity,id,JSON.stringify(data));
  };
  const listJobs = (options: Job[]) => {
    const list = options.slice(0, 8).map(job => `${job.id}．${[job.city,job.district,job.title,job.factory].filter(Boolean).join(" · ")}`);
    return respond(`你可以看看这几个岗位\n${list.join("\n")}\n想了解哪一个？回复「选择岗位」加上编号就行。`);
  };
  const selectedJobReply = (job:Job) => ({message:`已选择${job.title}。想先看看工资、班次，还是面试安排？`,positionId:job.id,selected:true});

  if (isChoose || named.length) {
    const requested = isChoose?.[1].trim();
    const matches = requested
      ? jobs.filter(job => String(job.id) === requested || job.title === requested)
      : named;
    if (matches.length !== 1) return respond("请选择本设备可选范围内的唯一岗位，可回复「选择岗位 编号」。");
    if (saved && saved.position_id !== matches[0].id) return respond("原来的面试还保留着。你想换哪个岗位，可以直接告诉我。");
    if (matches[0].id !== state?.position_id) save(matches[0].id,{});
    return selectedJobReply(matches[0]);
  }
  if (!sendsFields && !bookingStatus && !confirm && !cancel) {
    const cityRows = db.prepare("SELECT city_name FROM cities WHERE tenant_id=1").all() as {city_name:string}[];
    const cityNames = [...new Set(cityRows.map(row => cityLabel(row.city_name)).filter(name => name.length >= 2 && query.includes(name)))];
    if (cityNames.length > 1) return respond(`你想先了解${cityNames.join("还是")}的岗位？`);
    const [requestedCity] = cityNames;
    if (requestedCity) {
      const cityJobs = jobs.filter(job => cityLabel(job.city) === requestedCity);
      if (!cityJobs.length) return respond(`${requestedCity}暂时没有可以推荐的岗位。想看看其他城市的话，可以说「推荐岗位」。`);
      const namedJobs = cityJobs.filter(job => query.includes(job.title));
      const options = namedJobs.length ? namedJobs : matchingJobs(cityJobs, query);
      if (wantsList || options.length !== 1) return listJobs(options);
      const [job] = options;
      if (saved && saved.position_id !== job.id) return respond("原来的面试还保留着。你想换哪个岗位，可以直接告诉我。");
      if (job.id !== state?.position_id) save(job.id,{});
      current = job;
      if (locationMessage || /^(?:我)?(?:要|想|想要)?找.{1,30}(?:的工作|的岗位|安检员|安保|安检)$/.test(query) || query === requestedCity || query === `${requestedCity}市`) {
        return selectedJobReply(job);
      }
    }
  }
  if (wantsList || locationMessage) {
    const options = matchingJobs(jobs,query);
    if (!options.length) return respond("这边暂时没有可以推荐的岗位。");
    return listJobs(options);
  }
  if (saved && (bookingStatus || confirm || starts || sendsFields || phoneOnly)) {
    const savedJob = jobs.find(job => job.id === saved.position_id);
    if (confirm && input.canWrite && input.account && savedJob) {
      queueDifyGroupNotification(db, input.device, archiveKey, savedJob);
    }
    return respond(`已登记${saved.position_name || ""}面试，${saved.interview_date} ${saved.interview_time}，${saved.interview_point}，${saved.interview_address}。`);
  }
  if (saved && (cancel || /^(?:我要|我想)?(?:改约|取消面试|不去面试了|不去了|我不去了)$/.test(query))) {
    if (input.canWrite) stopInterviewReminder(db,archiveKey);
    return respond("你的面试已登记。你想改约还是取消？可以在这里留言。");
  }
  if (saved && input.ordered && /^(?:我)?(?:已经)?到了(?:门口|楼下|面试点)?$/.test(query)) {
    const context = difyContext(db,saved.position_id);
    const point = context?.interview_points.find(point =>
      point.name === saved.interview_point && point.address === saved.interview_address,
    );
    const guide = context && !difyContextConflict(context) && point
      && (point.checkin_guide || (context.interview_points.length === 1 && context.city_materials.checkin_guide));
    if (input.canWrite) stopInterviewReminder(db,archiveKey);
    return respond(guide || "收到，你已经到面试点了。稍等一下。");
  }
  if (!current) return respond("这个岗位暂时无法预约。想看看其他岗位吗？可以说「推荐岗位」。");
  const stage = input.ordered && invitationStage(db,input.identity,current.id);
  const offered = stage === "offered";
  const fresh = state?.position_id===current.id && Date.now()-Date.parse(state.updated_at.replace(" ","T")+"Z") < 86400000;
  const draft = fresh ? parseDeviceData(state.draft_json) as Draft : {};
  const lines = query.split(/\n+/).map(line=>line.trim()).filter(Boolean);
  const beginsAppointment = /^(?:可以(?:啊|的)?|行|好(?:的)?)$/;
  const firstAppointmentLine = lines.length > 1 && beginsAppointment.test(lines[0]) ? 1 : 0;
  const appointmentInput = !saved && (offered || stage === "invited" || stage === "waiting_confirmation")
    ? naturalAppointment(lines[firstAppointmentLine] ?? "",draft.date) : undefined;
  const contactQuery = appointmentInput ? lines.slice(firstAppointmentLine+1).join("\n") : query;
  const contact = (offered || appointmentInput?.time) && !saved ? naturalContact(contactQuery,draft) : undefined;
  const contactPhone = appointmentInput && phonePattern.test(contactQuery) ? contactQuery : "";
  const natural = appointmentInput && (!contactQuery || contact || contactPhone) ? appointmentInput : undefined;
  const point = offered && !sendsFields && !saved ? difyContext(db,current.id)?.interview_points
    .find(point=>point.name === query && point.address)?.name : undefined;
  const timeQuestion = input.ordered && (offered || saved) && /(?:提前|晚一点|迟到|还(?:能|可以)).{0,12}(?:过来|过去|到|面试)|(?:迟到|晚一点|提前).{0,7}(?:可以|行|吗|[？?])/.test(query);
  if (!scheduleRequest && !confirm && !cancel && !starts && !sendsFields && !phoneOnly && !bookingStatus && !natural && !contact && !point && !timeQuestion) return {positionId:current.id};
  if (bookingStatus) return respond("当前会话还没有已确认的面试登记。回复「报名」可以开始。");

  const context = difyContext(db,current.id);
  if (!context || difyContextConflict(context)) return respond("这个岗位的面试安排暂未公布。");
  const schedule = interviewSchedule(db,current.id,context as Record<string,unknown>);
  const defaultTime = schedule.timeText || (schedule.dayLabels.length ? `面试日 ${schedule.dayLabels.join("、")}` : "");
  const hasPointTimes = schedule.points.some(point => point.interview_time);
  const availability = [
    current.title,
    defaultTime && (hasPointTimes ? `未单独设置的面试点沿用 ${defaultTime}` : defaultTime),
    schedule.points.length ? `面试地点 ${schedule.points.map(describeInterviewPoint).join("、")}` : "",
  ].filter(Boolean).join("\n");
  if (timeQuestion) {
    const selected = schedule.points.find(point => point.name === (saved?.interview_point || draft.point));
    const timeText = selected ? scheduleForPoint(schedule, selected).timeText : schedule.timeText;
    const times = hasPointTimes && !selected ? `${availability}\n` : timeText ? `可面试时段是${timeText}。` : "";
    return respond(`${times}${saved ? `你原来约的是${saved.interview_date} ${saved.interview_time}。` : ""}你大概哪天几点能到？`);
  }
  if (scheduleRequest) return respond(availability);
  if (cancel) {
    save(current.id,{});
    return respond("已清除本次待确认的报名资料。");
  }
  if (!input.preview && !input.canWrite) return respond("请在当前企微会话中完成报名确认。");
  if (!bookableInterviewPoints(schedule).length) {
    if (draft.reviewed) save(current.id,{...draft,reviewed:undefined});
    return respond(`${availability}\n这个岗位暂未开放预约。`);
  }
  if (sendsFields) Object.assign(draft,parseDraft(query,draft));
  if(sendsFields || phoneOnly)delete draft.reviewed;
  if(phoneOnly)draft.phone=query;
  if (contactPhone) draft.phone = contactPhone;
  if (natural) {
    draft.date = natural.date;
    draft.time = natural.time;
    delete draft.reviewed;
    if (!offered && natural.date) setInvitationStage(db,input.identity,current.id,"offered");
  }
  if (contact) {
    Object.assign(draft,contact);
    delete draft.reviewed;
  }
  if (point) {
    draft.point = point;
    delete draft.reviewed;
  }
  if (!draft.point && schedule.points.length === 1) draft.point=schedule.points[0].name;
  save(current.id,draft);
  const valid = draft.date && draft.time && draft.point ? validateInterview(db,current.id,schedule,draft.date,draft.time,draft.point) : undefined;
  if ((offered || natural) && valid && "error" in valid) return respond(`${valid.error}\n${availability}`);
  if (!draft.name || !draft.phone || !valid) {
    if (offered || natural) {
      if (!draft.date || !draft.time) {
        const selected = schedule.points.find(point => point.name === draft.point);
        const times = selected ? scheduleForPoint(schedule, selected).timeText : schedule.timeText;
        return respond(!draft.date || (hasPointTimes && !selected) ? `${availability}\n想约哪天几点？`
          : `你想约${draft.date}几点？${times ? `可面试时段是${times}。` : ""}`);
      }
      if (!draft.point) return respond(`你想去哪个面试点？\n${availability}`);
      const missing = [!draft.name && "姓名",!draft.phone && "手机号"].filter(Boolean).join("和");
      return respond(`可以把${missing}发我吗？我这边帮你登记面试。`);
    }
    return respond(`${availability}\n请发「姓名：张三 电话：手机号 日期：YYYY-MM-DD 时间：HH:mm 面试点：名称」。用于安排本次面试，核对后回复「确认报名」。`);
  }
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
    return respond("这次报名还没提交成功，稍等一下再回复「确认报名」。");
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
    if (offered) queueInterviewReminder(db,{archiveKey,deviceCode:input.device,date:valid.date,time:valid.time,address:valid.point.address});
    db.exec("COMMIT");
  } catch(error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!offered) return respond(`已登记面试。\n${appointment}`);
  const address = valid.point.address;
  const map = new URL("https://uri.amap.com/search");
  map.searchParams.set("keyword",address.split(/[。\r\n]/,1)[0].trim() || address);
  if (current.city) map.searchParams.set("city",current.city);
  map.searchParams.set("callnative","0");
  return {...respond(`面试已登记\n${current.title}\n时间 ${valid.date} ${valid.time}\n地点 ${valid.point.name}${address===valid.point.name ? "" : `（${address}）`}`),
    followups:[{type:"text",content:`高德地图搜索：${map}`},
      ...(schedule.points.length === 1 ? invitationMedia(db,context,"interview","image") : []),
      {type:"text",content:"到了给我发个消息。"}]};
}

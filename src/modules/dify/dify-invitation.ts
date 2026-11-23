import type { DatabaseSync } from "node:sqlite";
import { difyContext, difyContextConflict } from "./dify-context.js";
import { bookableInterviewPoints, describeInterviewPoint, interviewSchedule } from "./dify-interview.js";
import { invitationMedia, type DifyMessage } from "./dify-material-reply.js";

const text = (content: string): DifyMessage => ({type:"text",content:content.replace(/[【】]/g, c => c === "【" ? "〔" : "〕").slice(0,4000)});
type Stage = "invited" | "offered" | "declined" | "waiting_confirmation";

export function invitationStage(db: DatabaseSync, identity: string, positionId: number): Stage | undefined {
  return (db.prepare("SELECT stage FROM dify_invitation_state WHERE identity=? AND position_id=?")
    .get(identity,positionId) as {stage:Stage} | undefined)?.stage;
}

export function setInvitationStage(db: DatabaseSync, identity: string, positionId: number, stage: Stage) {
  db.prepare(`INSERT INTO dify_invitation_state(identity,position_id,stage) VALUES (?,?,?)
    ON CONFLICT(identity) DO UPDATE SET position_id=excluded.position_id,stage=excluded.stage`).run(identity,positionId,stage);
}

export function noteInvitationQuestion(db: DatabaseSync, identity: string, positionId: number, query: string) {
  if (invitationStage(db,identity,positionId) === "invited" && /[?？]|吗(?:[。！!\s]|$)|怎么|如何|几号|能不能|好不好|但我|但只能/.test(query)) {
    setInvitationStage(db,identity,positionId,"waiting_confirmation");
  }
}

export function invitationTurn(db: DatabaseSync, input: {
  identity: string; positionId: number; query: string; selected?: boolean;
}): DifyMessage[] | undefined {
  const {identity,positionId,selected} = input;
  const query = input.query.normalize("NFKC").trim().replace(/[。！!]+$/g, "");
  const context = difyContext(db,positionId);
  if (!context || difyContextConflict(context)) return;
  const city = context.city.replace(/市$/, "");
  if (!["广州","南昌"].includes(city) || !/地铁|轨道|城际|安检|安保/.test(context.job_title)) return;
  const schedule = interviewSchedule(db,positionId,context,true);
  const available = bookableInterviewPoints(schedule);
  if (!context.wage_text || !context.hours_text || !available.length) return;
  const stage = invitationStage(db,identity,positionId);
  const postpones = /不一定|还没确定|还不确定|(?:晚点|回头|确定后|确认后)(?:再|给你|联系)|如果.+(?:再来|再去|再联系|面试|过去)|等.+(?:再|才知道)/.test(query);
  if (stage && stage !== "declined" && postpones && !/[?？]|吗$/.test(query)) {
    setInvitationStage(db,identity,positionId,"waiting_confirmation");
    return [text("行，你确定哪天方便了再跟我说，到时看看哪个时段合适。")];
  }
  const appointmentIntent = /^(?:(?:可以|好的|行)[，,\s]*)?(?:(?:我)?(?:想|要|准备|愿意|确定|能|可以)(?:去|来)?面试|(?:可以|能)(?:去|来)?看看)$/.test(query);
  const accepts = stage === "invited" && /^(?:可以(?:接受)?|能接受|好(?:的|啊|呀|呀可以)?|行(?:的)?|没问题|有兴趣)(?:[，,\s]*(?:我)?(?:想|要|可以)(?:去|来)?面试)?$/.test(query);
  if ((stage === "invited" && accepts) || (stage !== "offered" && appointmentIntent)) {
    setInvitationStage(db,identity,positionId,"offered");
    if (available.some(point => point.interview_time)) {
      const points = available.map(point => describeInterviewPoint({
        ...point, interview_time: point.interview_time || schedule.timeText,
      }));
      return [text(`可以预约的面试点\n${points.join("\n")}`), text("你想去哪个面试点，约哪天几点？")];
    }
    const addresses = available.map(point => point.name === point.address
      ? point.address : `${point.name}（${point.address}）`);
    const times = [schedule.dayLabels.join("、"),schedule.timeText].filter(Boolean).join("，");
    return [text(`面试地点在${addresses.join("、")}。`), text(`${times}可以面试，你哪天方便，想约几点？`)];
  }
  if (stage && stage !== "declined" && /^(?:我)?(?:接受不了|不接受|不考虑了|先不面试|暂时不考虑|暂时不去|不去(?:了)?|再考虑一下)$/.test(query)) {
    setInvitationStage(db,identity,positionId,"declined");
    return [text("好，有想了解的再跟我说。")];
  }
  if ((stage === "waiting_confirmation" || stage === "declined") && /^(?:好(?:的|啊|呀)?|行(?:的)?|嗯+|收到|谢谢|可以)$/.test(query)) {
    return [text("好，有需要随时跟我说。")];
  }
  if (!selected && !stage && /^(?:(?:你好[，,\s]*)?(?:你好|在吗[？?]?|想找工作|我想找工作|找工作|还招人吗[？?]?|想看看岗位)|(?:我)?(?:现在|目前)?(?:在|住在).{2,24})$/.test(query)) {
    return [text("你好，请问你想在哪个城市找工作？")];
  }
  if (!selected || stage) return;
  const role = [context.job_title,context.job_content].filter(Boolean).join("\n");
  const benefits = [context.hours_text,context.wage_text,context.welfare_text].filter(Boolean).join("\n");
  const messages = city === "南昌"
    ? [text([`${context.job_title}招聘信息`,benefits,context.place && `工作地点 ${context.place}`].filter(Boolean).join("\n")),
      ...invitationMedia(db,context,"food","video"), ...invitationMedia(db,context,"dorm","image"),
      ...(context.job_content ? [text(context.job_content)] : [])]
    : [text(role),text(benefits),...invitationMedia(db,context,"work","video")];
  setInvitationStage(db,identity,positionId,"invited");
  return [...messages,text("这个岗位的安排你能接受吗？方便的话，可以约个时间来面试。")];
}

function configuredDelay(key: string, fallback: number) {
  const raw = process.env[key]?.trim();
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 && value <= 30_000 ? value : fallback;
}

export function difySendDelays(messages: DifyMessage[]) {
  const interval = configuredDelay("REA_DIFY_SEND_INTERVAL_MS", 4000);
  const afterMedia = configuredDelay("REA_DIFY_AFTER_MEDIA_MS", 7000);
  return messages.map((_,index) => index === 0 ? 0 : messages[index-1].type === "text" ? interval : afterMedia);
}

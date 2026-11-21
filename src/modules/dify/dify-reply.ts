import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { difyContext, difyContextConflict, difyInput } from "./dify-context.js";
import { configuredMaterialReply } from "./dify-material-reply.js";
import { DeviceBridgeStore } from "../messaging/device-bridge.js";
import { devicePositionId } from "../../shared/device-factories.js";
import { canAccessCity, getUserScope } from "../../auth/user-scopes.js";
import { beginReplyMode, replyModePending, replyModeRow, replyModeView } from "./reply-mode-transition.js";
import { recruitmentPositionAvailable, recruitmentTurn, selectedRecruitmentPosition } from "./dify-recruitment.js";

const object = (raw: string): Record<string, unknown> => {
  try { const data = JSON.parse(raw); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; }
  catch { return {}; }
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = (code: string, error: string) => ({ ok: false as const, provider: "dify", code, error });
function config() {
  let key = process.env.REA_DIFY_API_KEY?.trim() || "";
  if (!key && process.env.REA_DIFY_API_KEY_FILE) {
    try { key = readFileSync(process.env.REA_DIFY_API_KEY_FILE, "utf8").trim(); } catch { /* unconfigured */ }
  }
  return { base: (process.env.REA_DIFY_BASE_URL || "").trim().replace(/\/+$/, ""), key };
}
export function deviceReplyProvider(db: DatabaseSync, code: string): "agent" | "dify" {
  const row = db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(code) as {data_json: string} | undefined;
  return row && object(row.data_json).reply_provider === "dify" ? "dify" : "agent";
}
export function ownsReplyDevice(db: DatabaseSync, request: FastifyRequest, code: string): boolean {
  if (request.auth?.role === "admin") return true;
  return hasDifyDeviceToken(db,request,code);
}
export function hasDifyDeviceToken(db: DatabaseSync, request: FastifyRequest, code: string): boolean {
  const token = (request.headers.authorization || "").replace(/^Bearer /, "").trim();
  const row = db.prepare("SELECT b.device_code FROM bridge_devices b JOIN agent_devices a ON json_extract(a.data_json,'$.device_code')=b.device_code WHERE b.token_hash=? AND a.status='enabled'").get(digest(token)) as {device_code:string} | undefined;
  return Boolean(token && row?.device_code === code);
}
export function registerReplyProviderRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.put<{Params:{id:string};Body:Record<string,unknown>}>("/api/v1/dify/cities/:id/materials",async(req,reply)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0)return reply.code(422).send({detail:"Invalid city id"});
    if(!canAccessCity(getUserScope(db,req.auth!),id))return reply.code(403).send({detail:"City scope required"});
    const row=db.prepare('SELECT * FROM cities WHERE id=?').get(id) as {data_json:string}|undefined;
    if(!row)return reply.code(404).send({detail:"城市不存在"});
    const next=object(row.data_json||'{}'),body=req.body||{};
    if('knowledge_vertical_id' in body){
      const value=body.knowledge_vertical_id;
      if(value!==null&&(!Number.isSafeInteger(value)||Number(value)<=0||!db.prepare("SELECT 1 FROM vertical WHERE id=? AND tenant_id=1 AND status='enabled'").get(Number(value))))return reply.code(422).send({detail:'请选择有效且启用的知识品类，或留空'});
      next.knowledge_vertical_id=value;
    }
    for(const key of ['salary','work_hours','requirements','interview','prompt_sections','prompt_section_labels']){
      if(!(key in body))continue;
      if(!body[key]||typeof body[key]!=='object'||Array.isArray(body[key]))return reply.code(422).send({detail:`${key} must be an object`});
      if(JSON.stringify(body[key]).length>100000)return reply.code(422).send({detail:`${key} is too large`});
      if(key.startsWith('prompt_')&&Object.values(body[key] as Record<string,unknown>).some(v=>typeof v!=='string'))return reply.code(422).send({detail:`${key} values must be text`});
      next[key]={...(next[key]&&typeof next[key]==='object'?next[key] as Record<string,unknown>:{}),...body[key] as Record<string,unknown>};
    }
    if('social_insurances' in body){if(typeof body.social_insurances!=='string')return reply.code(422).send({detail:'social_insurances must be text'});next.social_insurances=body.social_insurances;}
    db.exec('BEGIN IMMEDIATE');
    try{db.prepare('INSERT INTO city_history(city_id,snapshot_json) VALUES (?,?)').run(id,JSON.stringify(row));db.prepare('UPDATE cities SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(next),id);db.exec('COMMIT');}
    catch(e){db.exec('ROLLBACK');throw e;}
    return {ok:true,city_id:id};
  });
  app.post<{Body:{position_id?:unknown;text?:unknown;session_key?:unknown;dry?:unknown}}>("/api/v1/dify/preview",async(req,reply)=>{
    if(req.auth?.role!=="admin")return reply.code(403).send({detail:"Admin access required"});
    const positionId=Number(req.body?.position_id),input=typeof req.body?.text==='string'?req.body.text.trim():'';
    if(!Number.isSafeInteger(positionId)||positionId<=0||!input||input.length>2000)return reply.code(422).send({detail:"position_id and text (max 2000) required"});
    const session=typeof req.body.session_key==='string'?req.body.session_key.trim():'';
    if((req.body.dry!==true||session)&&!/^dify-preview:[A-Za-z0-9-]{1,80}$/.test(session))return reply.code(422).send({detail:"preview session_key must start with dify-preview:"});
    return generateDifyReply(db,{deviceCode:`preview-admin-${req.auth.id}`,positionId,sessionKey:session,text:input,dry:req.body.dry===true,preview:true});
  });
  const store = new DeviceBridgeStore(db);
  const currentMode = (code: string) => replyModeView(db, code, deviceReplyProvider(db, code));
  const deviceRow = (code: string) => db.prepare(
    "SELECT id,data_json,status FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?",
  ).get(code) as { id: number; data_json: string; status: string } | undefined;

  app.get<{Params:{code:string}}>("/api/v1/agent/devices/:code/reply-mode", async (req, reply) => {
    if (req.auth?.role !== "admin") return reply.code(403).send({ detail: "需要管理员权限" });
    if (!deviceRow(req.params.code)) return reply.code(404).send({ detail: "设备不存在" });
    return currentMode(req.params.code);
  });

  app.post<{Params:{code:string}; Body:{provider?:unknown; cancel?:unknown; id?:unknown}}>("/api/v1/agent/devices/:code/reply-mode", async (req, reply) => {
    if (req.auth?.role !== "admin") return reply.code(403).send({ detail: "需要管理员权限" });
    const code = req.params.code;
    const device = deviceRow(code);
    if (!device) return reply.code(404).send({ detail: "设备不存在" });
    if (device.status !== "enabled") return reply.code(409).send({ detail: "请先启用该设备" });
    const row = replyModeRow(db, code);
    if (!row) return reply.code(409).send({ detail: "请更新 Windows 客户端并等待它上报" });
    if (req.body?.cancel === true) {
      if (row.rollback && row.parent_id === req.body.id) return currentMode(code);
      if (row.id !== req.body.id) return reply.code(409).send({ detail: "状态已变化，请刷新后重试" });
      if (row.rollback || row.phase === "cancelled") return currentMode(code);
      if (!replyModePending(db, code)) return reply.code(409).send({ detail: "此切换已完成，请发起反向切换" });
      // Even a lost prepare response may mean the client has already paused.
      // A new ID fences off delayed acknowledgments from the cancelled request.
      beginReplyMode(db, code, row.effective, true);
      return currentMode(code);
    }
    if (!row.client_at) return reply.code(409).send({ detail: "请等待当前配对的 Windows 客户端上报" });
    const provider = req.body?.provider;
    if (provider !== "agent" && provider !== "dify") return reply.code(422).send({ detail: "请选择有效的回复来源" });
    if (replyModePending(db, code)) {
      if (row.target === provider) return currentMode(code);
      return reply.code(409).send({ detail: "已有切换正在进行，请等待或撤回" });
    }
    if (req.body.id !== undefined && req.body.id !== row.id) return reply.code(409).send({ detail: "状态已变化，请刷新后重试" });
    if (provider === row.effective) return currentMode(code);
    if (provider === "dify") {
      const cfg = config();
      if (!cfg.key || !validBase(cfg.base)) return reply.code(409).send({ detail: "Dify 尚未完成连接配置" });
    }
    if (!devicePositionId(db, code)) return reply.code(409).send({ detail: "请先给设备绑定接待岗位" });
    beginReplyMode(db, code, provider, false);
    return currentMode(code);
  });

  app.post<{Params:{code:string}; Body:{id?:unknown;step?:unknown;provider?:unknown;wecom_online?:unknown;desktop_active?:unknown;issue?:unknown;ready_id?:unknown;ready_provider?:unknown}}>("/api/v1/bridge/devices/:code/reply-mode", async (req, reply) => {
    const code = req.params.code;
    if (!hasDifyDeviceToken(db, req, code)) return reply.code(403).send({ detail: "设备鉴权失败" });
    const device = deviceRow(code);
    if (!device || device.status !== "enabled") return reply.code(403).send({ detail: "设备已停用" });
    const body = req.body || {};
    const now = Date.now();
    const provider = deviceReplyProvider(db, code);
    db.prepare("INSERT INTO reply_mode_transition(device_code,effective,target,updated_at,client_at) VALUES (?,?,?,?,?) ON CONFLICT(device_code) DO UPDATE SET client_at=excluded.client_at")
      .run(code, provider, provider, now, now);
    const row = replyModeRow(db, code)!;
    if ((body.step || body.issue) && body.id !== row.id) return reply.code(409).send({ detail: "切换编号已变化" });
    if (!replyModePending(db, code)) {
      if (body.step && (body.step !== "applied" || body.provider !== row.effective)) {
        return reply.code(409).send({ detail: "此切换已结束" });
      }
      db.prepare("UPDATE reply_mode_transition SET client_ready=? WHERE device_code=?")
        .run(Number(body.desktop_active !== false && body.wecom_online === true && ((body.step === "applied" && body.provider === row.effective)
          || (body.ready_id === row.id && body.ready_provider === row.effective))), code);
      return currentMode(code);
    }
    if (body.desktop_active === false || body.wecom_online !== true) {
      db.prepare("UPDATE reply_mode_transition SET issue=? WHERE device_code=?").run(body.desktop_active === false ? "desktop" : "wechat", code);
      return currentMode(code);
    }
    const allowedIssues = ["configuration", "local_state", "desktop"];
    if (typeof body.issue === "string" && allowedIssues.includes(body.issue)) {
      db.prepare("UPDATE reply_mode_transition SET issue=? WHERE device_code=?").run(body.issue, code);
      return currentMode(code);
    }
    if (!body.step) {
      if (row.issue === "wechat" || row.issue === "desktop") {
        db.prepare("UPDATE reply_mode_transition SET issue='' WHERE device_code=?").run(code);
      }
      return currentMode(code);
    }
    if (body.step === "prepared") {
      if (row.phase === "applying") return currentMode(code);
      store.expireClaims(code);
      if (db.prepare("SELECT 1 FROM bridge_commands WHERE device_code=? AND status='claimed' LIMIT 1").get(code)) {
        db.prepare("UPDATE reply_mode_transition SET issue='receipt' WHERE device_code=?").run(code);
        return currentMode(code);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(JSON.stringify({ ...object(device.data_json), reply_provider: row.target }), device.id);
        db.prepare("UPDATE reply_mode_transition SET phase='applying',issue='',updated_at=? WHERE device_code=?").run(now, code);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return currentMode(code);
    }
    if (body.step !== "applied" || row.phase !== "applying" || body.provider !== row.target) {
      return reply.code(409).send({ detail: "客户端回报与当前切换不符" });
    }
    db.prepare("UPDATE reply_mode_transition SET phase=?,effective=target,generation=CASE WHEN rollback=1 THEN generation ELSE id END,issue='',updated_at=?,client_ready=1 WHERE device_code=?")
      .run(row.rollback ? "cancelled" : "completed", now, code);
    return currentMode(code);
  });

  for (const method of ["get", "put"] as const) {
    app[method]<{Params:{code:string};Body:{provider?:unknown;fresh_client_state_confirmed?:unknown}}>("/api/v1/agent/devices/:code/reply-provider", async (req, reply) => {
      if (req.auth?.role !== "admin") return reply.code(403).send({detail:"Admin access required"});
      const row = db.prepare("SELECT id,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(req.params.code) as {id:number;data_json:string} | undefined;
      if (!row) return reply.code(404).send({detail:"设备不存在"});
      if (method === "put") {
        if (replyModeRow(db, req.params.code)) return reply.code(409).send({ detail: "请使用微信账号中的回复来源切换" });
        if (!["agent","dify"].includes(String(req.body?.provider))) return reply.code(422).send({detail:"provider must be agent or dify"});
        if (req.body.provider !== deviceReplyProvider(db,req.params.code) && new DeviceBridgeStore(db).status(req.params.code)?.state === "online") {
          return reply.code(409).send({detail:"请先停止该设备客户端并等待离线，切换来源后重新启动，以清除开场缓存"});
        }
        if (req.body.provider === "dify" && deviceReplyProvider(db,req.params.code) !== "dify" && db.prepare("SELECT 1 FROM agent_conversation_state WHERE device_code=? LIMIT 1").get(req.params.code)) {
          return reply.code(409).send({detail:"该设备有旧节点流程镜像，需先核对云端本地流程快照；请先使用全新测试设备，不能直接切换存量会话"});
        }
        if (req.body.provider === "dify" && deviceReplyProvider(db,req.params.code) !== "dify" && req.body.fresh_client_state_confirmed !== true) {
          return reply.code(409).send({detail:"必须先核对专用客户端使用独立且无旧流程快照的状态目录；仅换设备码不够"});
        }
        db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify({...object(row.data_json),reply_provider:req.body.provider}),row.id);
      }
      const cfg=config();
      return {provider:deviceReplyProvider(db,req.params.code),configured:Boolean(cfg.base&&cfg.key),requires_client_restart:true};
    });
  }
}
function validBase(base: string): boolean {
  try {
    const u=new URL(base), h=u.hostname;
    const octets=h.split('.').map(Number);
    const ipv4=octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
    const privateHost=h==='localhost'||h==='[::1]'||ipv4&&(octets[0]===127||octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31);
    return !u.username&&!u.password&&!u.search&&!u.hash && (u.protocol==="https:" || u.protocol==="http:" && privateHost);
  } catch {return false;}
}
const queues=new Map<string,Promise<unknown>>();
export async function generateDifyReply(db: DatabaseSync, input:{deviceCode:string;positionId:number;sessionKey:string;text:string;dry?:boolean;preview?:boolean;canWriteRegistration?:boolean}) {
  const account=db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(input.deviceCode) as {account_id:string} | undefined;
  const cfg=config();
  const scope=digest(JSON.stringify([input.deviceCode,account?.account_id||"",input.sessionKey]));
  const previous=queues.get(scope)||Promise.resolve();
  const pending=previous.catch(()=>{}).then(()=>run());queues.set(scope,pending);
  try {return await pending;} finally {if(queues.get(scope)===pending)queues.delete(scope);}
  async function run() {
    const blocked=()=>{
      if(input.preview)return false;
      if(replyModePending(db, input.deviceCode))return true;
      const dev=db.prepare("SELECT status,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(input.deviceCode) as {status:string;data_json:string}|undefined;
      if (!dev || dev.status!=="enabled" || devicePositionId(db,input.deviceCode)!==input.positionId || deviceReplyProvider(db,input.deviceCode)!=="dify") return true;
      const conv=db.prepare("SELECT takeover FROM agent_conversations WHERE device_code=? AND external_conversation_id=?").get(input.deviceCode,input.sessionKey) as {takeover:number}|undefined;
      const nowAccount=db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(input.deviceCode) as {account_id:string}|undefined;
      return Boolean(conv?.takeover || nowAccount?.account_id!==account?.account_id);
    };
    if(blocked()) return failure("human_takeover","设备停用、已切换账号或会话已接管");
    if(!input.dry&&!input.sessionKey)return failure("dify_session_required","Dify 模式需要 session_key");
    let positionId=input.positionId;
    if(input.dry&&input.sessionKey){
      positionId=selectedRecruitmentPosition(db,scope,input.positionId);
      if(!recruitmentPositionAvailable(db,input.deviceCode,input.positionId,positionId,input.preview===true))return failure("dify_position_unavailable","岗位不可用");
    }
    if(!input.dry){
      try{
        const action=recruitmentTurn(db,{identity:scope,device:input.deviceCode,account:account?.account_id||"",session:input.sessionKey,
          initial:input.positionId,query:input.text,preview:input.preview===true,canWrite:input.canWriteRegistration===true});
        positionId=action.positionId;
        if(action.message)return {ok:true,provider:"dify",model:"Dify 招聘流程",session_key:input.sessionKey,
          reply:{messages:[{type:"text",content:action.message.replace(/[【】]/g,c=>c==="【"?"〔":"〕").slice(0,4000)}]},latency_ms:0};
      }catch{
        return failure("dify_registration_error","招聘系统暂未保存本轮操作，请稍后重试或联系招聘员。");
      }
    }
    const facts=difyContext(db,positionId);
    if(!facts)return failure("dify_position_unavailable","岗位不可用");
    const conflict=difyContextConflict(facts);
    if(conflict)return failure('dify_context_conflict',conflict);
    if (!input.dry) {
      const messages=configuredMaterialReply(db,positionId,input.text,facts);
      if (messages) {
        return {ok:true,provider:"dify",model:"Dify 招聘流程",session_key:input.sessionKey,
          reply:{messages},latency_ms:0};
      }
    }
    const selected=difyInput(facts,input.text);
    if(!selected)return failure('dify_context_too_large','城市关键字段过长，请精简薪资、时间或面试地点；完整话术请放入原文段落或知识库');
    // Keep the published Dify conversation per application and selected position.
    const identity=digest(JSON.stringify([input.deviceCode,account?.account_id||"",input.sessionKey,positionId,cfg.base,digest(cfg.key)]));
    const payload={inputs:{position_data:JSON.stringify(selected),current_time:new Date().toLocaleString("sv-SE",{timeZone:"Asia/Shanghai"})},query:input.text,response_mode:"blocking",user:`recruit-${identity}`};
    if(input.dry)return {ok:true,provider:"dify",dry:true,position_id:positionId,inputs:payload.inputs};
    if(!input.sessionKey)return failure("dify_session_required","Dify 模式需要 session_key");
    if(!cfg.key||!validBase(cfg.base))return failure("dify_not_configured","Dify 服务端地址或应用密钥未配置");
    const started=Date.now();let errorCode="";
    try {
      const stored=db.prepare("SELECT conversation_id FROM dify_reply_sessions WHERE identity=?").get(identity) as {conversation_id:string}|undefined;
      const response=await fetch(`${cfg.base}/chat-messages`,{method:"POST",redirect:"error",headers:{authorization:`Bearer ${cfg.key}`,"content-type":"application/json"},body:JSON.stringify({...payload,...(stored?{conversation_id:stored.conversation_id}:{})}),signal:AbortSignal.timeout(35_000)});
      if(!response.ok)throw new Error("dify_http_error");
      const body=await response.json() as {answer?:unknown;conversation_id?:unknown};
      if(typeof body.conversation_id!=="string"||!body.conversation_id)throw new Error("dify_invalid_response");
      // Persist provider conversation even if its reply needs manual review, to avoid silently restarting.
      db.prepare("INSERT INTO dify_reply_sessions(identity,device_code,conversation_id) VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET conversation_id=excluded.conversation_id,updated_at=CURRENT_TIMESTAMP").run(identity,input.deviceCode,body.conversation_id);
      const answer=typeof body.answer==="string"?body.answer.trim():"";
      if(!answer||answer.length>12000||/##[^#\n]+##|https?:\/\/|图片[（(]|文件[（(]|【\s*(?:图片|视频|文件)\s*[:：]/i.test(answer))throw new Error("dify_invalid_reply");
      const amounts=(value:string)=>[...value.matchAll(/(\d+(?:\.\d+)?)(?:\s*[-~～–—到至]\s*(\d+(?:\.\d+)?))?\s*(?:(?:元|块)(?:\s*[/每]\s*(小时|时|天|班次?|月|晚))?|[/每]\s*(小时|时|天|班次?|月|晚))/g)].flatMap(m=>{
        const units:Record<string,string>={小时:'hour',时:'hour',天:'day',班:'shift',班次:'shift',月:'month',晚:'night'};
        const unit=units[m[3]||m[4]]||'currency';return [m[1],m[2]].filter(Boolean).map(n=>`${Number(n)}:${unit}`);
      });
      const knownAmounts=new Set(amounts(JSON.stringify(selected)));
      if(amounts(answer).some(amount=>!knownAmounts.has(amount)))throw new Error("dify_fact_mismatch");
      if(blocked())throw new Error("human_takeover");
      if(!recruitmentPositionAvailable(db,input.deviceCode,input.positionId,positionId,input.preview===true))throw new Error("dify_position_changed");
      if (JSON.stringify(difyContext(db,positionId)) !== JSON.stringify(facts)) throw new Error("dify_position_changed");
      const messages=answer.split("###").map(s=>s.trim()).filter(Boolean).map(content=>({type:"text",content}));
      if(!messages.length)throw new Error("dify_invalid_reply");
      return {ok:true,provider:"dify",model:"Dify Chatflow",session_key:input.sessionKey,reply:{messages},latency_ms:Date.now()-started};
    } catch(e) {
      const code=e instanceof Error?e.message:"";
      errorCode=["dify_http_error","dify_invalid_response","dify_invalid_reply","dify_fact_mismatch","dify_position_changed","human_takeover"].includes(code)?code:"dify_unavailable";
      return failure(errorCode,"Dify 回复暂停，请在调试台或会话日志中检查");
    } finally {
      db.prepare("INSERT INTO dify_reply_calls(id,device_code,position_id,status,error_code,latency_ms) VALUES (?,?,?,?,?,?)").run(randomUUID(),input.deviceCode,positionId,errorCode?"failed":"generated",errorCode,Date.now()-started);
    }
  }
}

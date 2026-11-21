import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { difyContext, difyInput } from "./dify-context.js";
import { DeviceBridgeStore } from "../messaging/device-bridge.js";
import { devicePositionId } from "../../shared/device-factories.js";
import { canAccessCity, getUserScope } from "../../auth/user-scopes.js";

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
    if(req.body.dry!==true&&!/^dify-preview:[A-Za-z0-9-]{1,80}$/.test(session))return reply.code(422).send({detail:"preview session_key must start with dify-preview:"});
    return generateDifyReply(db,{deviceCode:`preview-admin-${req.auth.id}`,positionId,sessionKey:session,text:input,dry:req.body.dry===true,preview:true});
  });
  for (const method of ["get", "put"] as const) {
    app[method]<{Params:{code:string};Body:{provider?:unknown;fresh_client_state_confirmed?:unknown}}>("/api/v1/agent/devices/:code/reply-provider", async (req, reply) => {
      if (req.auth?.role !== "admin") return reply.code(403).send({detail:"Admin access required"});
      const row = db.prepare("SELECT id,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(req.params.code) as {id:number;data_json:string} | undefined;
      if (!row) return reply.code(404).send({detail:"设备不存在"});
      if (method === "put") {
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
export async function generateDifyReply(db: DatabaseSync, input:{deviceCode:string;positionId:number;sessionKey:string;text:string;dry?:boolean;preview?:boolean}) {
  const account=db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(input.deviceCode) as {account_id:string} | undefined;
  const cfg=config();
  const identity=digest(JSON.stringify([input.deviceCode,account?.account_id||"",input.sessionKey,input.positionId,cfg.base,digest(cfg.key)]));
  const previous=queues.get(identity)||Promise.resolve();
  const pending=previous.catch(()=>{}).then(()=>run());queues.set(identity,pending);
  try {return await pending;} finally {if(queues.get(identity)===pending)queues.delete(identity);}
  async function run() {
    const blocked=()=>{
      if(input.preview)return false;
      const dev=db.prepare("SELECT status,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(input.deviceCode) as {status:string;data_json:string}|undefined;
      if (!dev || dev.status!=="enabled" || devicePositionId(db,input.deviceCode)!==input.positionId || deviceReplyProvider(db,input.deviceCode)!=="dify") return true;
      const conv=db.prepare("SELECT takeover FROM agent_conversations WHERE device_code=? AND external_conversation_id=?").get(input.deviceCode,input.sessionKey) as {takeover:number}|undefined;
      const nowAccount=db.prepare("SELECT account_id FROM bridge_devices WHERE device_code=?").get(input.deviceCode) as {account_id:string}|undefined;
      return Boolean(conv?.takeover || nowAccount?.account_id!==account?.account_id);
    };
    if(blocked()) return failure("human_takeover","设备停用、已切换账号或会话已接管");
    const facts=difyContext(db,input.positionId);
    if(!facts)return failure("dify_position_unavailable","岗位不可用");
    const selected=difyInput(facts,input.text);
    if(!selected)return failure('dify_context_too_large','城市关键字段过长，请精简薪资、时间或面试地点；完整话术请放入原文段落或知识库');
    const payload={inputs:{position_data:JSON.stringify(selected),current_time:new Date().toLocaleString("sv-SE",{timeZone:"Asia/Shanghai"})},query:input.text,response_mode:"blocking",user:`recruit-${identity}`};
    if(input.dry)return {ok:true,provider:"dify",dry:true,position_id:input.positionId,inputs:payload.inputs};
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
      const amounts=(value:string)=>[...value.matchAll(/(\d+(?:\.\d+)?)(?:\s*[-~到至]\s*(\d+(?:\.\d+)?))?\s*(?:(?:元|块)(?:\s*[/每]\s*(小时|时|天|班次?|月|晚))?|[/每]\s*(小时|时|天|班次?|月|晚))/g)].flatMap(m=>{
        const units:Record<string,string>={小时:'hour',时:'hour',天:'day',班:'shift',班次:'shift',月:'month',晚:'night'};
        const unit=units[m[3]||m[4]]||'currency';return [m[1],m[2]].filter(Boolean).map(n=>`${Number(n)}:${unit}`);
      });
      const knownAmounts=new Set(amounts(JSON.stringify(selected)));
      if(amounts(answer).some(amount=>!knownAmounts.has(amount)))throw new Error("dify_fact_mismatch");
      if(blocked())throw new Error("human_takeover");
      if (JSON.stringify(difyContext(db,input.positionId)) !== JSON.stringify(facts)) throw new Error("dify_position_changed");
      const messages=answer.split("###").map(s=>s.trim()).filter(Boolean).map(content=>({type:"text",content}));
      if(!messages.length)throw new Error("dify_invalid_reply");
      return {ok:true,provider:"dify",model:"Dify Chatflow",session_key:input.sessionKey,reply:{messages},latency_ms:Date.now()-started};
    } catch(e) {
      const code=e instanceof Error?e.message:"";
      errorCode=["dify_http_error","dify_invalid_response","dify_invalid_reply","dify_fact_mismatch","dify_position_changed","human_takeover"].includes(code)?code:"dify_unavailable";
      return failure(errorCode,"Dify 回复暂停，请在调试台或会话日志中检查");
    } finally {
      db.prepare("INSERT INTO dify_reply_calls(id,device_code,position_id,status,error_code,latency_ms) VALUES (?,?,?,?,?,?)").run(randomUUID(),input.deviceCode,input.positionId,errorCode?"failed":"generated",errorCode,Date.now()-started);
    }
  }
}

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { createMessageChannelProvider, type MessageChannelProvider } from "../messaging/message-channel-provider.js";

/**
 * 面试后跟进（对应 Task #48）。
 *
 * 触发条件：candidate_events.status='invited' 且 interview_date <= 今天（本地日期）
 * 且 remind_count < max_count。发送统一走 channel.sendMessage()，
 * 由通道实现自己决定是入队 bridge_commands 还是 HTTP 网关，这里不碰 bridge_commands。
 *
 * 默认关闭：agent_configs(kind='followup') 里 enabled !== true 时 runFollowupOnce 直接跳过。
 * 开关打开后由本模块自带的定时器按「追问间隔」驱动，间隔取自同一份配置。
 */

export interface FollowupConfig {
  enabled: boolean;
  maxCount: number;
  scripts: string[];
  /** 「追问设置 → 追问间隔」，秒。页面一直能存这个值，但过去没有任何人读它。 */
  intervalSeconds: number;
}

export interface FollowupDeps {
  channel: MessageChannelProvider;
  now?: () => Date;
  logger?: { warn: (...args: unknown[]) => void };
}

export interface FollowupRunResult {
  skipped: boolean;
  scanned: number;
  sent: number;
  failed: number;
  items: Array<{ customer_id: string; device_code: string; interview_date: string; remind_count: number; ok: boolean; error?: string }>;
}

export interface ReminderTask {
  customer_id: string;
  nickname: string;
  device_code: string;
  interview_date: string;
  interview_time: string;
  remind_count: number;
  status: string;
  next_due: string;
}

export interface CandidateRow {
  id: number;
  device_code: string;
  customer_id: string;
  nickname: string;
  interview_date: string;
  interview_time: string;
  factory_name: string;
  remind_count: number;
  status: string;
}

const DEFAULT_SCRIPTS = [
  "昨天面试的工作内容有没有哪里不清楚的？有的话我再跟你说明一下。今天或者明天有空过来吗？",
];

/** 只认 YYYY-MM-DD，防止脏数据（"明天"/"下午"）把比较算错。 */
export function normalizeDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

/** 服务器本地日期（跟进是按本地“今天”算的，不能用 UTC 的 toISOString 切片）。 */
export function localToday(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function readFollowupConfig(db: DatabaseSync): FollowupConfig {
  let raw: Record<string, unknown> = {};
  try {
    const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='followup' AND recruiter_id='global'").get() as { value_json: string } | undefined;
    if (row) {
      const parsed: unknown = JSON.parse(row.value_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  const maxCount = Number(raw.max_count);
  const intervalSeconds = Number(raw.interval_seconds);
  const scripts = Array.isArray(raw.scripts) ? raw.scripts.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  return {
    enabled: raw.enabled === true,
    maxCount: Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 3,
    scripts: scripts.length ? scripts : DEFAULT_SCRIPTS,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds >= 30 ? Math.floor(intervalSeconds) : 300,
  };
}

function dueCandidates(db: DatabaseSync, maxCount: number, filter?: { sql: string; values: Array<string | number> }): CandidateRow[] {
  const sql = `SELECT id,device_code,customer_id,nickname,interview_date,interview_time,factory_name,remind_count,status
    FROM candidate_events WHERE status='invited' AND interview_date<>'' AND remind_count<${maxCount}${filter?.sql ?? ""}
    ORDER BY interview_date ASC, id ASC`;
  return db.prepare(sql).all(...(filter?.values ?? [])) as unknown as CandidateRow[];
}

/** 手工触发/巡检共用：只返回日期已到（<= 今天）且未超过提醒次数的候选。 */
export function listDueCandidates(db: DatabaseSync, options: { today?: string; maxCount?: number; filter?: { sql: string; values: Array<string | number> } } = {}): CandidateRow[] {
  const today = options.today ?? localToday();
  const maxCount = options.maxCount ?? readFollowupConfig(db).maxCount;
  return dueCandidates(db, maxCount, options.filter)
    .filter((row) => {
      const date = normalizeDate(row.interview_date);
      return date !== "" && date <= today;
    });
}

export function listReminderTasks(db: DatabaseSync, options: Parameters<typeof listDueCandidates>[1] = {}): ReminderTask[] {
  const today = options.today ?? localToday();
  return listDueCandidates(db, { ...options, today }).map((row) => ({
    customer_id: String(row.customer_id),
    nickname: row.nickname,
    device_code: row.device_code,
    interview_date: normalizeDate(row.interview_date),
    interview_time: row.interview_time,
    remind_count: Number(row.remind_count ?? 0),
    status: row.status,
    next_due: nextDue(row.interview_date),
  }));
}

/** 下一次可发送的时间：面试日当天 09:00；已经过了就是现在。 */
function nextDue(interviewDate: string): string {
  const date = normalizeDate(interviewDate);
  if (!date) return "";
  const at = new Date(`${date}T09:00:00`);
  if (Number.isNaN(at.getTime())) return date;
  return at.toISOString();
}

function pickScript(scripts: string[], remindCount: number): string {
  if (!scripts.length) return DEFAULT_SCRIPTS[0];
  const index = Math.max(0, remindCount) % scripts.length;
  return scripts[index];
}

/**
 * 跑一轮跟进。不抛异常：单个候选失败只记 warn，不重试轰炸（下一轮扫描会自然再试）。
 */
export async function runFollowupOnce(db: DatabaseSync, deps: FollowupDeps): Promise<FollowupRunResult> {
  const config = readFollowupConfig(db);
  if (!config.enabled) return { skipped: true, scanned: 0, sent: 0, failed: 0, items: [] };

  const now = deps.now ? deps.now() : new Date();
  const candidates = listDueCandidates(db, { today: localToday(now), maxCount: config.maxCount });
  const logger = deps.logger ?? console;
  const result: FollowupRunResult = { skipped: false, scanned: candidates.length, sent: 0, failed: 0, items: [] };

  for (const candidate of candidates) {
    const customerId = Number(candidate.customer_id);
    if (!Number.isSafeInteger(customerId)) continue;
    const remindCount = Number(candidate.remind_count ?? 0);
    const content = pickScript(config.scripts, remindCount);
    const idempotencyKey = `followup:${candidate.device_code}:${candidate.customer_id}:${normalizeDate(candidate.interview_date)}:${remindCount + 1}`;
    try {
      const sent = await deps.channel.sendMessage({ deviceCode: candidate.device_code, customerId, content, idempotencyKey });
      if (!sent.success) {
        result.failed += 1;
        result.items.push({ customer_id: String(candidate.customer_id), device_code: candidate.device_code, interview_date: candidate.interview_date, remind_count: remindCount, ok: false, error: sent.error ?? "send failed" });
        logger.warn(`[followup] send failed device=${candidate.device_code} customer=${candidate.customer_id}: ${sent.error ?? "unknown"}`);
        continue;
      }
      db.prepare("UPDATE candidate_events SET remind_count=remind_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(candidate.id);
      result.sent += 1;
      result.items.push({ customer_id: String(candidate.customer_id), device_code: candidate.device_code, interview_date: candidate.interview_date, remind_count: remindCount + 1, ok: true });
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.items.push({ customer_id: String(candidate.customer_id), device_code: candidate.device_code, interview_date: candidate.interview_date, remind_count: remindCount, ok: false, error: message });
      logger.warn(`[followup] send threw device=${candidate.device_code} customer=${candidate.customer_id}: ${message}`);
    }
  }

  return result;
}

/** 面试提醒的配置（「回复规则 → 面试提醒」页写入的那一份）。 */
export interface ReminderConfig {
  enabled: boolean;
  mode: string;
  advanceHours: number;
  fixedTime: string;
  script: string;
}

export function readReminderConfig(db: DatabaseSync): ReminderConfig {
  let raw: Record<string, unknown> = {};
  try {
    const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string } | undefined;
    if (row) {
      const parsed: unknown = JSON.parse(row.value_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  return {
    enabled: raw.enabled === true,
    mode: String(raw.mode ?? "advance"),
    advanceHours: Number(raw.advance_hours ?? 2) || 2,
    fixedTime: String(raw.fixed_time ?? "09:00"),
    script: String(raw.script ?? ""),
  };
}

/** 手动触发入口（管理员），方便验收；不注册任何定时器。 */
export async function registerFollowupRoutes(app: FastifyInstance, db: DatabaseSync, channel: MessageChannelProvider = createMessageChannelProvider(undefined, db)) {
  app.post("/api/v1/agent/followup/run", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    return runFollowupOnce(db, { channel });
  });

  /**
   * 候选人列表的「提醒到场」按钮。
   *
   * 过去页面上只有 remind_count 的展示，没有任何接口能点；
   * 「回复规则 → 面试提醒」里配的提醒话术也没有任何读取方。这里把两者接上：
   * 用 reminder-config 里的话术给这一位候选人发一条，并累加 remind_count。
   */
  app.post<{ Params: { id: string } }>("/api/v1/agent/candidates/:id/remind", async (request, reply) => {
    const id = Number(request.params.id);
    const candidate = db.prepare(
      "SELECT id, device_code, customer_id, interview_date, remind_count FROM candidate_events WHERE id=?",
    ).get(id) as { id: number; device_code: string; customer_id: string; interview_date: string; remind_count: number } | undefined;
    if (!candidate) return reply.code(404).send({ detail: "候选人不存在" });

    const config = readReminderConfig(db);
    const content = config.script.trim() || "明天面试记得准时到哈，到了给我发个消息";
    const remindCount = Number(candidate.remind_count ?? 0);
    const customerId = Number(candidate.customer_id);
    if (!Number.isSafeInteger(customerId)) return reply.code(422).send({ detail: "customer_id 无效" });

    try {
      const sent = await channel.sendMessage({
        deviceCode: candidate.device_code,
        customerId,
        content,
        idempotencyKey: `remind:${candidate.device_code}:${candidate.customer_id}:${remindCount + 1}`,
      });
      if (!sent.success) return reply.code(502).send({ detail: sent.error ?? "发送失败" });
      db.prepare("UPDATE candidate_events SET remind_count=remind_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      return { success: true, remind_count: remindCount + 1, content };
    } catch (error) {
      return reply.code(502).send({ detail: error instanceof Error ? error.message : "发送失败" });
    }
  });

  /**
   * 「追问设置」的自动执行。
   *
   * 过去这个页面的开关、间隔、追问次数全部只存在 agent_configs 里，
   * 没有任何调度器调用 runFollowupOnce——等于运营打开了也什么都不会发生。
   * 这里起一个自愈式定时器：每 30 秒看一次配置，到了配置的间隔就跑一轮。
   * 进程内只允许一个定时器；没配置或已关闭时直接跳过，不产生任何开销。
   */
  const tickMs = 30_000;
  let lastRun = 0;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    const config = readFollowupConfig(db);
    if (!config.enabled) return;
    if (Date.now() - lastRun < config.intervalSeconds * 1000) return;
    running = true;
    lastRun = Date.now();
    try {
      await runFollowupOnce(db, { channel });
    } catch {
      // 单轮失败不影响下一轮；runFollowupOnce 内部已按候选隔离并记录日志
    } finally {
      running = false;
    }
  }, tickMs);
  timer.unref();
  app.addHook("onClose", () => clearInterval(timer));
}

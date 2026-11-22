import type { DatabaseSync } from "node:sqlite";
import { parseDeviceData } from "./device-factories.js";

/**
 * R1：名单自动发内部邀约群（录屏 02:10 实证）。
 *
 * 客户原话：「求职者给你发了这些什么名单之类的，OK 我们就自动去录名单，
 * 然后按照这个格式去发就行了」。
 *
 * 格式：`[城市简写][月/日] [姓名] [手机号]`
 *   深11/9 谢子鑫 18077352958
 *
 * 城市简写不确定（深=深圳、万=万江/东莞、百=?），所以做成可配置映射，
 * 没配的城市取城市名首字兜底——宁可发「佛11/9」也不要因为缺映射就不发。
 */

export interface InviteGroupConfig {
  enabled: boolean;
  /** 群名，客户端把它输进企微搜索框定位会话；必须与企微里的群名一字不差 */
  groupName: string;
  /**
   * 群会话的真实 conv_id（`R:` 前缀），例如 `R:1970325309996590`。
   *
   * 为什么必须有它：客户端是靠**群名**搜索定位会话的，发送后回读校验却按
   * contact_id 比对落点。以前写的是 `R:<群名>`，那是凭空造的 id，永远比不中，
   * 于是每条都被记成「已发送但回读失败」。填了真实 conv_id 之后，落点校验
   * 才成立，群消息的回执也能正常推进 bridge_commands。
   */
  convId: string;
  /** 用哪台设备发（空 = 用候选人所在设备） */
  deviceCode: string;
  /** 城市名 → 简写映射，如 {"深圳":"深","东莞":"万"} */
  cityAbbr: Record<string, string>;
  /**
   * 企业微信群机器人 Webhook 地址（推荐通道）。
   *
   * 为什么优先用它：建群本身企业微信没有开放接口，只能人工建一次；建好后
   * 在群里加一个「群机器人」就能拿到 ，
   * 后端直接 POST 即可送达。相比键鼠自动化，它不依赖客户端在线、不需要
   * 按群名搜索定位（搜不到就会拒绝发送），也不会因为群久不活跃被挤出
   * 本地会话表前 500 条而失败。
   * 留空则退回原来的客户端发群通道。
   */
  webhookUrl: string;
}

export const DEFAULT_INVITE_GROUP_CONFIG: InviteGroupConfig = {
  enabled: false,
  groupName: "",
  convId: "",
  deviceCode: "",
  cityAbbr: {},
  webhookUrl: "",
};

export function readInviteGroupConfig(db: DatabaseSync): InviteGroupConfig {
  let raw: Record<string, unknown> = {};
  try {
    const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='invite_group' AND recruiter_id='global'").get() as { value_json: string } | undefined;
    if (row) {
      const parsed: unknown = JSON.parse(row.value_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  const abbrRaw = raw.city_abbr && typeof raw.city_abbr === "object" && !Array.isArray(raw.city_abbr)
    ? raw.city_abbr as Record<string, unknown> : {};
  const cityAbbr: Record<string, string> = {};
  for (const [city, abbr] of Object.entries(abbrRaw)) {
    const key = String(city ?? "").trim();
    const value = String(abbr ?? "").trim();
    if (key && value) cityAbbr[key] = value;
  }
  return {
    // 默认开启：只有运营明确关掉（enabled:false）才不发。
    // 以前是 `=== true`，配好群名/Webhook 但没点那个开关就一直记「未启用」，
    // 运营以为发了、实际一条没发（2026-11-15 实测点③）。没配群名和 Webhook
    // 时下面会落到「未配置邀约群」，所以打开默认值不会误发。
    enabled: raw.enabled !== false,
    groupName: String(raw.group_name ?? "").trim(),
    convId: String(raw.conv_id ?? "").trim(),
    deviceCode: String(raw.device_code ?? "").trim(),
    cityAbbr,
    webhookUrl: String(raw.webhook_url ?? "").trim(),
  };
}

/** 城市简写：先查映射，再退城市名首字（去掉「市」后缀）。 */
export function cityAbbrOf(city: string, mapping: Record<string, string>): string {
  const name = String(city ?? "").trim();
  if (!name) return "";
  const bare = name.replace(/市$/, "");
  return mapping[name] || mapping[bare] || bare.slice(0, 1);
}

/** `2026-11-09` → `11/9`；认不出日期回空串，由调用方决定不发。 */
export function monthDayOf(interviewDate: string): string {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(interviewDate ?? "").trim());
  if (!match) return "";
  return `${Number(match[2])}/${Number(match[3])}`;
}

/**
 * 拼一行名单。字段不全返回空串——宁可这条不发，也不能发半行让群里看不懂。
 */
export function buildInviteLine(input: { city: string; interviewDate: string; name: string; phone: string; cityAbbr: Record<string, string> }): string {
  const abbr = cityAbbrOf(input.city, input.cityAbbr);
  const monthDay = monthDayOf(input.interviewDate);
  const name = String(input.name ?? "").trim();
  const phone = String(input.phone ?? "").trim();
  if (!abbr || !monthDay || !name || !/^1[3-9]\d{9}$/.test(phone)) return "";
  return `${abbr}${monthDay} ${name} ${phone}`;
}

export interface InviteGroupSendInput {
  deviceCode: string;
  customerId: string;
  candidateEventId: number;
  city: string;
  interviewDate: string;
  name: string;
  phone: string;
  /** 以下为「整理好的信息」，有就补在名单行后面，没有就省略 */
  jobTitle?: string;
  factoryName?: string;
  interviewTime?: string;
  interviewPlace?: string;
  district?: string;
}

/**
 * 一整条要发进群的消息：名单行 + 补充信息，全部单行空格分隔。
 *
 * 为什么坚持单行：客户端是「粘贴 + 回车」发送，多行文本在企微输入框里
 * 会产生换行占位，回车是否一次发出取决于输入框状态，多行会显著提高
 * 发半截/发不出去的概率。单行没有这个风险，群里也一眼能看完。
 *
 * 补充字段按「岗位 · 厂名 · 面试时间 · 地点」顺序拼，空值跳过——
 * 宁可少写一项，也不要在群里出现 `地点：` 这种空标签。
 */
export function buildInviteMessage(input: {
  city: string; interviewDate: string; name: string; phone: string;
  cityAbbr: Record<string, string>;
  jobTitle?: string; factoryName?: string; interviewTime?: string; interviewPlace?: string; district?: string;
}): string {
  const line = buildInviteLine(input);
  if (!line) return "";
  const extras = [input.factoryName, input.jobTitle, input.interviewTime, input.interviewPlace]
    .map(value => String(value ?? "").trim())
    .filter(Boolean);
  // 去重：厂名与岗位经常是「深圳地铁安检 安检员」，重复出现同一个词没意义
  const unique: string[] = [];
  for (const value of extras) if (!unique.includes(value)) unique.push(value);
  return unique.length ? `${line} ${unique.join(" ")}` : line;
}

export interface InviteGroupSendResult {
  status: "sent" | "skipped" | "failed";
  content: string;
  reason?: string;
}

/**
 * 只接受企业微信官方群机器人地址。
 *
 * 不做「任意 URL 都能填」：这个配置会让服务端主动发 POST，开放出去等于
 * 把后台变成一个 SSRF 跳板（内网地址、云元数据端点都能打）。只放行
 * qyapi.weixin.qq.com 的 /cgi-bin/webhook/send，够用且没有开放面。
 */
export function isAllowedWebhookUrl(raw: string): boolean {
  const value = String(raw ?? "").trim();
  if (!value) return false;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "qyapi.weixin.qq.com") return false;
  if (!parsed.pathname.startsWith("/cgi-bin/webhook/send")) return false;
  return parsed.searchParams.get("key") !== null && (parsed.searchParams.get("key") ?? "") !== "";
}

/** 群机器人只认 text/text 或 markdown/text 包体；这里用纯文本，最稳。 */
export type InviteGroupWebhookSender = (url: string, content: string) => Promise<{ success: boolean; error?: string }>;

export const defaultWebhookSender: InviteGroupWebhookSender = async (url, content) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content } }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { data = {}; }
    // 企微即使 HTTP 200 也可能带 errcode，必须看 body
    const errcode = Number(data.errcode ?? 0);
    if (!response.ok || (Number.isFinite(errcode) && errcode !== 0)) {
      return { success: false, error: `企业微信群机器人返回 ${errcode || response.status}: ${String(data.errmsg ?? text).slice(0, 200)}` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * 把一条名单发到内部邀约群，并落一条发送记录。
 *
 * 通道优先级（2026-11-16 改）：
 *   ① 配了群会话 conv_id（`R:` 前缀）→ 走客户端键鼠直发，和给客户发消息
 *      完全同一条链路（bridge enqueue → 客户端 claim → 搜索群名 → 粘贴回车）。
 *      客户明确要求「直接发，不用 bot」，所以这一条优先。
 *   ② 没配 conv_id 但配了合法群机器人 Webhook → 后端直接 POST。
 *   ③ 都没有 → 记 skipped，不假装发过。
 *
 * 幂等分两层：
 *   - 发送前查同一幂等键是否已 sent，已发过就直接返回，不重复入队（防刷屏）；
 *   - 落库用 ON CONFLICT upsert，同一人同一天只有一行记录。
 */
export async function sendInviteGroupLine(
  db: DatabaseSync,
  input: InviteGroupSendInput,
  deps: {
    send: (args: { deviceCode: string; customerId: number; content: string; idempotencyKey: string }) => Promise<{ success: boolean; error?: string }>;
    /** 群机器人发送；不传就用默认 HTTP 实现（测试里替换掉） */
    webhook?: InviteGroupWebhookSender;
  },
): Promise<InviteGroupSendResult> {
  const config = readInviteGroupConfig(db);
  const content = buildInviteMessage({
    city: input.city, interviewDate: input.interviewDate, name: input.name, phone: input.phone,
    cityAbbr: config.cityAbbr,
    jobTitle: input.jobTitle, factoryName: input.factoryName,
    interviewTime: input.interviewTime, interviewPlace: input.interviewPlace,
  });

  // 幂等键：候选人 + 面试日期。改期会生成新的一行；同一人同一天重复推送不会刷屏。
  const idempotencyKey = `invite-group:${input.deviceCode}:${input.candidateEventId}:${String(input.interviewDate).trim()}`;
  const record = (status: string, error = "") => {
    db.prepare(`INSERT INTO invite_group_sends(device_code,customer_id,candidate_event_id,group_name,content,idempotency_key,status,error)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status,error=excluded.error,content=excluded.content,updated_at=CURRENT_TIMESTAMP`)
      .run(input.deviceCode, input.customerId, input.candidateEventId, config.groupName, content, idempotencyKey, status, error);
  };

  if (!content) {
    record("skipped", "字段不全：城市/面试日期/姓名/手机号");
    return { status: "skipped", content, reason: "字段不全" };
  }
  if (!config.enabled) {
    record("skipped", "未启用自动发群");
    return { status: "skipped", content, reason: "未启用自动发群" };
  }
  // 已经发成功过就不再入队。以前只在落库层做 upsert，发送前不查，
  // 结果档案每次推送都把同一个人再发一遍（webhook 通道无回执，刷屏最明显）。
  const previous = db.prepare("SELECT status FROM invite_group_sends WHERE idempotency_key=?").get(idempotencyKey) as { status: string } | undefined;
  if (previous?.status === "sent") return { status: "sent", content, reason: "已发送过，跳过重复发送" };

  const convId = config.convId.trim();
  if (convId && !/^R:/.test(convId)) {
    // 填了但不是群会话 id：明确失败，不要猜。
    record("failed", `群会话 ID 无效：应以 R: 开头，实际是 ${convId.slice(0, 20)}`);
    return { status: "failed", content, reason: "群会话 ID 无效" };
  }

  if (convId) {
    if (!config.groupName) {
      // 客户端靠群名搜索定位会话，没有群名就发不出去，提前拦住。
      record("failed", "已配置群会话 ID 但缺群名：客户端靠群名搜索定位会话");
      return { status: "failed", content, reason: "缺群名" };
    }
    const deviceCode = config.deviceCode || input.deviceCode;
    // 群会话登记：contact_id 用真实群 id，nickname 用群名（客户端搜索用）。
    // 以前这里是 `R:<群名>`，凭空造的 id，客户端回读校验永远比不中。
    const groupCustomerId = ensureGroupConversation(db, deviceCode, convId, config.groupName);
    try {
      const sent = await deps.send({ deviceCode, customerId: groupCustomerId, content, idempotencyKey });
      if (!sent.success) {
        record("failed", sent.error ?? "发送失败");
        return { status: "failed", content, reason: sent.error };
      }
      record("sent");
      return { status: "sent", content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record("failed", message);
      return { status: "failed", content, reason: message };
    }
  }

  const useWebhook = isAllowedWebhookUrl(config.webhookUrl);
  if (!useWebhook && !config.webhookUrl) {
    record("skipped", "未配置邀约群（群会话 ID / 群名 / Webhook 地址）");
    return { status: "skipped", content, reason: "未配置邀约群" };
  }
  if (config.webhookUrl && !useWebhook) {
    // 填了地址但格式不对：明确记失败，别静默降级到客户端发群——
    // 运营以为走的是机器人，实际却在依赖某台在线电脑，排查会很痛苦。
    record("failed", "Webhook 地址无效：只接受 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...");
    return { status: "failed", content, reason: "Webhook 地址无效" };
  }

  const sender = deps.webhook ?? defaultWebhookSender;
  const sent = await sender(config.webhookUrl, content);
  if (!sent.success) {
    record("failed", sent.error ?? "Webhook 发送失败");
    return { status: "failed", content, reason: sent.error };
  }
  record("sent", "");
  return { status: "sent", content };
}

/**
 * 取（或建）群里那条会话，返回它在 4222 侧的 customer_id。
 *
 * bridge_commands 只认 customer_id，客户端认 nickname（搜索框输入）和
 * contact_id（发送后落点校验），三者必须指向同一个群，所以这里一次登记齐。
 */
export function ensureGroupConversation(db: DatabaseSync, deviceCode: string, convId: string, groupName: string): number {
  const existing = db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=? AND contact_id=?")
    .get(deviceCode, convId) as { customer_id: number } | undefined;
  if (existing?.customer_id) {
    // 群名可能被改过：以最新配置为准更新昵称，否则客户端搜索会落空。
    db.prepare("UPDATE bridge_contacts SET nickname=? WHERE device_code=? AND contact_id=? AND nickname<>?")
      .run(groupName, deviceCode, convId, groupName);
    db.prepare("UPDATE agent_conversations SET nickname=? WHERE device_code=? AND customer_id=? AND nickname<>?")
      .run(groupName, deviceCode, existing.customer_id, groupName);
    return existing.customer_id;
  }
  const groupCustomerId = Number((db.prepare(`SELECT MAX(value)+1 AS id FROM (
    SELECT COALESCE(MAX(customer_id),0) value FROM agent_conversations UNION ALL
    SELECT COALESCE(MAX(customer_id),0) FROM bridge_contacts UNION ALL SELECT 0)`)
    .get() as { id: number }).id);
  db.prepare("INSERT OR IGNORE INTO bridge_contacts(device_code,contact_id,customer_id,nickname) VALUES (?,?,?,?)")
    .run(deviceCode, convId, groupCustomerId, groupName);
  db.prepare("INSERT OR IGNORE INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES (?,?,?,?)")
    .run(deviceCode, groupCustomerId, groupName, convId);
  return groupCustomerId;
}

export const DIFY_GROUP_NOTIFICATION_PREFIX = "dify-group-notify:";

export function deviceInviteGroupBinding(db: DatabaseSync, deviceCode: string): string {
  const device = db.prepare(`SELECT data_json FROM agent_devices WHERE status='enabled'
    AND json_extract(data_json,'$.device_code')=?`).get(deviceCode) as { data_json: string } | undefined;
  return String(parseDeviceData(device?.data_json).group_chat ?? "").trim();
}

export function resolveDeviceInviteGroup(db: DatabaseSync, deviceCode: string, binding: string) {
  if (!binding.trim()) return undefined;
  const rebound = db.prepare(`SELECT created_at FROM device_events
    WHERE device_code=? AND event_type='account_rebound' ORDER BY created_at DESC LIMIT 1`)
    .get(deviceCode) as { created_at: string } | undefined;
  const reboundAt = rebound ? Date.parse(rebound.created_at) : 0;
  const groups = db.prepare(`SELECT DISTINCT conv_id, name FROM device_group_chats
    WHERE device_code=? AND updated_at>=? AND conv_id LIKE 'R:%' AND LENGTH(conv_id)>2 AND TRIM(name)<>''`)
    .all(deviceCode, reboundAt) as { conv_id: string; name: string }[];
  // Older clients can sync real group messages before they report their group list.
  // Those legacy observations lack an account ID, so a device that switched
  // accounts must report its current group list before sending.
  if (!groups.length && !rebound) {
    groups.push(...db.prepare(`SELECT b.contact_id AS conv_id, b.nickname AS name
      FROM bridge_contacts b WHERE b.device_code=? AND b.contact_id LIKE 'R:%'
        AND LENGTH(b.contact_id)>2 AND TRIM(b.nickname)<>''
        AND EXISTS (SELECT 1 FROM bridge_inbound i
          WHERE i.device_code=b.device_code AND substr(i.event_id,1,length(b.contact_id)+1)=b.contact_id||':')`)
      .all(deviceCode) as { conv_id: string; name: string }[]);
  }
  const matches = groups.filter(group => binding.startsWith("R:") ? group.conv_id === binding : group.name === binding);
  if (matches.length !== 1) return undefined;
  const [group] = matches;
  // Windows searches by name and verifies the real group ID on readback.
  if (groups.filter(item => item.name === group.name).length !== 1) return undefined;
  const namesake = db.prepare(`SELECT 1 FROM bridge_contacts
    WHERE device_code=? AND nickname=? AND contact_id<>? LIMIT 1`).get(deviceCode, group.name, group.conv_id);
  return namesake ? undefined : group;
}


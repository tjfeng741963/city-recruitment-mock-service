import type { DatabaseSync } from "node:sqlite";

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
  /** 群名，客户端把它输进企微搜索框定位会话 */
  groupName: string;
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
    enabled: raw.enabled === true,
    groupName: String(raw.group_name ?? "").trim(),
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
 * 把一行名单发到内部邀约群，并落一条发送记录。
 *
 * 幂等：同一位候选人在同一面试日期只发一次（幂等键带了 event id 与日期）。
 * 群会话按「群名」登记进 bridge_contacts（contact_id = `R:<群名>`，
 * 客户端约定 `R:` 前缀表示群聊），nickname 用群名，因为客户端是靠昵称
 * 输进企微搜索框定位会话的。
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
  const content = buildInviteLine({ city: input.city, interviewDate: input.interviewDate, name: input.name, phone: input.phone, cityAbbr: config.cityAbbr });

  // 幂等键：候选人 + 面试日期。改期会生成新的一行，同一天重复推送不会刷屏。
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
  // 两条通道二选一：配了合法 Webhook 就走机器人（不依赖客户端），
  // 否则退回客户端发群。两边都没有可用配置时明确跳过，不假装发过。
  const useWebhook = isAllowedWebhookUrl(config.webhookUrl);
  if (!useWebhook && !config.groupName) {
    record("skipped", "未配置邀约群（群名或 Webhook 地址）");
    return { status: "skipped", content, reason: "未配置邀约群" };
  }
  if (config.webhookUrl && !useWebhook) {
    // 填了地址但格式不对：明确记失败，别静默降级到客户端发群——
    // 运营以为走的是机器人，实际却在依赖某台在线电脑，排查会很痛苦。
    record("failed", "Webhook 地址无效：只接受 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...");
    return { status: "failed", content, reason: "Webhook 地址无效" };
  }

  if (useWebhook) {
    const sender = deps.webhook ?? defaultWebhookSender;
    const sent = await sender(config.webhookUrl, content);
    if (!sent.success) {
      record("failed", sent.error ?? "Webhook 发送失败");
      return { status: "failed", content, reason: sent.error };
    }
    record("sent", "");
    return { status: "sent", content };
  }

  const deviceCode = config.deviceCode || input.deviceCode;
  const groupContact = `R:${config.groupName}`;
  // 群会话登记：已存在就复用，不会因为重复发送插出多条会话
  const contactStore = db.prepare("SELECT customer_id FROM bridge_contacts WHERE device_code=? AND contact_id=?").get(deviceCode, groupContact) as { customer_id: number } | undefined;
  let groupCustomerId = contactStore?.customer_id;
  if (!groupCustomerId) {
    groupCustomerId = Number((db.prepare(`SELECT MAX(value)+1 AS id FROM (
      SELECT COALESCE(MAX(customer_id),0) value FROM agent_conversations UNION ALL
      SELECT COALESCE(MAX(customer_id),0) FROM bridge_contacts UNION ALL SELECT 0)`)
      .get() as { id: number }).id);
    db.prepare("INSERT OR IGNORE INTO bridge_contacts(device_code,contact_id,customer_id,nickname) VALUES (?,?,?,?)")
      .run(deviceCode, groupContact, groupCustomerId, config.groupName);
    db.prepare("INSERT OR IGNORE INTO agent_conversations(device_code,customer_id,nickname,external_conversation_id) VALUES (?,?,?,?)")
      .run(deviceCode, groupCustomerId, config.groupName, groupContact);
  }

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

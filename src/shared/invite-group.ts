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
}

export const DEFAULT_INVITE_GROUP_CONFIG: InviteGroupConfig = {
  enabled: false,
  groupName: "",
  deviceCode: "",
  cityAbbr: {},
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
  deps: { send: (args: { deviceCode: string; customerId: number; content: string; idempotencyKey: string }) => Promise<{ success: boolean; error?: string }> },
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
  if (!config.enabled || !config.groupName) {
    record("skipped", "未配置邀约群");
    return { status: "skipped", content, reason: "未配置邀约群" };
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

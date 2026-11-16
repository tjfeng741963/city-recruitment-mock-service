import type { DatabaseSync } from "node:sqlite";

/**
 * 事件规则：把「我们说了什么」翻译成「客户走到哪一步」。
 *
 * 背景：客户要的是「回复规则 → 打标签」，但原版页面（AgentRulesView）里只有
 * 面试提醒和追问设置两块，没有任何关键词界面；真正在跑的只有
 * response-serializers.ts 里写死的 DEFAULT_EVENT_RULES，而且**没有任何消费方** ——
 * 网页上配的东西和实际打标签完全是两件事。
 *
 * 关键约束：关键词命中的是**我们自己发出去的那句话**，不是客户说的。
 * 「报名成功」「那就祝您面试顺利」都出现在 AI 的回复里，只在入站文本里找永远找不到。
 * 所以判定必须挂在「回复已发出」之后。
 *
 * 规则来源：agent_rules 表（status='enabled'），一条规则的 data_json 形如
 *   { "event": "invited", "description": "邀约成功",
 *     "keywords": ["报名成功", "面试日期"], "match_mode": "any",
 *     "once_per_session": true }
 * 表里没有任何启用规则时，回退到代码里的默认四条，保证行为不比现在差。
 */

export interface EventRule {
  event: string;
  description: string;
  keywords: string[];
  matchMode: "any" | "all";
  oncePerSession: boolean;
}

/** 与 response-serializers.ts 的 DEFAULT_EVENT_RULES 保持一致，避免两套默认值分叉。 */
export const FALLBACK_EVENT_RULES: EventRule[] = [
  { event: "disqualified", description: "不符合条件", keywords: ["后续再聊", "暂时安排不了"], matchMode: "any", oncePerSession: true },
  { event: "invited", description: "邀约成功", keywords: ["报名成功", "面试日期"], matchMode: "any", oncePerSession: true },
  // checked_in 故意不在默认规则里：签到是「客户真的到场」才成立的事实，而我们唯一
  // 能匹配的是自己发出去的话。原关键词「那就祝您面试顺利」「请准时到本公司面试」
  // 恰好出现在面试通知模板里，运营一发通知，这个人立刻从「报名成功」跳到「已签到」
  // ——而他明天才来（2026-11-15 实测；STATUS_RANK 只升不降，跳上去就退不回来）。
  // 现在签到只能人工标记：POST /api/v1/agent/candidates/:id/mark {status:"checked_in"}。
  // 运营仍可在「回复规则」里自己加 checked_in 规则，那是明确的自主决定。
  { event: "pending_invite", description: "待邀约", keywords: ["到时候联系", "再联系我", "有需要联系我就行"], matchMode: "any", oncePerSession: true },
];

function parseRule(row: { rule_name: string; data_json: string }): EventRule | null {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const keywords = Array.isArray(data.keywords)
    ? data.keywords.map((word) => String(word ?? "").trim()).filter((word) => word.length >= 2)
    : [];
  if (!keywords.length) return null;
  const event = String(data.event ?? row.rule_name ?? "").trim();
  if (!event) return null;
  return {
    event,
    description: String(data.description ?? row.rule_name ?? "").trim(),
    keywords,
    matchMode: data.match_mode === "all" ? "all" : "any",
    oncePerSession: data.once_per_session !== false,
  };
}

/** 读启用中的规则；一条都读不到就用默认四条。 */
export function readEventRules(db: DatabaseSync): EventRule[] {
  try {
    const rows = db.prepare(
      "SELECT rule_name, data_json FROM agent_rules WHERE status='enabled' ORDER BY id",
    ).all() as Array<{ rule_name: string; data_json: string }>;
    const rules = rows.map(parseRule).filter((rule): rule is EventRule => rule !== null);
    return rules.length ? rules : FALLBACK_EVENT_RULES;
  } catch {
    // 表不存在（老库没跑迁移）也不能让回复链路炸掉
    return FALLBACK_EVENT_RULES;
  }
}

/** 单条规则是否命中一段文本。关键词 ≥2 字参与匹配，避免「好」这种满屏命中。 */
export function matchesRule(rule: EventRule, text: string): boolean {
  const haystack = String(text ?? "");
  if (!haystack) return false;
  const hits = rule.keywords.filter((keyword) => haystack.includes(keyword));
  return rule.matchMode === "all" ? hits.length === rule.keywords.length : hits.length > 0;
}

export interface EventRuleHit {
  event: string;
  description: string;
  matchedKeyword: string;
}

/** 按规则顺序找第一条命中的；命中就返回——规则顺序即优先级。 */
export function firstMatchingRule(rules: EventRule[], text: string): EventRuleHit | null {
  for (const rule of rules) {
    if (!matchesRule(rule, text)) continue;
    const matchedKeyword = rule.keywords.find((keyword) => String(text ?? "").includes(keyword)) ?? "";
    return { event: rule.event, description: rule.description, matchedKeyword };
  }
  return null;
}

export interface ApplyEventRuleInput {
  deviceCode: string;
  customerId: number;
  /** 本轮我们真正发出去的回复文本 */
  outboundText: string;
}

export interface ApplyEventRuleResult extends EventRuleHit {
  /** 是否写入了状态（被 once_per_session 或状态回退保护挡下时为 false） */
  applied: boolean;
  reason?: string;
}

/**
 * 只升不降的状态阶梯。
 *
 * 同一个会话里 AI 可能连着说好几段话，关键词会反复命中；客户已经签到，
 * 后面再命中「待邀约」不能把状态退回去。disqualified 是终态。
 */
const STATUS_RANK: Record<string, number> = {
  none: 0,
  pending_invite: 1,
  communicating: 2,
  invited: 3,
  checked_in: 4,
  disqualified: 5,
};

function rank(status: string): number {
  return STATUS_RANK[status] ?? 0;
}

export function applyEventRule(
  db: DatabaseSync,
  input: ApplyEventRuleInput,
  rules: EventRule[] = readEventRules(db),
): ApplyEventRuleResult | null {
  const hit = firstMatchingRule(rules, input.outboundText);
  if (!hit) return null;

  const conversation = db.prepare(
    "SELECT id, recruit_status FROM agent_conversations WHERE device_code=? AND customer_id=?",
  ).get(input.deviceCode, input.customerId) as { id: number; recruit_status: string } | undefined;
  if (!conversation) return { ...hit, applied: false, reason: "会话不存在" };

  const current = String(conversation.recruit_status ?? "none");
  if (current === "disqualified" && hit.event !== "disqualified") {
    return { ...hit, applied: false, reason: "客户已标记不符合，终态不回退" };
  }
  if (current !== "disqualified" && rank(hit.event) < rank(current)) {
    return { ...hit, applied: false, reason: `状态只升不降（当前 ${current}）` };
  }

  // once_per_session：同一会话同一事件只记一次，避免每次回复都刷一条候选人记录。
  const tagged = db.prepare(
    "SELECT id FROM candidate_events WHERE device_code=? AND customer_id=? AND event_type=? AND status=? LIMIT 1",
  ).get(input.deviceCode, String(input.customerId), hit.event, hit.event) as { id: number } | undefined;
  const rule = rules.find((item) => item.event === hit.event);
  if (tagged && rule?.oncePerSession) {
    return { ...hit, applied: false, reason: "本会话已打过该标签" };
  }

  db.prepare("UPDATE agent_conversations SET recruit_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(hit.event, conversation.id);

  // 候选人事件：已有同类型就更新状态，没有就补一条，保证 /candidates 页能看到。
  if (tagged) {
    db.prepare("UPDATE candidate_events SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(tagged.id);
  } else {
    db.prepare(`INSERT INTO candidate_events(device_code,customer_id,event_type,status,data_json)
      VALUES (?,?,?,?,?)`)
      .run(input.deviceCode, String(input.customerId), hit.event, hit.event,
        JSON.stringify({ source: "event_rule", keyword: hit.matchedKeyword, description: hit.description }));
  }
  return { ...hit, applied: true };
}

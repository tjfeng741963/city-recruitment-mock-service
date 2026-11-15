import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { applyEventRule, firstMatchingRule, FALLBACK_EVENT_RULES, matchesRule, readEventRules } from "../src/shared/event-rules.js";

/**
 * 回复规则打标签。
 *
 * 客户要的「回复规则」，实际判定对象是**我们自己发出去的那句话**：
 * 「报名成功」「那就祝您面试顺利」都出现在 AI 的回复里，只在客户原话里找永远找不到。
 * 页面（AgentRulesView）只配了面试提醒和追问，没有关键词界面；规则一直写死在代码里
 * 且没有消费方。这里让 agent_rules 表真正生效，并锁定三个行为：
 *   1. 关键词命中 → 会话状态 + 候选人事件
 *   2. 状态只升不降，disqualified 为终态
 *   3. 同会话同标签只记一次
 */
describe("event rule matching", () => {
  it("matches any/all keyword modes and skips one-character keywords", () => {
    const anyRule = { event: "invited", description: "邀约成功", keywords: ["报名成功", "面试日期"], matchMode: "any" as const, oncePerSession: true };
    expect(matchesRule(anyRule, "明天面试日期是 11/9，收到请回复")).toBe(true);
    expect(matchesRule(anyRule, "你在哪个城市")).toBe(false);

    const allRule = { ...anyRule, matchMode: "all" as const };
    expect(matchesRule(allRule, "明天面试日期是 11/9")).toBe(false);
    expect(matchesRule(allRule, "报名成功，明天面试日期是 11/9")).toBe(true);
  });

  it("takes the first matching rule as the winner", () => {
    const hit = firstMatchingRule(FALLBACK_EVENT_RULES, "好的，那就祝您面试顺利，记得带身份证");
    expect(hit).toMatchObject({ event: "checked_in", matchedKeyword: "那就祝您面试顺利" });
    expect(firstMatchingRule(FALLBACK_EVENT_RULES, "你在哪个城市")).toBeNull();
  });
});

describe("event rule tagging end to end", () => {
  let app: FastifyInstance;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_SEED_FIXTURES = "1";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "mock";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_SEED_FIXTURES", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const conversation = (device = "local-device-001", customer = 700001) => app.db.prepare(
    "SELECT id, recruit_status FROM agent_conversations WHERE device_code=? AND customer_id=?",
  ).get(device, customer) as { id: number; recruit_status: string } | undefined;

  it("falls back to the built-in rules when the table has none", () => {
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM agent_rules").get()).toMatchObject({ n: 0 });
    expect(readEventRules(app.db)).toHaveLength(FALLBACK_EVENT_RULES.length);
  });

  it("reads configured rules from agent_rules and ignores disabled ones", () => {
    app.db.prepare("INSERT INTO agent_rules(rule_name,status,data_json) VALUES (?,?,?)")
      .run("到岗确认", "enabled", JSON.stringify({ event: "checked_in", description: "已到岗", keywords: ["我已经到了", "到厂了"], match_mode: "any" }));
    app.db.prepare("INSERT INTO agent_rules(rule_name,status,data_json) VALUES (?,?,?)")
      .run("停用规则", "disabled", JSON.stringify({ event: "invited", keywords: ["报名成功"] }));
    const rules = readEventRules(app.db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ event: "checked_in", keywords: ["我已经到了", "到厂了"] });
  });

  it("writes the conversation status and one candidate event when a reply matches", () => {
    const before = conversation();
    expect(before).toBeDefined();
    const result = applyEventRule(app.db, {
      deviceCode: "local-device-001", customerId: 700001,
      outboundText: "好的，那就祝您面试顺利，到了给我发个消息",
    });
    expect(result).toMatchObject({ event: "checked_in", applied: true });
    expect(conversation()?.recruit_status).toBe("checked_in");
    const events = app.db.prepare("SELECT event_type,status FROM candidate_events WHERE device_code='local-device-001' AND customer_id='700001' AND event_type='checked_in'").all() as Array<{ event_type: string; status: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("checked_in");
  });

  it("does not downgrade a more advanced status and keeps disqualified terminal", () => {
    app.db.prepare("UPDATE agent_conversations SET recruit_status='checked_in' WHERE device_code='local-device-001' AND customer_id=700001").run();
    const downgrade = applyEventRule(app.db, {
      deviceCode: "local-device-001", customerId: 700001,
      outboundText: "到时候联系我，有需要联系我就行",
    });
    expect(downgrade).toMatchObject({ event: "pending_invite", applied: false });
    expect(conversation()?.recruit_status).toBe("checked_in");

    app.db.prepare("UPDATE agent_conversations SET recruit_status='disqualified' WHERE device_code='local-device-001' AND customer_id=700001").run();
    const afterDisqualified = applyEventRule(app.db, {
      deviceCode: "local-device-001", customerId: 700001,
      outboundText: "报名成功，明天面试日期是 11/9",
    });
    expect(afterDisqualified).toMatchObject({ applied: false });
    expect(conversation()?.recruit_status).toBe("disqualified");
  });

  it("tags the same event only once per conversation", () => {
    const input = { deviceCode: "local-device-001", customerId: 700001, outboundText: "好的，那就祝您面试顺利" };
    expect(applyEventRule(app.db, input)).toMatchObject({ applied: true });
    expect(applyEventRule(app.db, input)).toMatchObject({ applied: false, reason: "本会话已打过该标签" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM candidate_events WHERE event_type='checked_in' AND device_code='local-device-001'").get()).toMatchObject({ n: 1 });
  });

  it("leaves the conversation untouched when nothing matches", () => {
    const before = conversation();
    const result = applyEventRule(app.db, {
      deviceCode: "local-device-001", customerId: 700001,
      outboundText: "你想找哪个城市的工作？",
    });
    expect(result).toBeNull();
    expect(conversation()).toEqual(before);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";
import { ChatflowDifyProvider } from "../src/modules/dify/chatflow-engine.js";
import { parseState } from "../src/modules/dify/chatflow-state.js";
import { MessageAutomationService } from "../src/modules/messaging/message-automation.js";
import { MessageEventService } from "../src/modules/messaging/message-events.js";
import { MockMessageChannelProvider } from "../src/modules/messaging/message-channel-provider.js";

/**
 * 最小闭环端到端：客户消息进来 → Chatflow 引擎生成回复 → 通道发出 → 落库。
 * 使用与生产完全相同的 MessageAutomationService 与表结构，只把 Dify 换成本地引擎。
 */
describe("minimal closed loop with the restored chatflow", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup() {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database);
    db = database;
    const events = new MessageEventService(database, { webhookSecret: "loop-test-secret" });
    const dify = new ChatflowDifyProvider({ now: () => 1_700_000_000_000 });
    const channel = new MockMessageChannelProvider();
    const automation = new MessageAutomationService(database, events, dify, channel);
    database
      .prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?)")
      .run("loop-device", "enabled", JSON.stringify({ device_code: "dev-loop" }));
    return { database, automation, dify };
  }

  it("drives a candidate from greeting to salary and persists every step", async () => {
    const { database, automation, dify } = setup();

    // 第 1 轮：客户打招呼 → 应追问所在区
    const first = await automation.handleInbound({
      eventId: "evt-loop-1",
      deviceCode: "dev-loop",
      customerId: 9001,
      content: "你好",
    });
    expect(first.reply_status).toBe("simulated");

    const outbound1 = database
      .prepare("SELECT content FROM agent_messages WHERE customer_id=9001 AND direction='outbound' ORDER BY id DESC LIMIT 1")
      .get() as { content: string };
    expect(outbound1.content).toContain("哪个区");

    const conv1 = database
      .prepare("SELECT external_conversation_id FROM agent_conversations WHERE customer_id=9001")
      .get() as { external_conversation_id: string };
    expect(conv1.external_conversation_id).toBeTruthy();

    // 第 2 轮：给出城市 → 应追问区县
    await automation.handleInbound({
      eventId: "evt-loop-2",
      deviceCode: "dev-loop",
      customerId: 9001,
      content: "东莞",
    });

    // 第 3 轮：给出区县 → 应追问年龄性别
    await automation.handleInbound({
      eventId: "evt-loop-3",
      deviceCode: "dev-loop",
      customerId: 9001,
      content: "清溪镇",
    });
    const outbound3 = database
      .prepare("SELECT content FROM agent_messages WHERE customer_id=9001 AND direction='outbound' ORDER BY id DESC LIMIT 1")
      .get() as { content: string };
    expect(outbound3.content).toContain("多大了");

    // 第 4 轮：补齐年龄性别 → 应发薪资并推进流程
    const last = await automation.handleInbound({
      eventId: "evt-loop-4",
      deviceCode: "dev-loop",
      customerId: 9001,
      content: "25岁 男",
    });
    expect(last.reply_status).toBe("simulated");

    const outbound4 = database
      .prepare("SELECT content FROM agent_messages WHERE customer_id=9001 AND direction='outbound' ORDER BY id DESC LIMIT 1")
      .get() as { content: string };
    // 清溪匹配到「新造物东莞玩具厂」，薪资详情原文来自该厂数据块
    expect(outbound4.content).toContain("这是岗位的工作内容、薪资待遇");
    // 隐藏标记绝不能出现在发给客户的文本里
    expect(outbound4.content).not.toContain("##MATCHED");
    expect(outbound4.content).not.toContain("##FLOW_DONE");

    // 状态机已推进到流程二
    const conv2 = database
      .prepare("SELECT external_conversation_id FROM agent_conversations WHERE customer_id=9001")
      .get() as { external_conversation_id: string };
    const state = parseState(dify.exportState(conv2.external_conversation_id));
    expect(state.current_city).toBe("东莞");
    expect(state.current_district).toBe("清溪");
    expect(state.matched_factory).toBe("新造物东莞玩具厂");
    expect(state.flow_step).toBe(2);

    // 四轮 inbound 全部落库
    const inboundCount = database
      .prepare("SELECT COUNT(*) count FROM agent_messages WHERE customer_id=9001 AND direction='inbound'")
      .get() as { count: number };
    expect(inboundCount.count).toBe(4);

    // delivery 全部成功
    const succeeded = database
      .prepare("SELECT COUNT(*) count FROM message_deliveries WHERE customer_id=9001 AND status='succeeded'")
      .get() as { count: number };
    expect(succeeded.count).toBe(4);
  });

  it("respects human takeover and never calls the engine while a recruiter holds the chat", async () => {
    const { database, automation } = setup();
    await automation.handleInbound({ eventId: "evt-t-1", deviceCode: "dev-loop", customerId: 9001, content: "你好" });
    database.prepare("UPDATE agent_conversations SET takeover=1 WHERE customer_id=9001").run();

    const result = await automation.handleInbound({
      eventId: "evt-t-2",
      deviceCode: "dev-loop",
      customerId: 9001,
      content: "在东莞",
    });
    expect(result.reply_status).toBe("human_takeover");

    const outbound = database
      .prepare("SELECT COUNT(*) count FROM agent_messages WHERE customer_id=9001 AND direction='outbound'")
      .get() as { count: number };
    expect(outbound.count).toBe(1); // 只有第一轮的回复，接管后不再自动回
  });

  it("is idempotent when the same event is delivered twice", async () => {
    const { database, automation } = setup();
    await automation.handleInbound({ eventId: "evt-dup", deviceCode: "dev-loop", customerId: 9001, content: "你好" });
    const again = await automation.handleInbound({
      eventId: "evt-dup",
      deviceCode: "dev-loop",
      customerId: 9001,
      content: "你好",
    });
    expect(again.status).toBe("duplicate");

    const outbound = database
      .prepare("SELECT COUNT(*) count FROM agent_messages WHERE customer_id=9001 AND direction='outbound'")
      .get() as { count: number };
    expect(outbound.count).toBe(1);
  });
});

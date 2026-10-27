import { describe, expect, it } from "vitest";
import {
  ChatflowDifyProvider,
  extractProfile,
  generateFlowOneReply,
  matchFactory,
  parseAgeRange,
} from "../src/modules/dify/chatflow-engine.js";
import {
  applyMarkers,
  emptyState,
  extractMarkers,
  parseState,
  splitBubbles,
  stripMarkers,
  type HualinState,
} from "../src/modules/dify/chatflow-state.js";

/** 与抓包 dify-turn3/4/5 一致的合成对话序列，不含真实候选人数据。 */
const CAPTURED_TURNS = ["hello2", "dongguan ok", "haoyake", "qingxizhen"];

describe("chatflow-state", () => {
  it("falls back to the initial state on corrupt JSON instead of throwing", () => {
    expect(parseState("{not json")).toEqual(emptyState());
    expect(parseState(null)).toEqual({ flow_step: 1, switched_factories: [] });
  });

  it("keeps unknown-valued fields out while preserving known ones", () => {
    const state = parseState('{"flow_step":2,"switched_factories":["a",3],"current_city":"东莞","seeker_age":25}');
    expect(state.flow_step).toBe(2);
    expect(state.switched_factories).toEqual(["a"]);
    expect(state.current_city).toBe("东莞");
    // 数字型年龄不是字符串，按原实现的容错策略丢弃
    expect(state.seeker_age).toBeUndefined();
  });

  it("advances flow_step only when FLOW_DONE is present", () => {
    const base: HualinState = { flow_step: 1, switched_factories: [] };
    const withoutDone = applyMarkers(base, extractMarkers("清溪镇那边啊##CITY:东莞## ##DISTRICT:清溪镇##"));
    expect(withoutDone.flow_step).toBe(1);
    expect(withoutDone.current_district).toBe("清溪镇");

    const withDone = applyMarkers(base, extractMarkers("薪资…##MATCHED:东莞鑫联达####FLOW_DONE##"));
    expect(withDone.flow_step).toBe(2);
    expect(withDone.matched_factory).toBe("东莞鑫联达");
  });

  it("does not mutate the input state", () => {
    const base: HualinState = { flow_step: 1, switched_factories: [] };
    applyMarkers(base, extractMarkers("##CITY:东莞##"));
    expect(base.current_city).toBeUndefined();
  });

  it("strips every marker so nothing leaks into the visible message", () => {
    const raw =
      "你好##CITY:东莞## ##DISTRICT:清溪镇## ##AGE:25## ##GENDER:男## ##MATCHED:东莞鑫联达## ##FLOW_DONE## ##TYPE_2##";
    const visible = stripMarkers(raw);
    expect(visible).toBe("你好");
    expect(visible).not.toMatch(/##/);
  });

  it("splits bubbles on the ### delimiter captured from the target", () => {
    expect(splitBubbles("正式工：底薪2520###这是岗位的工作内容…")).toEqual([
      "正式工：底薪2520",
      "这是岗位的工作内容…",
    ]);
    expect(splitBubbles("单条消息")).toEqual(["单条消息"]);
  });
});

describe("extractProfile", () => {
  it("recognises a district and derives its city", () => {
    // 2026-10-27 抓包里该区县的标准写法是「清溪」，用户口语常说「清溪镇」
    expect(extractProfile("我在清溪镇")).toMatchObject({ district: "清溪", city: "东莞" });
    expect(extractProfile("我在清溪")).toMatchObject({ district: "清溪", city: "东莞" });
  });

  it("recognises a bare city", () => {
    expect(extractProfile("东莞")).toMatchObject({ city: "东莞" });
    expect(extractProfile("东莞").district).toBeUndefined();
  });

  it("extracts age with and without the 岁 suffix", () => {
    expect(extractProfile("25岁 男").age).toBe("25");
    expect(extractProfile("25，男的").age).toBe("25");
  });

  it("does not mistake an out-of-range number for an age", () => {
    expect(extractProfile("我要找6000以上的").age).toBeUndefined();
  });

  it("extracts gender", () => {
    expect(extractProfile("我是女生").gender).toBe("女");
    expect(extractProfile("男生").gender).toBe("男");
  });

  it("returns nothing from an unrelated utterance", () => {
    expect(extractProfile("你好")).toEqual({});
  });
});

describe("matchFactory", () => {
  it("returns null without a city", () => {
    expect(matchFactory({ flow_step: 1, switched_factories: [] })).toBeNull();
  });

  it("prefers the same district when eligible", () => {
    const factory = matchFactory({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "清溪",
      seeker_age: "25",
      seeker_gender: "男",
    });
    // 2026-10-27 抓包核实：清溪的「新造物东莞玩具厂」是性别不限、18-50 岁
    expect(factory?.factory).toBe("新造物东莞玩具厂");
  });

  it("honours the gender requirement", () => {
    // 大朗的「东莞市胜创光电科技有限公司」仅招女；男性应回落到同城其他可选厂
    const maleInDalang = matchFactory({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "大朗",
      seeker_age: "25",
      seeker_gender: "男",
    });
    expect(maleInDalang?.factory).not.toBe("东莞市胜创光电科技有限公司");

    const femaleInDalang = matchFactory({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "大朗",
      seeker_age: "25",
      seeker_gender: "女",
    });
    expect(femaleInDalang?.factory).toBe("东莞市胜创光电科技有限公司");
  });

  it("returns null when no factory in the city accepts the candidate", () => {
    // 东莞在招厂的年龄上限都 ≤50，55 岁在同城无岗可推 → 走【同城无符合条件】分支
    const factory = matchFactory({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "清溪",
      seeker_age: "55",
      seeker_gender: "男",
    });
    expect(factory).toBeNull();
  });

  it("never matches across cities", () => {
    const factory = matchFactory({
      flow_step: 1,
      switched_factories: [],
      current_city: "厦门",
      current_district: "同安区",
      seeker_age: "25",
      seeker_gender: "男",
    });
    expect(factory?.city).toBe("厦门");
  });

  it("parses age ranges", () => {
    expect(parseAgeRange("16-45周岁")).toEqual({ min: 16, max: 45 });
    expect(parseAgeRange("18-45岁")).toEqual({ min: 18, max: 45 });
    expect(parseAgeRange("不限")).toBeNull();
  });
});

describe("generateFlowOneReply", () => {
  it("asks for the district when nothing is known", () => {
    expect(generateFlowOneReply(emptyState())).toContain("你现在在哪个区呢");
  });

  it("asks for the district within a known city", () => {
    const reply = generateFlowOneReply({ flow_step: 1, switched_factories: [], current_city: "东莞" });
    expect(reply).toContain("哪个镇或者哪个区");
  });

  it("asks for age and gender once the district is known", () => {
    const reply = generateFlowOneReply({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "清溪镇",
    });
    expect(reply).toContain("多大了");
    expect(reply).toContain("男生还是女生");
  });

  it("asks only for the missing item when one is known", () => {
    const reply = generateFlowOneReply({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "清溪镇",
      seeker_age: "25",
    });
    expect(reply).toContain("男生还是女生");
    expect(reply).not.toContain("多大了");
  });

  it("emits salary, MATCHED and FLOW_DONE once the profile is complete", () => {
    const reply = generateFlowOneReply({
      flow_step: 1,
      switched_factories: [],
      current_city: "东莞",
      current_district: "清溪镇",
      seeker_age: "25",
      seeker_gender: "男",
    });
    expect(reply).toContain("##MATCHED:东莞鑫联达##");
    expect(reply).toContain("##FLOW_DONE##");
    expect(reply).toContain("###");
    expect(reply).toContain("底薪2520");
  });
});

describe("ChatflowDifyProvider", () => {
  it("replays the captured conversation and reaches flow_step 2 with a matched factory", async () => {
    const provider = new ChatflowDifyProvider({ now: () => 1_700_000_000_000 });
    let conversationId: string | undefined;
    const replies: string[] = [];

    for (const query of CAPTURED_TURNS) {
      const result = await provider.sendMessage({
        baseUrl: "chatflow://local",
        apiKey: "",
        user: "candidate-1",
        query,
        ...(conversationId ? { conversationId } : {}),
      });
      expect(result.success).toBe(true);
      conversationId = result.conversation_id;
      replies.push(result.message ?? "");
    }

    // 前几轮都在收集信息，没有发薪资
    expect(replies[0]).toContain("哪个区");
    expect(replies[1]).toContain("哪个镇或者哪个区");

    const state = parseState(provider.exportState(conversationId!));
    expect(state.current_city).toBe("东莞");
    expect(state.current_district).toBe("清溪镇");
    expect(state.flow_step).toBe(1); // 尚未收齐年龄性别，不应推进

    // 补齐年龄性别后应完成匹配并推进流程
    const final = await provider.sendMessage({
      baseUrl: "chatflow://local",
      apiKey: "",
      user: "candidate-1",
      query: "25岁，男的",
      conversationId,
    });
    expect(final.success).toBe(true);
    const finalState = parseState(provider.exportState(conversationId!));
    expect(finalState.seeker_age).toBe("25");
    expect(finalState.seeker_gender).toBe("男");
    expect(finalState.matched_factory).toBe("东莞鑫联达");
    expect(finalState.flow_step).toBe(2);
    // 标记必须全部剥离；### 是合法的气泡分隔符，不算残留
    expect(final.message).not.toMatch(/##(?:CITY|DISTRICT|AGE|GENDER|MATCHED|FLOW_DONE|TYPE_2)[: ]/);
  });

  it("keeps separate conversations isolated", async () => {
    const provider = new ChatflowDifyProvider({ now: () => 1 });
    const a = await provider.sendMessage({ baseUrl: "x", apiKey: "", user: "a", query: "我在佛山" });
    const b = await provider.sendMessage({ baseUrl: "x", apiKey: "", user: "b", query: "我在厦门" });
    expect(parseState(provider.exportState(a.conversation_id!)).current_city).toBe("佛山");
    expect(parseState(provider.exportState(b.conversation_id!)).current_city).toBe("厦门");
  });

  it("accumulates history in the format observed in the capture", async () => {
    const provider = new ChatflowDifyProvider({ now: () => 1 });
    const first = await provider.sendMessage({ baseUrl: "x", apiKey: "", user: "h", query: "你好" });
    await provider.sendMessage({
      baseUrl: "x",
      apiKey: "",
      user: "h",
      query: "东莞",
      conversationId: first.conversation_id,
    });
    const history = provider.exportHistory(first.conversation_id!);
    expect(history).toContain("应聘者：你好");
    expect(history).toContain("回复：");
    expect(history).toContain("应聘者：东莞");
  });

  it("returns bubbles split on ### so the channel can send separate messages", async () => {
    const provider = new ChatflowDifyProvider({ now: () => 1 });
    const greeting = await provider.sendMessage({ baseUrl: "x", apiKey: "", user: "s", query: "你好" });
    // 抓包 answer 为「你好呀～###你现在在哪个区呢？…」，客户端据此拆成两条
    expect(greeting.bubbles).toEqual(["你好呀～", "你现在在哪个区呢？等会发详细的给你看看"]);
    expect(greeting.message).toBe("你好呀～###你现在在哪个区呢？等会发详细的给你看看");
  });

  it("rejects an empty query", async () => {
    const provider = new ChatflowDifyProvider();
    const result = await provider.sendMessage({ baseUrl: "x", apiKey: "", user: "e", query: "   " });
    expect(result.success).toBe(false);
  });

  it("reports healthy without any network call", async () => {
    const provider = new ChatflowDifyProvider();
    await expect(provider.healthCheck()).resolves.toEqual({ healthy: true, latency_ms: 0 });
  });
});

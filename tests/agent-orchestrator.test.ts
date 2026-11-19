import { describe, expect, it } from "vitest";
import {
  buildOrchestration,
  mergeArchive,
  parseScripts,
  type ArchiveRecord,
} from "../src/modules/agent/agent-orchestrator.js";

// 编排层：话术库解析、prompt 拼装、档案合并。纯函数，不碰网络。
// 代码级护栏（guardScript/guardMoney）已于 2026-11-17 按运营决定拆除：
// 话术约束走 prompt，相信模型。
describe("agent orchestrator", () => {
  const PERSONA = `你是深圳地铁安检的招工人员。

# 回复规则
1. 命中话术库就用原文。

# 话术库（命中就发原文，数字不许改）

[S1 外宿人员嫌弃面试地址远]
面试地址是可以直达的，面试好分岗分线路分发制服。
总基地你只需要过来一次即可。

[S2 工资待遇不清晰/嫌低]
早班7-15 夜班15-22.40
咱们是转正175/班5-6小时 350/天9-10小时
额外还有高峰补贴30-43.7/次 上班就有

[S3 连班时间长]
月休4-6天，两个班实际在岗时间也才10到12个小时。`;

  it("parseScripts 把人设里的 [Sx] 段落解析成话术库", () => {
    const scripts = parseScripts(PERSONA);
    expect(scripts.map((script) => script.id)).toEqual(["S1", "S2", "S3"]);
    expect(scripts[0].title).toBe("外宿人员嫌弃面试地址远");
    expect(scripts[1].content).toContain("175/班");
    // 人设正文里的话术段落不留在开头：它已经进了话术库，避免喂两遍
    const { messages } = buildOrchestration({ persona: PERSONA, facts: {}, history: [], input: "你好" });
    expect(messages[0].content.startsWith("你是深圳地铁安检的招工人员。")).toBe(true);
    // 话术段落只出现在「话术库」区，人设开头的正文里不能再带一份
    const headBeforeScript = messages[0].content.split("# 话术库")[0];
    expect(headBeforeScript).not.toContain("[S1");
    expect(headBeforeScript).not.toContain("175/班");
  });

  it("buildOrchestration 按无状态多轮拼接：system + 历史 + 当前句", () => {
    const { messages, scripts } = buildOrchestration({
      persona: PERSONA,
      facts: { wage_text: "160/班" },
      history: [
        { role: "customer", text: "多少钱" },
        { role: "agent", text: "160 一班" },
      ],
      input: "有夜班吗",
    });
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("160/班");
    expect(messages[0].content).toContain("[S1 外宿人员嫌弃面试地址远]");
    expect(messages[1]).toEqual({ role: "user", content: "多少钱" });
    // assistant 历史装回 JSON 信封：与输出格式一致，模型不会从第 2 轮
    // 开始模仿纯文本、丢掉 JSON 输出（2026-11-17 真调复现过）。
    expect(messages[2].role).toBe("assistant");
    const assistantEnvelope = JSON.parse(messages[2].content) as { messages?: Array<{ type?: string; content?: string }> };
    expect(assistantEnvelope.messages?.[0]).toEqual({ type: "text", content: "160 一班" });
    expect(messages[3]).toEqual({ role: "user", content: "有夜班吗" });
    expect(scripts).toHaveLength(3);
  });

  it("prompt 不再要求 script_used 声明：护栏拆除后由模型自由引用原文", () => {
    const { messages } = buildOrchestration({ persona: PERSONA, facts: {}, history: [], input: "工资多少" });
    // 输出规范里不应再出现 script_used
    expect(messages[0].content).not.toContain("script_used");
    // 话术使用规则仍在：命中就引用原文，数字不改
    expect(messages[0].content).toContain("用该类原文回答");
  });

  it("sentSummary 只注入真实已发送内容，并要求模型避免整段复述", () => {
    const { messages } = buildOrchestration({
      persona: PERSONA,
      facts: { wage_text: "160/班" },
      history: [],
      sentSummary: ["招聘要求：18-45 岁", "薪资：160/班"],
      opening: [{kind:"text",content:"这段从未真正发送过"}],
      input: "工资多少",
    });
    expect(messages.some((message) => message.content.includes("已经发送过的流程内容"))).toBe(true);
    expect(messages.find((message) => message.content.includes("已经发送过的流程内容"))?.content).toContain("不要把整段再次复述");
    expect(messages.some(message => message.content.includes("这段从未真正发送过"))).toBe(false);
  });

  it("system 注入今天日期与 interview 规范：面试档案由模型判断，无硬提取", () => {
    const { messages } = buildOrchestration({
      persona: PERSONA,
      facts: {},
      now: "2026年11月17日 星期二",
      history: [],
      input: "明天能面试吗",
    });
    const system = messages[0].content;
    expect(system).toContain("2026年11月17日");
    // interview 字段进入输出规范，且明确「换算具体日期、默认上午10点、改时间覆盖」
    expect(system).toContain('"interview":{"date":"","time":"","confirmed":false}');
    expect(system).toContain("YYYY-MM-DD");
    expect(system).toContain("默认上午 10:00");
    expect(system).toContain("X月X日上午10点");
  });

  it("mergeArchive：非空才覆盖，改时间覆盖旧约定，没提就保留", () => {
    const existing: ArchiveRecord = {
      name: "王五",
      phone: "13711112222",
      city: "深圳",
      interview_date: "2026-11-18",
      interview_time: "10:00",
      interview_confirmed: true,
    };
    // 客户改时间：新 date/time 覆盖，姓名电话保留
    const changed = mergeArchive(existing, {}, { date: "2026-11-19", time: "14:00", confirmed: true });
    expect(changed).toEqual({
      name: "王五",
      phone: "13711112222",
      city: "深圳",
      interview_date: "2026-11-19",
      interview_time: "14:00",
      interview_confirmed: true,
    });
    // 只聊天没提面试：旧约定原样保留
    const untouched = mergeArchive(existing, {}, {});
    expect(untouched.interview_date).toBe("2026-11-18");
    // 新档案：capture 与 interview 直接写入
    const fresh = mergeArchive(
      null,
      { name: "李四", phone: "13912345678", city: "东莞" },
      { date: "2026-11-20", time: "10:00", confirmed: true },
    );
    expect(fresh.name).toBe("李四");
    expect(fresh.interview_date).toBe("2026-11-20");
    expect(fresh.interview_confirmed).toBe(true);
  });
});

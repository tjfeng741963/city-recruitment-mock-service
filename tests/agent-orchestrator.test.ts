import { describe, expect, it } from "vitest";
import {
  buildOrchestration,
  guardMoney,
  guardScript,
  parseScripts,
} from "../src/modules/agent/agent-orchestrator.js";

// 受控编排层：话术库解析、prompt 拼装、两条护栏。这些是纯函数，不碰网络。
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
    expect(messages[2]).toEqual({ role: "assistant", content: "160 一班" });
    expect(messages[3]).toEqual({ role: "user", content: "有夜班吗" });
    expect(scripts).toHaveLength(3);
  });

  it("guardScript：模型说用了 S2 但输出跑偏 → 整条替换回原文", () => {
    const scripts = parseScripts(PERSONA);
    const modelOutput = [{ type: "text", content: "我觉得这个工资还行啦，你要不要再考虑一下？" }];
    const guarded = guardScript(modelOutput, "S2", scripts);
    expect(guarded.replaced).toBe(true);
    // 替换后的内容必须来自原文，不能是模型自己的转述
    const joined = guarded.messages.map((item) => item.content).join("\n");
    expect(joined).toContain("175/班");
    expect(joined).not.toContain("考虑一下");
  });

  it("guardScript：输出确实来自原文 → 放行", () => {
    const scripts = parseScripts(PERSONA);
    const fromScript = [{ type: "text", content: "咱们是转正175/班5-6小时 350/天9-10小时，还有高峰补贴。" }];
    const guarded = guardScript(fromScript, "S2", scripts);
    expect(guarded.replaced).toBe(false);
    expect(guarded.messages).toEqual(fromScript);
  });

  it("guardScript：script_used 为空时不干预，自拟回复原样通过", () => {
    const scripts = parseScripts(PERSONA);
    const free = [{ type: "text", content: "这个我确认一下，稍后回你。" }];
    expect(guardScript(free, null, scripts)).toEqual({ messages: free, replaced: false });
  });

  it("guardMoney：事实里没有的工价直接拦下", () => {
    const facts = { wage_text: "160/班" };
    expect(guardMoney([{ type: "text", content: "这边是 180/小时" }], facts)).toContain("180");
    expect(guardMoney([{ type: "text", content: "这边是 160/班" }], facts)).toBeNull();
    expect(guardMoney([{ type: "text", content: "这里没有数字" }], facts)).toBeNull();
  });
});

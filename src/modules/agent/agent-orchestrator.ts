/**
 * Agent 编排层（受控多智能体的第一步）。
 *
 * 职责拆成两层，每层都可以单独测试、单独替换成独立的模型调用
 * （真正的多智能体）：
 *
 *   1. parseScripts        —— 从人设里解析 [S1 标题] 话术段落
 *   2. buildOrchestration  —— 组装：人设 + 事实 + 话术库 + 全量历史 → messages
 *
 * 模型输出不做代码级护栏（2026-11-17 按运营决定拆除 guardScript /
 * guardMoney）：话术库以 prompt 约束注入，相信模型按原文回答。
 * parseScripts 的结果仍随 /agent/chat 返回，供调试台展示话术库清单。
 *
 * 多轮对话：DeepSeek /chat/completions 是无状态的，历史按
 * user → assistant → user 的顺序全量拼接，每轮把上一轮 assistant 的输出
 * append 回 messages 末尾（DeepSeek 官方多轮对话指南的约定）。
 */

export type ScriptEntry = { id: string; title: string; content: string };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** 从人设里解析 [S1 标题] … 正文 的段落，形成受控话术库。 */
export function parseScripts(persona: string): ScriptEntry[] {
  const scripts: ScriptEntry[] = [];
  const pattern = /\[S(\d+)\s*([^\]]*)\]\s*\n([\s\S]*?)(?=\n\[S\d+\s|\s*$)/g;
  let match = pattern.exec(persona || "");
  while (match) {
    const content = match[3].trim();
    if (content) {
      scripts.push({ id: `S${match[1]}`, title: match[2].trim(), content });
    }
    match = pattern.exec(persona || "");
  }
  return scripts;
}

function factsText(facts: Record<string, string>): string {
  const labels: Array<[string, string]> = [
    ["city", "城市"],
    ["factory_name", "厂名"],
    ["job_title", "岗位"],
    ["wage_text", "工价"],
    ["hours_text", "班次"],
    ["age_text", "年龄要求"],
    ["welfare_text", "福利"],
    ["place", "工作地点"],
    ["interview_time", "面试时间"],
    ["height_text", "身高要求"],
    ["tattoo_policy", "纹身要求"],
    ["cert_text", "证件与学历"],
    ["job_content", "工作内容"],
  ];
  const lines = labels
    .filter(([key]) => facts[key])
    .map(([key, label]) => `- ${label}：${facts[key]}`);
  return lines.length ? lines.join("\n") : "（这个岗位还没有填事实，任何数字都不要说）";
}

const OUTPUT_SPEC = `# 输出格式（必须是 JSON，不要代码块，不要解释）
{"messages":[{"type":"text","content":"发给客户的一句话"}],"capture":{"name":"","phone":"","city":"","day":""},"handoff":false,"done":false}

# 硬规则
- 历史里的 assistant 消息是之前轮次的 JSON 输出（content 是当时发给客户的文案）；你每一轮只输出一个新 JSON，不要复述历史、不要模仿纯文本
- messages 里可以有多条：先回一句话，再补一条图片或视频（type=image/video，name 填素材文件名）；没有素材就不要输出
- 客户话题与话术库某一类大致相似 → 用该类原文回答（可挑最相关的段落，数字不改）
- 话术库里对不上的 → 自己回答，但数字只能来自岗位事实
- 不确定的事说「这个我确认一下」，不要编
- 客户明确说不来了 → done=true，回一句客气收尾；需要人工接手 → handoff=true`;

/** 组装一轮编排：system(人设+事实+话术库+规则) + 全量历史 + 当前这句。 */
export function buildOrchestration(options: {
  persona: string;
  facts: Record<string, string>;
  history: Array<{ role: string; text: string }>;
  input: string;
}): { messages: ChatMessage[]; scripts: ScriptEntry[] } {
  const scripts = parseScripts(options.persona);
  const scriptSection = scripts.length
    ? [
        "# 话术库（命中就发原文，数字不许改）",
        ...scripts.map((script) => `[${script.id} ${script.title}]\n${script.content}`),
        "",
        "# 话术使用规则",
        "- 客户话题与某类话术大致相似 → 用该类原文回答（可挑最相关的段落，数字不改）",
        "- 对不上的 → 自己回答，但数字只能来自岗位事实",
      ].join("\n")
    : "# 话术库\n（这个岗位的人设里还没有 [S1 标题] 格式的话术段落，全部自拟，数字只能来自事实）";

  const system = [
    options.persona.replace(/\[S\d+\s*[^\]]*\][\s\S]*$/g, "").trim() ||
      "你是一家劳务中介的招聘顾问。",
    "",
    "# 岗位事实（这一轮唯一允许使用的数字来源）",
    factsText(options.facts),
    "",
    scriptSection,
    "",
    OUTPUT_SPEC,
  ].join("\n");

  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const item of options.history) {
    const content = String(item.text || "").trim();
    if (!content) continue;
    const isAgent = String(item.role) === "agent";
    messages.push({
      role: isAgent ? "assistant" : "user",
      // assistant 历史按上一轮的 JSON 原样回填（DeepSeek 多轮指南：把上一轮
      // assistant 输出 append 回 messages 末尾）。客户端手里只有发出去的文案，
      // 所以由编排层重新装回 JSON 信封——格式一致，模型才不会从第 2 轮开始
      // 模仿纯文本、丢掉 JSON 输出（2026-11-17 真调复现过 5/16 轮）。
      content: isAgent ? JSON.stringify({ messages: [{ type: "text", content }] }) : content,
    });
  }
  messages.push({ role: "user", content: options.input });
  return { messages, scripts };
}

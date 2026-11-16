/**
 * Agent 编排层（受控多智能体的第一步）。
 *
 * 参考 deepseek-harness 的「管理与可控」：模型不自由发挥，职责被拆成三层，
 * 每一层都可以单独测试、单独替换成独立的模型调用（真正的多智能体）：
 *
 *   1. buildOrchestration  —— 组装：人设 + 事实 + 话术库 + 全量历史 → messages
 *   2. （模型调用在 routes 层，本模块不管网络）
 *   3. guardReply          —— 回执护栏：
 *      a. script_used 命中话术类 → 校验模型输出确实来自原文，跑偏就整条替换回原文
 *      b. 金额校验 → 数字必须能在事实里找到
 *
 * 为什么话术库放在 system 而不是单独一次「路由」调用：客户在等回复，
 * 两次串行调用延迟翻倍；DeepSeek flash 单次 1~2 秒，先把「选话术 + 生成」
 * 合在一次调用里，靠 script_used + 原文比对保住「可控」。以后延迟预算宽了，
 * Router 可以拆成独立的小模型（本文件的函数边界就是为那一天留的）。
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
{"messages":[{"type":"text","content":"发给客户的一句话"}],"capture":{"name":"","phone":"","city":"","day":""},"script_used":null,"handoff":false,"done":false}

# 硬规则
- messages 里可以有多条：先回一句话，再补一条图片或视频（type=image/video，name 填素材文件名）；没有素材就不要输出
- 客户话题与话术库某一类大致相似 → 用该类原文回答（可挑最相关的段落），script_used 填该编号，例如 "S2"
- 话术库里对不上的 → script_used 填 null，自己回答，但数字只能来自岗位事实
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
        "- 客户话题与某类话术大致相似 → 用该类原文回答（可挑最相关的段落，数字不改），script_used 填该编号",
        "- 对不上的 → script_used 填 null，自己回答，但数字只能来自岗位事实",
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
    messages.push({
      role: String(item.role) === "agent" ? "assistant" : "user",
      content,
    });
  }
  messages.push({ role: "user", content: options.input });
  return { messages, scripts };
}

/** 去掉空白与标点，做话术相似度比对用。 */
function normalize(text: string): string {
  return String(text || "").replace(/[\s，,。.、;；:：!！?？'"「」【】\[\]（）()]/g, "");
}

/** 金额护栏：回复文本里出现的钱数必须能在事实里找到。 */
export function guardMoney(messages: Array<{ type: string; content?: string }>, facts: Record<string, string>): string | null {
  const prose = messages
    .filter((item) => item.type === "text")
    .map((item) => String(item.content || ""))
    .join("\n");
  const allowed = Object.values(facts).join(" ").replace(/\s+/g, "");
  const patterns = [/(\d+(?:\.\d+)?)\s*元/g, /(\d+(?:\.\d+)?)\s*\/\s*(?:小时|时|天|月|班)/g];
  for (const pattern of patterns) {
    let match = pattern.exec(prose);
    while (match) {
      if (!allowed.includes(match[1])) return `回复里的「${match[0]}」不在岗位事实里`;
      match = pattern.exec(prose);
    }
  }
  return null;
}

/**
 * 话术护栏：script_used 命中时，模型输出必须真的来自那一类原文；
 * 跑偏了（模型自己编了一版）就整条替换回原文——原文比模型的转述更可信。
 */
export function guardScript<T extends { type: string; content?: string }>(
  messages: T[],
  scriptUsed: unknown,
  scripts: ScriptEntry[],
): { messages: (T | { type: string; content: string })[]; replaced: boolean } {
  if (typeof scriptUsed !== "string" || !scriptUsed) return { messages, replaced: false };
  const script = scripts.find((entry) => entry.id === scriptUsed.trim().toUpperCase());
  if (!script) return { messages, replaced: false };

  const output = messages
    .filter((item) => item.type === "text")
    .map((item) => normalize(String(item.content || "")))
    .join("\n");
  if (!output) return { messages, replaced: false };

  // 原文按行分段；输出里命中任意一段的相当部分，就算「用了原文」。
  const segments = script.content
    .split(/\n+/)
    .map((line) => normalize(line))
    .filter((line) => line.length >= 8);
  const matched = segments.some((segment) => {
    const head = segment.slice(0, Math.min(14, segment.length));
    return output.includes(head);
  });
  if (matched) return { messages, replaced: false };

  // 跑偏了：整条替换回原文。原文按行拆成多条，与运营分条发送的习惯一致。
  const original = script.content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: "text", content: line }));
  return { messages: original, replaced: true };
}

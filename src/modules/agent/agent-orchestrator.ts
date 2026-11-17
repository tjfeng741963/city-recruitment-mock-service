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
{"messages":[{"type":"text","content":"发给客户的一句话"}],"capture":{"name":"","phone":"","city":""},"interview":{"date":"","time":"","confirmed":false},"handoff":false,"done":false}

# 硬规则
- 历史里的 assistant 消息是之前轮次的 JSON 输出（content 是当时发给客户的文案）；你每一轮只输出一个新 JSON，不要复述历史、不要模仿纯文本
- messages 里可以有多条：先回一句话，再补一条图片或视频（type=image/video，name 填素材文件名）；没有素材就不要输出
- 客户说「没收到图/视频/照片」→ 把对应的媒体条目再输出一次（name 用历史里出现过的素材文件名），并配一句「重新发你了，往上翻看一下」；系统会真实重发，不要只嘴上说发了
- 媒体分两层：工作内容图、安检视频、宿舍图是通用素材（所有岗位一样，客户想看就发）；面试地点图是岗位专属的——本岗位绑定了哪张，事实卡「面试地点图」字段里写着名字（interview_address_image），客户问「怎么走/在哪面试/发个位置图」时才发它，name 只能填事实卡里那个名字；事实卡没写就说明本岗位没有地点图，用文字把地址讲清楚，不要编造图片名字
- 客户话题与话术库某一类大致相似 → 用该类原文回答（可挑最相关的段落，数字不改）
- 话术库里对不上的 → 自己回答，但数字只能来自岗位事实
- 不确定的事说「这个我确认一下」，不要编
- 客户明确说不来了 → done=true，回一句客气收尾；需要人工接手 → handoff=true

# interview 字段（面试档案，由你判断，系统不做任何抽取）
- 双方定下面试时间才填：date 用 YYYY-MM-DD（客户说「明天/后天」时，按上面的今天日期换算成具体几月几号）；time 用 24 小时制 HH:MM，客户没指定时段就默认上午 10:00；confirmed=true 表示双方都答应了
- 只是在问、还没定 → interview 填 {"date":"","time":"","confirmed":false}
- 客户改了时间 → 填新的 date/time，系统会覆盖旧档
- 回复文案里提到面试时间，必须说「X月X日上午10点」这样的完整日期+时段，不要只说「明天」——方便客户看清、也方便记录档案`;

/** 开场条目的最小形状（文本带 content，媒体带 media_name）。 */
export type OpeningItem = { kind: string; content?: string | null; media_name?: string | null };

/** 会话/历史条目：customer 带 text；agent 带 reply（上一轮的完整 JSON 输出）。 */
export type DialogueItem = {
  role: string;
  text?: string | null;
  reply?: {
    messages?: Array<{ type?: string; content?: string; name?: string }> | null;
    capture?: Record<string, unknown> | null;
    interview?: Record<string, unknown> | null;
    handoff?: boolean | null;
    done?: boolean | null;
  } | null;
};

/** assistant 历史装回完整 JSON 信封（DeepSeek 多轮指南：append 上一轮原始输出）。
 *
 * 只装 messages 不够——模型会模仿历史格式，第 2 轮起就把 capture/interview
 * 字段丢掉（2026-11-17 真调复现：改时间轮 interview 为空、档案没更新）。
 * 信封必须与输出规范同构，模型才始终输出完整 JSON。 */
function assistantEnvelope(item: {
  messages?: Array<{ type?: string; content?: string; name?: string }> | null;
  capture?: Record<string, unknown> | null;
  interview?: Record<string, unknown> | null;
  handoff?: boolean | null;
  done?: boolean | null;
}): string {
  const messages = (item.messages || [])
    .map((m) => {
      const type = String(m.type || "text");
      return type === "text"
        ? { type, content: String(m.content || "") }
        : { type, name: String(m.name || "") };
    })
    .filter((m) => (m.type === "text" ? m.content : m.name));
  return JSON.stringify({
    messages,
    capture: item.capture && typeof item.capture === "object" ? item.capture : {},
    interview: item.interview && typeof item.interview === "object" ? item.interview : {},
    handoff: Boolean(item.handoff),
    done: Boolean(item.done),
  });
}

/** 组装一轮编排：system(人设+今天日期+事实+话术库+规则) + 开场序列 + 全量历史 + 当前这句。
 *
 * 开场序列作为 assistant 历史注入（2026-11-17）：后续对话的前提是
 * 「开场那串已经发过了」，模型必须知道开场说过什么，才能接住
 * 「你刚发的第二条工资是多少」这类指代。开场是岗位配置，每轮从
 * position_opening 现读，运营改了配置下一轮就生效。
 * now 是今天的日期文本：模型靠它把「明天/后天」换算成具体几月几号
 * 写进 interview 字段，系统不做任何日期抽取。 */
export function buildOrchestration(options: {
  persona: string;
  facts: Record<string, string>;
  opening?: OpeningItem[];
  now?: string;
  history: DialogueItem[];
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
    "# 今天日期（换算「明天/后天」、写 interview.date 都以它为准）",
    options.now || "（未知）",
    "",
    "# 岗位事实（这一轮唯一允许使用的数字来源）",
    factsText(options.facts),
    "",
    scriptSection,
    "",
    OUTPUT_SPEC,
  ].join("\n");

  const messages: ChatMessage[] = [{ role: "system", content: system }];
  // 开场序列按 seq 已序注入：信封与输出规范同构（capture/interview 留空），
  // 模型看到的就是「我自己刚发过这串」。媒体条目也注入，模型才知道发过哪张图哪个视频。
  for (const item of options.opening || []) {
    const kind = String(item.kind || "text");
    if (kind === "text") {
      const content = String(item.content || "").trim();
      if (!content) continue;
      messages.push({
        role: "assistant",
        content: assistantEnvelope({ messages: [{ type: "text", content }] }),
      });
    } else if (kind === "image" || kind === "video") {
      const name = String(item.media_name || "").trim();
      if (!name) continue;
      messages.push({
        role: "assistant",
        content: assistantEnvelope({ messages: [{ type: kind, name }] }),
      });
    }
  }
  for (const item of options.history) {
    if (String(item.role) === "agent") {
      // agent 历史：上一轮完整 JSON 输出原样 append（DeepSeek 多轮约定）；
      // 旧形状 {role,text}（/dev 调试台）退回纯文本信封。
      const reply = item.reply?.messages?.length
        ? item.reply
        : { messages: [{ type: "text", content: String(item.text || "") }] };
      messages.push({ role: "assistant", content: assistantEnvelope(reply) });
      continue;
    }
    const content = String(item.text || "").trim();
    if (!content) continue;
    messages.push({ role: "user", content });
  }
  messages.push({ role: "user", content: options.input });
  return { messages, scripts };
}

/** 档案记录的形状（agent_archive 表一行的镜像）。 */
export type ArchiveRecord = {
  name: string;
  phone: string;
  city: string;
  interview_date: string;
  interview_time: string;
  interview_confirmed: boolean;
};

/** 模型输出里的 interview 字段（无类型约束，逐字段校验）。 */
export type InterviewOutput = { date?: unknown; time?: unknown; confirmed?: unknown };

/**
 * 档案合并：新值非空才覆盖，空值保留旧档——面试者改时间时模型输出新的
 * date/time 直接覆盖；只聊天没提面试时旧约定不动。全部输入来自模型
 * JSON（capture / interview），系统不做任何正则抽取。
 */
export function mergeArchive(
  existing: ArchiveRecord | null,
  capture: { name?: string; phone?: string; city?: string },
  interview: InterviewOutput,
): ArchiveRecord {
  const base: ArchiveRecord = existing ?? {
    name: "",
    phone: "",
    city: "",
    interview_date: "",
    interview_time: "",
    interview_confirmed: false,
  };
  const date = typeof interview.date === "string" ? interview.date.trim() : "";
  const time = typeof interview.time === "string" ? interview.time.trim() : "";
  return {
    name: capture.name?.trim() || base.name,
    phone: capture.phone?.trim() || base.phone,
    city: capture.city?.trim() || base.city,
    interview_date: date || base.interview_date,
    interview_time: time || base.interview_time,
    interview_confirmed:
      interview.confirmed === true ? true : Boolean(date || time) ? Boolean(date && time) : base.interview_confirmed,
  };
}

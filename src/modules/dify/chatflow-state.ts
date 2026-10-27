/**
 * 还原自目标站 Dify Chatflow 的会话状态机。
 *
 * 证据来源：过程文件/dify-turn3|4|5-stream.txt 的 node_finished.process_data/outputs。
 * 原始「看流程是否推进，修改流程」code 节点维护一个 conversation 变量 hualin_state，
 * 结构为 {"flow_step":1,"switched_factories":[],"current_city":"东莞","current_district":"清溪镇",
 *         "matched_factory":"东莞鑫联达","seeker_gender":"男","seeker_age":"25"}。
 * LLM 在回复末尾输出 ##CITY:## ##DISTRICT:## ##AGE:## ##GENDER:## ##MATCHED:## ##FLOW_DONE## 等标记，
 * 该节点剥离标记、写回状态，只把干净文本交给 answer 节点。
 */

export interface HualinState {
  flow_step: number;
  switched_factories: string[];
  current_city?: string;
  current_district?: string;
  matched_factory?: string;
  seeker_gender?: string;
  seeker_age?: string;
  /** 流程二阶段一的交互轮数，满 3 轮才允许提纹身案底（抓包 prompt 硬规则）。 */
  flow2_turns?: number;
  /**
   * 求职者类型。抓包实测：只有 "2"（人在招聘城市之外）会被写入，
   * 一类求职者（本地）不写这个字段。注意不是 ##TYPE_2## 标记——
   * prompt 里写的是标记，实际实现落成了状态字段。
   */
  user_type?: "2";
  /** 纹身案底结论：none=都没有，tattoo=有纹身，record=有案底。 */
  tattoo_record?: "none" | "tattoo" | "record";
  /** 纹身案底已追问的轮数。 */
  tattoo_asks?: number;
  /**
   * 求职者连续回避纹身提问后放弃追问。
   * 抓包实测第 22 轮：系统说「行，那不纠结这个了…你直接过来就行」并转向邀约。
   * 这是 LLM 的判断，prompt 里没有明确规则；此处按观察到的行为近似——
   * 连续 3 轮未正面回答即放弃，进入邀约。
   */
  tattoo_skipped?: boolean;
  /** 流程二阶段三确认下来的面试日期，YYYY-MM-DD。 */
  interview_date?: string;
  /**
   * 是否已发出面试邀约问句（"…可以过来面试吗？"）。
   * 抓包实测第 22 轮：放弃纹身追问后只发邀约问句，不发表单、不推进 flow_step；
   * 直到第 29 轮求职者确认后，才发报名表单并推进到流程三。
   */
  interview_asked?: boolean;
  /** 流程三：报名表单（姓名+电话）是否已收到。 */
  form_received?: boolean;
  /** 流程四：是否已确认到达。 */
  arrived?: boolean;
  /**
   * 联系电话。抓包实测：流程三收到报名表单后写入（第 30 轮出现该字段）。
   * 注意这是 PII，本实现只在会话内存中保留，不落盘、不导出到日志。
   */
  phone?: string;
}

export const INITIAL_STATE: HualinState = {
  flow_step: 1,
  switched_factories: [],
};

export function emptyState(): HualinState {
  return { flow_step: INITIAL_STATE.flow_step, switched_factories: [...INITIAL_STATE.switched_factories] };
}

/** 解析会话变量；损坏的 JSON 回落到初始状态而不是抛错——与原始 code 节点的容错行为一致。 */
export function parseState(raw: string | null | undefined): HualinState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<HualinState>;
    return {
      flow_step: typeof parsed.flow_step === "number" ? parsed.flow_step : INITIAL_STATE.flow_step,
      switched_factories: Array.isArray(parsed.switched_factories)
        ? parsed.switched_factories.filter((x): x is string => typeof x === "string")
        : [],
      ...(typeof parsed.current_city === "string" ? { current_city: parsed.current_city } : {}),
      ...(typeof parsed.current_district === "string" ? { current_district: parsed.current_district } : {}),
      ...(typeof parsed.matched_factory === "string" ? { matched_factory: parsed.matched_factory } : {}),
      ...(typeof parsed.seeker_gender === "string" ? { seeker_gender: parsed.seeker_gender } : {}),
      ...(typeof parsed.seeker_age === "string" ? { seeker_age: parsed.seeker_age } : {}),
      ...(typeof parsed.flow2_turns === "number" ? { flow2_turns: parsed.flow2_turns } : {}),
      ...(parsed.user_type === "2" ? { user_type: "2" as const } : {}),
      ...(parsed.tattoo_record === "none" || parsed.tattoo_record === "tattoo" || parsed.tattoo_record === "record"
        ? { tattoo_record: parsed.tattoo_record }
        : {}),
      ...(typeof parsed.tattoo_asks === "number" ? { tattoo_asks: parsed.tattoo_asks } : {}),
      ...(parsed.tattoo_skipped === true ? { tattoo_skipped: true } : {}),
      ...(typeof parsed.interview_date === "string" ? { interview_date: parsed.interview_date } : {}),
      ...(parsed.form_received === true ? { form_received: true } : {}),
      ...(parsed.arrived === true ? { arrived: true } : {}),
      ...(typeof parsed.phone === "string" ? { phone: parsed.phone } : {}),
    };
  } catch {
    return emptyState();
  }
}

export function serializeState(state: HualinState): string {
  return JSON.stringify(state);
}

export interface ChatflowMarkers {
  city?: string;
  district?: string;
  age?: string;
  gender?: string;
  matched?: string;
  flowDone: boolean;
  type2: boolean;
}

const MARKER_PATTERNS = {
  city: /##CITY:([^#]+)##/,
  district: /##DISTRICT:([^#]+)##/,
  age: /##AGE:(\d+)##/,
  gender: /##GENDER:(男|女)##/,
  matched: /##MATCHED:([^#]+)##/,
} as const;

/** 提取 LLM 回复末尾的隐藏标记。原始实现在「看流程是否推进」节点做同一件事。 */
export function extractMarkers(text: string): ChatflowMarkers {
  const markers: ChatflowMarkers = {
    flowDone: text.includes("##FLOW_DONE##"),
    type2: text.includes("##TYPE_2##"),
  };
  for (const [key, pattern] of Object.entries(MARKER_PATTERNS) as Array<[keyof typeof MARKER_PATTERNS, RegExp]>) {
    const match = text.match(pattern);
    if (match) markers[key] = match[1].trim();
  }
  return markers;
}

/** 剥离全部标记，得到真正发给求职者的文本。 */
export function stripMarkers(text: string): string {
  return text
    .replace(/##CITY:[^#]*##/g, "")
    .replace(/##DISTRICT:[^#]*##/g, "")
    .replace(/##AGE:\d+##/g, "")
    .replace(/##GENDER:(?:男|女)##/g, "")
    .replace(/##MATCHED:[^#]*##/g, "")
    .replace(/##FLOW_DONE##/g, "")
    .replace(/##TYPE_2##/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * 将标记写回状态。返回新对象，不修改入参。
 * flow_step 只在 ##FLOW_DONE## 出现时推进——证据：turn4 回复带 CITY/DISTRICT 但无 FLOW_DONE，
 * 状态仍为 flow_step 1；turn5 发完薪资带 FLOW_DONE，状态变为 2。
 */
export function applyMarkers(state: HualinState, markers: ChatflowMarkers): HualinState {
  const next: HualinState = {
    ...state,
    switched_factories: [...state.switched_factories],
  };
  if (markers.city) next.current_city = markers.city;
  if (markers.district) next.current_district = markers.district;
  if (markers.age) next.seeker_age = markers.age;
  if (markers.gender) next.seeker_gender = markers.gender;
  if (markers.matched) next.matched_factory = markers.matched;
  // 抓包实测：LLM 输出的 ##TYPE_2## 被 code 节点消费成状态字段，而不是留在回复文本里
  if (markers.type2) next.user_type = "2";
  if (markers.flowDone) next.flow_step = state.flow_step + 1;
  return next;
}

/**
 * 按 ### 切分成多条气泡。证据：抓包 answer 节点输出 `正式工：...###这是岗位的工作内容...`，
 * 客户端按 ### 拆成两条消息发送。空段丢弃。
 */
export function splitBubbles(text: string): string[] {
  return text
    .split("###")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 对话历史的累积格式，逐字对齐抓包：`应聘者：X\n回复：Y\n\n`。 */
export function appendHistory(history: string, query: string, reply: string): string {
  return `${history}应聘者：${query}\n回复：${reply}\n\n`;
}

/** 历史开头的档案前缀，防止模型重新追问已确认信息。 */
export function profilePrefix(state: HualinState): string {
  const city = state.current_city ?? "未知";
  const district = state.current_district ?? "未知";
  return `[已知求职者档案（系统已锁定，直接使用，禁止重新询问）] 城市：${city} ｜ 区域：${district}`;
}

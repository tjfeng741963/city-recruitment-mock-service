/**
 * 目标站 Dify Chatflow 的等价实现。
 *
 * 还原依据（全部来自实测抓包，不是猜测）：
 *  - 节点拓扑：过程文件/dify-probe-nodes.txt + dify-turn{3,4,5}-stream.txt 的 node_started 事件
 *    start → code(话术常量) → code(城市/岗位 prompt) → assigner(初始化 hualin_state)
 *    → if-else(按 flow_step) → llm(流程1) → code(选择回复) → code(推进状态)
 *    → if-else(need_fix) → code → assigner(存 hualin_state + history) → answer
 *  - 会话变量：hualin_state 与 history 存在 Dify conversation variables 上，
 *    对应到本实现即「按 conversation_id 索引的会话表」。
 *  - 标记协议：##CITY:## ##DISTRICT:## ##AGE:## ##GENDER:## ##MATCHED:## ##FLOW_DONE##，
 *    由「看流程是否推进」节点剥离并写回状态，answer 节点只输出干净文本。
 *  - 气泡分割：answer 文本中的 ### 由客户端拆成多条消息。
 *
 * 已覆盖范围：仅【流程一】（收集信息 → 匹配厂区 → 发薪资）。
 * 抓包里 flow_step 始终为 1，流程二/三/四的 prompt 正文未取得，此处不臆造。
 */
import type { DifyHealthResult, DifyMessageInput, DifyMessageResult, DifyProvider } from "./dify-provider.js";
import { CHATFLOW_CATALOG, type ChatflowFactory } from "./chatflow-catalog.js";
import { generateFlowReply } from "./chatflow-flows.js";
import {
  appendHistory,
  applyMarkers,
  emptyState,
  extractMarkers,
  parseState,
  serializeState,
  splitBubbles,
  stripMarkers,
  type HualinState,
} from "./chatflow-state.js";

/** 还原自「代码执行」code 节点输出的静态话术常量（抓包见 过程文件/dify-probe-nodes.txt）。 */
export const FLOW_CONSTANTS = {
  cityDesc: "可以跟我说下你现在在哪个区吗？等会我把要求和待遇发给你",
  whichOneDesc: "你想来广州，深圳还是东莞的厂区呢，都是新开的产线，保底有6000以上。",
  fuheDesc: "看下要求全都符合吗",
  mianshiDesc: "没问题的话我们安排面试时间ok吗。其他方面有没有什么不明白的？",
  mianshiToDesc: "还有其他问题吗，没问题的话安排一下面试时间可以吗？",
  nameTelDesc: "发下姓名和电话给我登记，我发面试时间和位置给你哈",
  salaryTail: "这是岗位的工作内容、薪资待遇，你看看有不明白的可以问我哈～ [玫瑰]",
} as const;

export interface ChatflowSession {
  state: HualinState;
  history: string;
  updatedAt: number;
}

export interface ChatflowOptions {
  /** 会话表。默认进程内 Map；需要持久化时注入自己的实现。 */
  sessions?: Map<string, ChatflowSession>;
  /** 会话上限，超出时淘汰最久未更新的会话。默认 5000。 */
  maxSessions?: number;
  /** 可注入的时间源，便于测试。 */
  now?: () => number;
  /** 预热会话状态（进程重启后从数据库恢复）。 */
  restoredStates?: Map<string, HualinState>;
}

const CITY_NAMES = [...new Set(CHATFLOW_CATALOG.map((f) => f.city))];

const DISTRICT_TO_CITY = new Map<string, string>();
for (const factory of CHATFLOW_CATALOG) {
  if (factory.district) DISTRICT_TO_CITY.set(factory.district, factory.city);
}

/**
 * 拼音别名。抓包实录里求职者输入的是 "dongguan ok" / "qingxizhen" 这类拼音，
 * 原实现的 LLM 能理解，确定性规则需要显式收录。
 */
const PINYIN_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["dongguan", "东莞"],
  ["zhongshan", "中山"],
  ["foshan", "佛山"],
  ["xiamen", "厦门"],
  ["guangzhou", "广州"],
  ["shenzhen", "深圳"],
];

const DISTRICT_PINYIN_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["qingxizhen", "清溪镇"],
  ["qingxi", "清溪镇"],
  ["changan", "长安"],
  ["huangpu", "黄圃"],
  ["sanshui", "三水区"],
  ["nanhai", "南海区"],
  ["tongan", "同安区"],
  ["conghua", "从化区"],
  ["baiyun", "白云"],
  ["guangming", "光明区"],
  ["baoan", "宝安区"],
  ["longhua", "龙华"],
];

/** 命中最长别名优先，避免 qingxi 抢先于 qingxizhen。 */
function matchPinyin(query: string, aliases: ReadonlyArray<readonly [string, string]>): string | undefined {
  const lowered = query.toLowerCase();
  let best: { alias: string; value: string } | undefined;
  for (const [alias, value] of aliases) {
    if (!lowered.includes(alias)) continue;
    if (!best || alias.length > best.alias.length) best = { alias, value };
  }
  return best?.value;
}

/**
 * 从求职者原话里抽城市/区县/年龄/性别。
 * 原始实现由 LLM 完成，这里用确定性规则等价——牺牲话术灵活度，换取可测试与零外部依赖。
 */
export function extractProfile(query: string): { city?: string; district?: string; age?: string; gender?: string } {
  const result: { city?: string; district?: string; age?: string; gender?: string } = {};

  // 区县优先：区县能唯一反推城市（对齐 prompt【信息收集】-区域识别：「说了区县/镇 → 区域已确认」）
  for (const district of DISTRICT_TO_CITY.keys()) {
    if (query.includes(district)) {
      result.district = district;
      result.city = DISTRICT_TO_CITY.get(district);
      break;
    }
  }
  if (!result.district) {
    const pinyinDistrict = matchPinyin(query, DISTRICT_PINYIN_ALIASES);
    if (pinyinDistrict) {
      result.district = pinyinDistrict;
      result.city = DISTRICT_TO_CITY.get(pinyinDistrict);
    }
  }
  if (!result.city) {
    for (const city of CITY_NAMES) {
      if (query.includes(city)) {
        result.city = city;
        break;
      }
    }
  }
  if (!result.city) {
    result.city = matchPinyin(query, PINYIN_ALIASES);
  }
  if (!result.city && result.district) {
    result.city = DISTRICT_TO_CITY.get(result.district);
  }

  const ageWithSuffix = query.match(/(\d{1,2})\s*岁/);
  if (ageWithSuffix) {
    result.age = ageWithSuffix[1];
  } else {
    const bare = query.match(/(?:^|[^\d])(\d{2})(?:[^\d]|$)/);
    if (bare) {
      const value = Number(bare[1]);
      if (value >= 16 && value <= 60) result.age = bare[1];
    }
  }

  if (/男/.test(query)) result.gender = "男";
  else if (/女/.test(query)) result.gender = "女";

  return result;
}

/** 解析「16-45周岁」这类年龄要求为闭区间。 */
export function parseAgeRange(requirement: string): { min: number; max: number } | null {
  const range = requirement.match(/(\d{1,2})\s*[-~到]\s*(\d{1,2})/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  return null;
}

function factoryAccepts(factory: ChatflowFactory, state: HualinState): boolean {
  if (state.seeker_gender && factory.genderRequirement && factory.genderRequirement !== "不限") {
    if (!factory.genderRequirement.includes(state.seeker_gender)) return false;
  }
  if (state.seeker_age) {
    const age = Number(state.seeker_age);
    const range = parseAgeRange(factory.ageRequirement);
    if (range && (age < range.min || age > range.max)) return false;
  }
  return true;
}

/**
 * 匹配厂区。规则对齐 prompt【三】-3：
 * 同城为大前提 → 同城内「区县就近 > 后台顺序」。
 * （原规则还有 ★主推★ 优先级，抓到的目录里没有主推标记，故省略。）
 */
export function matchFactory(state: HualinState): ChatflowFactory | null {
  if (!state.current_city) return null;
  const sameCity = CHATFLOW_CATALOG.filter((f) => f.city === state.current_city);
  if (sameCity.length === 0) return null;
  const eligible = sameCity.filter((f) => factoryAccepts(f, state));
  if (eligible.length === 0) return null;
  if (state.current_district) {
    const near = eligible.find((f) => f.district === state.current_district);
    if (near) return near;
  }
  return eligible[0];
}

function replyForMissingDistrict(city: string): string {
  return `${city}挺好的呀～###你在${city}哪个镇或者哪个区呢？我好看看离你远不远`;
}

function replyForMissingProfile(district: string, state: HualinState): string {
  const needAge = !state.seeker_age;
  const needGender = !state.seeker_gender;
  const lead = district ? `${district}那边啊，我这边记下了～` : "";
  if (needAge && needGender) return `${lead}###请问你今年多大了？是男生还是女生呢？`;
  if (needAge) return `${lead}###你今年多大呀？`;
  return `${lead}###方便说下你是男生还是女生吗？`;
}

/**
 * 生成流程一的一轮回复。返回值可能含隐藏标记，调用方应先 stripMarkers 再发送。
 */
export function generateFlowOneReply(state: HualinState): string {
  if (!state.current_city) {
    return "你好呀～###你现在在哪个区呢？等会发详细的给你看看";
  }
  if (!state.current_district) {
    return replyForMissingDistrict(state.current_city);
  }
  if (!state.seeker_age || !state.seeker_gender) {
    return replyForMissingProfile(state.current_district, state);
  }

  const factory = matchFactory(state);
  if (!factory) {
    return "这边暂时没有符合你条件的岗位哈###好的，后续有合适的我再联系你哈";
  }
  const salary = factory.salaryDetail || `${factory.factory}的岗位信息我稍后发你哈`;
  return `${salary}\n\n###${FLOW_CONSTANTS.salaryTail}\n##MATCHED:${factory.factory}##\n##FLOW_DONE##`;
}

/**
 * Chatflow 版 DifyProvider。对外接口与 HttpDifyProvider 完全一致，
 * 因此可零改动替换进 message-automation / activation 既有调用链。
 */
export class ChatflowDifyProvider implements DifyProvider {
  private readonly sessions: Map<string, ChatflowSession>;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly restored: Map<string, HualinState>;

  constructor(options: ChatflowOptions = {}) {
    this.sessions = options.sessions ?? new Map<string, ChatflowSession>();
    this.maxSessions = options.maxSessions ?? 5000;
    this.now = options.now ?? (() => Date.now());
    this.restored = options.restoredStates ?? new Map<string, HualinState>();
  }

  /** 供外部持久化：取出某会话的状态 JSON。 */
  exportState(conversationId: string): string | null {
    const session = this.sessions.get(conversationId);
    return session ? serializeState(session.state) : null;
  }

  /** 供外部持久化：取出某会话的对话历史。 */
  exportHistory(conversationId: string): string | null {
    return this.sessions.get(conversationId)?.history ?? null;
  }

  async sendMessage(input: DifyMessageInput): Promise<DifyMessageResult> {
    const query = input.query ?? "";
    if (!query.trim()) return { success: false, error: "Empty query" };

    const conversationId = input.conversationId ?? `chatflow-${input.user ?? "anon"}-${this.now()}`;
    const existing = this.sessions.get(conversationId);
    const restoredState = this.restored.get(conversationId);
    const base = existing
      ? existing.state
      : restoredState
        ? parseState(serializeState(restoredState))
        : emptyState();
    const history = existing?.history ?? "";

    // 节点序列第一步：从原话抽取档案（原实现由 LLM 完成）
    const profile = extractProfile(query);
    const withProfile: HualinState = {
      ...base,
      switched_factories: [...base.switched_factories],
      ...(profile.city ? { current_city: profile.city } : {}),
      ...(profile.district ? { current_district: profile.district } : {}),
      ...(profile.age ? { seeker_age: profile.age } : {}),
      ...(profile.gender ? { seeker_gender: profile.gender } : {}),
    };

    // 节点序列第二/三步：按 flow_step 分派到对应流程生成回复 + 推进状态。
    // 原实现是 if-else 按 flow_step 选不同 LLM 节点；这里是同一分派逻辑的确定性等价。
    let nextState: HualinState;
    let visible: string;

    if (withProfile.flow_step >= 2 && withProfile.matched_factory) {
      const factory = CHATFLOW_CATALOG.find((f) => f.factory === withProfile.matched_factory);
      if (!factory) {
        // 已锁定的厂区在最新目录里找不到了：不臆造回复，交回流程一重新收口
        const rawReply = generateFlowOneReply(withProfile);
        nextState = applyMarkers(withProfile, extractMarkers(rawReply));
        visible = stripMarkers(rawReply);
      } else {
        const result = generateFlowReply(withProfile, query, factory, new Date(this.now()));
        nextState = result.state;
        visible = stripMarkers(result.reply);
      }
    } else {
      const rawReply = generateFlowOneReply(withProfile);
      nextState = applyMarkers(withProfile, extractMarkers(rawReply));
      visible = stripMarkers(rawReply);
    }

    const bubbles = splitBubbles(visible);

    const nextSession: ChatflowSession = {
      state: nextState,
      history: appendHistory(history, query, visible),
      updatedAt: this.now(),
    };
    this.sessions.set(conversationId, nextSession);
    this.evictIfNeeded();

    return {
      success: true,
      message: visible,
      message_id: `chatflow-${conversationId}-${nextSession.updatedAt}`,
      conversation_id: conversationId,
      ...(bubbles.length > 1 ? { bubbles } : {}),
      state_json: serializeState(nextState),
    };
  }

  async healthCheck(): Promise<DifyHealthResult> {
    return { healthy: true, latency_ms: 0 };
  }

  private evictIfNeeded(): void {
    if (this.sessions.size <= this.maxSessions) return;
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, session] of this.sessions) {
      if (session.updatedAt < oldestAt) {
        oldestAt = session.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }
}

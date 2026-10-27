/**
 * 流程二 / 三 / 四 的等价实现。
 *
 * 规则来源：目标站 Dify 应用在 flow_step=2/3/4 时的 system prompt 正文
 * （2026-10-27 抓包，见 dify-workflow/prompt/system-flow{2,3,4}.txt）。
 * 这些正文是流式接口 node_finished.process_data.prompts 泄漏出来的，不是推测。
 */
import type { ChatflowFactory } from "./chatflow-catalog.js";
import { splitBubbles, stripMarkers, type HualinState } from "./chatflow-state.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 解析「12:30-13.30」这类面试时段（原数据里存在用点号分隔的笔误）。 */
export function parseInterviewWindow(spec: string): { startMin: number; endMin: number } | null {
  const match = spec.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~到]\s*(\d{1,2})\s*[:：.]?\s*(\d{2})/);
  if (!match) return null;
  return {
    startMin: Number(match[1]) * 60 + Number(match[2]),
    endMin: Number(match[3]) * 60 + Number(match[4]),
  };
}

/** 该厂在星期几可以面试。 */
export function isInterviewDay(factory: ChatflowFactory, date: Date): boolean {
  const weekday = WEEKDAYS[date.getDay()];
  return factory.interviewDays.includes(weekday);
}

function isoDate(target: Date): string {
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
}

function startOfDay(target: Date): number {
  const copy = new Date(target);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/**
 * 推荐面试日期。对齐 prompt 流程二阶段三的算法：
 * 今天可用 = 面试结束时刻 − 当前时间 ≥ 2 小时，且今天是可面试星期；
 * 否则顺延到下一个满足「可面试星期」的日期。
 */
export function nextInterviewDate(now: Date, factory: ChatflowFactory): { date: Date; isToday: boolean } {
  const window = parseInterviewWindow(factory.interviewTime);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (window && isInterviewDay(factory, now) && window.endMin - nowMin >= 120) {
    return { date: new Date(now), isToday: true };
  }
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    if (isInterviewDay(factory, candidate)) return { date: candidate, isToday: false };
  }
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  return { date: fallback, isToday: false };
}

/** 「今天2026-10-27（周二）」「明天2026-10-28（周三）」这类中文日期标签。 */
export function formatDateLabel(now: Date, target: Date): string {
  const dayDiff = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);
  const prefix = dayDiff === 0 ? "今天" : dayDiff === 1 ? "明天" : dayDiff === 2 ? "后天" : "";
  return `${prefix}${isoDate(target)}（${WEEKDAYS[target.getDay()]}）`;
}

export interface FlowReply {
  /** 已剥离隐藏标记的可见文本，内部可能含 ### 分段符。 */
  reply: string;
  /** 本轮流转后的状态。 */
  state: HualinState;
  /** 是否推进到下一流程（等价于原实现的 ##FLOW_DONE##）。 */
  advanced: boolean;
}

/** 判断求职者是否在确认（"好的""没问题""嗯"等非交互回复）——流程二阶段一会因它直接跳到阶段二。 */
export function isAcknowledgement(query: string): boolean {
  return /^(好的?|好|嗯+|哦+|ok|okay|没问题|了解|明白|知道了?|行|可以|收到)[。.!！~～\s]*$/i.test(query.trim());
}

/**
 * 纹身案底的回答归类。
 *
 * 先判否认再判肯定：中文里「没有纹身」「没有案底」本身含有"纹身""案底"字样，
 * 若先做肯定匹配会把否认误判成承认。
 */
export function classifyTattooRecord(query: string): "none" | "tattoo" | "record" | undefined {
  const denies = /没有|没|无|不|干净|都没有/.test(query);
  const admitsTattoo = /有纹身|身上有.{0,4}纹身|纹了|有个纹身|有.{0,2}纹身/.test(query);
  const admitsRecord = /有案底|进过派出所|留过案底/.test(query);

  if (denies) {
    // 「有纹身吗？没有」这类：否认优先
    if (/没有|没|无/.test(query)) return "none";
    return undefined;
  }
  if (admitsRecord) return "record";
  if (admitsTattoo) return "tattoo";
  return undefined;
}

/** 纹身程度是否可接受：穿短袖不外露、或外露部分不超过身份证大小。 */
export function isTattooAcceptable(query: string): boolean {
  return /不外露|看不到|盖得住|短袖看不|很小|一点点|不明显|不大/.test(query);
}

const TATTOO_ASK = "###另外，这边问一下有没有纹身案底呀？";

/**
 * 同意参加面试的判定。
 * 刻意排除裸「过去」——抓包第 28 轮「那我什么时候能过去面试呢？」含该词但只是询问，
 * 真实系统并没有推进流程。
 */
const ACCEPTANCE = /可以(?!.{0,2}吗)|行的|行，|行啊|好的|好，|好啊|没问题|能来|愿意|ok|OK/;

/** 薪资答疑的简短回答。原实现由 LLM 自由回答，这里用确定性话术等价。 */
function answerSalaryQuestion(query: string): string {
  if (/加班|几点|时长|上班时间/.test(query)) return "长白班为主，一天八小时，加班自愿，想多赚可以多加";
  if (/住|宿舍|吃/.test(query)) return "包吃包住，宿舍有空调热水器，环境不错的";
  if (/社保|五险|公积金/.test(query)) return "入职就交五险，转正后公积金也有";
  if (/工资|多少|薪资|待遇|钱/.test(query)) return "综合工资6000往上，具体看加班和岗位，等会详细发你";
  if (/体检/.test(query)) return "体检自费，做满一个月厂里有报销";
  return "这个我回头详细跟你说，先看看还有啥想问的不";
}

/**
 * 阶段三第一步：只发邀约问句，**不推进流程**。
 * 抓包实测第 22 轮：系统问「…可以过来面试吗？」时 flow_step 仍是 2，
 * 直到第 29 轮求职者确认后才发报名表单并推进到 3。
 */
function askInterview(
  state: HualinState,
  factory: ChatflowFactory,
  now: Date,
  patch: Partial<HualinState> = {},
): FlowReply {
  const { date } = nextInterviewDate(now, factory);
  const label = formatDateLabel(now, date);
  return {
    reply: `###看看有啥问题不，没问题${label}${factory.interviewTime}可以过来面试吗？`,
    state: { ...state, ...patch, interview_date: isoDate(date), interview_asked: true },
    advanced: false,
  };
}

/** 阶段三第二步：求职者确认后发报名表单，等价于原实现的 ##FLOW_DONE##。 */
function sendSignupForm(state: HualinState, factory: ChatflowFactory, now: Date): FlowReply {
  const date = state.interview_date ? new Date(`${state.interview_date}T00:00:00`) : nextInterviewDate(now, factory).date;
  // 厂区数据里的[报名表单]自带以 ### 开头，需先剥掉，否则会叠出多个分隔符
  const form = (factory.signupForm || "麻烦填一下报名信息，好了发给我哈~（姓名和电话填一下就行）").replace(/^#+\s*/, "");
  const formWithDate = form.includes("面试入职日期")
    ? form.replace(/(面试入职日期[:：]\s*)[^\n]*/, `$1${isoDate(date)}（${WEEKDAYS[date.getDay()]}）`)
    : `${form}\n面试入职日期：${isoDate(date)}（${WEEKDAYS[date.getDay()]}）`;

  return {
    reply: `###${formWithDate}`,
    state: { ...state, interview_date: isoDate(date), flow_step: state.flow_step + 1 },
    advanced: true,
  };
}

/** 流程二：薪资答疑 → 纹身案底确认 → 邀约面试（发报名表单）。 */
export function generateFlowTwoReply(
  state: HualinState,
  query: string,
  factory: ChatflowFactory,
  now: Date,
): FlowReply {
  const turns = state.flow2_turns ?? 0;

  // 已确认过纹身案底（或已放弃追问）：等待求职者对邀约作出回应
  if (state.tattoo_record !== undefined || state.tattoo_skipped) {
    // 已发出过邀约问句 → 对方明确答应才发表单并推进。
    // 注意不能只匹配「过去」：抓包第 28 轮求职者问「那我什么时候能过去面试呢？」
    // 含「过去」但只是提问，真实系统仍停在流程二、只重发邀约问句。
    if (state.interview_asked && ACCEPTANCE.test(query)) {
      return sendSignupForm(state, factory, now);
    }
    // 还没问过 → 只发问句，不推进
    if (!state.interview_asked) {
      return askInterview(state, factory, now);
    }
    // 问过了但对方没确认 → 再问一次，仍不推进
    const date = new Date(`${state.interview_date}T00:00:00`);
    return {
      reply: `###${formatDateLabel(now, date)}${factory.interviewTime}可以过来面试吗？`,
      state,
      advanced: false,
    };
  }

  // 阶段二：正在等纹身案底的回答（turns 已到达追问阈值，或对方回了确认类）
  const verdict = classifyTattooRecord(query);
  if (verdict === "record") {
    // 抓到的规则：有案底时「过几分钟再聊」，不推进流程
    return {
      reply: "###稍等一下，我手上有点事，过几分钟后续再聊",
      state: { ...state, tattoo_record: "record", flow2_turns: turns + 1 },
      advanced: false,
    };
  }
  if (verdict === "tattoo") {
    if (isTattooAcceptable(query)) return askInterview(state, factory, now, { tattoo_record: "tattoo" });
    return {
      reply: "###穿短袖不外露，或者手臂上外露部分不超过身份证大小那就没问题",
      state: { ...state, tattoo_record: "tattoo", flow2_turns: turns + 1 },
      advanced: false,
    };
  }
  if (verdict === "none") return askInterview(state, factory, now, { tattoo_record: "none" });

  // 阶段一：薪资答疑。确认性回复直接跳到阶段二；否则满 3 轮才带出提问
  const nextTurns = turns + 1;

  // 抓包实测第 22 轮：连问 3 轮纹身都没被正面回答后，系统自己放弃追问，
  // 改口「行，那不纠结这个了…你直接过来就行」并转向邀约。这里同构实现。
  const asks = state.tattoo_asks ?? 0;
  if (asks >= 3 && !state.tattoo_skipped) {
    const invited = askInterview(state, factory, now, { tattoo_skipped: true });
    return {
      ...invited,
      reply: `###行，那不纠结这个了，我们这岗位本身不查纹身也不查案底的，你直接过来就行。${invited.reply.replace(/^###/, "")}`,
    };
  }

  if (isAcknowledgement(query) || nextTurns >= 3) {
    return {
      reply: TATTOO_ASK,
      state: { ...state, flow2_turns: nextTurns, tattoo_asks: asks + 1 },
      advanced: false,
    };
  }
  return { reply: `###${answerSalaryQuestion(query)}`, state: { ...state, flow2_turns: nextTurns }, advanced: false };
}

/** 流程三：收到报名表单 → 发面试通知 + 地址。 */
export function generateFlowThreeReply(
  state: HualinState,
  query: string,
  factory: ChatflowFactory,
  now: Date,
): FlowReply {
  const hasPhone = /1[3-9]\d{9}/.test(query);
  const hasName = /[叫是]\s*[一-龥]{2,4}|名字[:：]\s*[一-龥]{2,4}|[一-龥]{2,4}\s*[,，]\s*(?:电话|手机|\d{11})/.test(query);

  if (!hasPhone || !hasName) {
    const missing = !hasName && !hasPhone ? "姓名和电话" : !hasName ? "姓名" : "电话";
    return {
      reply: `###麻烦发下姓名和电话，我发面试通知和位置给你哦～（还差${missing}）`,
      state,
      advanced: false,
    };
  }

  const date = state.interview_date ? new Date(`${state.interview_date}T00:00:00`) : nextInterviewDate(now, factory).date;
  const notice = (factory.interviewNotice || "###报名成功！！\n面试日期：\n请携带好本人身份证件").replace(
    /(面试日期[:：]\s*)[^\n]*/,
    `$1${isoDate(date)}`,
  );
  const address = factory.address.replace(/^#+\s*/, "").replace(/\s*#+$/, "");

  const phone = query.match(/1[3-9]\d{9}/)?.[0];
  return {
    reply: `${notice}\n\n###${address}`,
    // 抓包实测：第 30 轮（报名表单送达后）状态里出现 phone 字段
    state: { ...state, ...(phone ? { phone } : {}), form_received: true, flow_step: state.flow_step + 1 },
    advanced: true,
  };
}

/** 流程四：面试跟进 → 到达后发面试指引。 */
export function generateFlowFourReply(
  state: HualinState,
  query: string,
  factory: ChatflowFactory,
  now: Date,
): FlowReply {
  const arrived = /我到了|到了|在门口|到厂门口|已经到/.test(query);

  if (!arrived) {
    if (/出发|在路上|快到了/.test(query)) return { reply: "###你到了给我说一声就行", state, advanced: false };
    if (/找谁|联系谁/.test(query)) return { reply: "###你到了直接联系我就行", state, advanced: false };
    if (/停车/.test(query)) return { reply: "###你到了跟我说，我告诉你停在哪", state, advanced: false };
    if (/改时间|换个时间|推迟|晚点/.test(query)) return { reply: "###好的，你看哪天方便过来？", state, advanced: false };
    // 抓包原文：表示按时前来 → 「###好的」；纯语气词（好的/谢谢/ok）→ 「###」，即不发任何内容
    if (/按时|准时|明天到|一定来|肯定来|会来/.test(query)) return { reply: "###好的", state, advanced: false };
    return { reply: "", state, advanced: false };
  }

  // 到达后先做时间校验：必须是面试当天且已进入面试时段（含提前 15 分钟）
  const window = parseInterviewWindow(factory.interviewTime);
  const isToday = state.interview_date ? state.interview_date === isoDate(now) : isInterviewDay(factory, now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (!isToday) {
    return { reply: "###现在还没到面试时间哦，等到了面试时间过来了跟我说", state, advanced: false };
  }
  if (window && nowMin < window.startMin - 15) {
    return { reply: "###面试还没开始呢，稍等一下，到了面试时间叫我哈", state, advanced: false };
  }
  if (window && nowMin > window.endMin) {
    return { reply: "###今天的面试时间已经过了，帮你改个时间可以吗？", state, advanced: false };
  }

  const guide = factory.interviewGuide || "到了直接联系我就行，我带你走流程";
  return {
    reply: `###${guide}`,
    state: { ...state, arrived: true, flow_step: state.flow_step + 1 },
    advanced: true,
  };
}

/** 按流程号分派。 */
export function generateFlowReply(
  state: HualinState,
  query: string,
  factory: ChatflowFactory,
  now: Date,
): FlowReply {
  switch (state.flow_step) {
    case 2:
      return generateFlowTwoReply(state, query, factory, now);
    case 3:
      return generateFlowThreeReply(state, query, factory, now);
    default:
      return generateFlowFourReply(state, query, factory, now);
  }
}

/** 按 ### 切分并剥离残留标记。 */
export function toBubbles(reply: string): string[] {
  return splitBubbles(stripMarkers(reply));
}

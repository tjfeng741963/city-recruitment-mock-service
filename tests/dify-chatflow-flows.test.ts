import { describe, expect, it } from "vitest";
import { CHATFLOW_CATALOG } from "../src/modules/dify/chatflow-catalog.js";
import {
  classifyTattooRecord,
  formatDateLabel,
  generateFlowFourReply,
  generateFlowThreeReply,
  generateFlowTwoReply,
  isAcknowledgement,
  isInterviewDay,
  isTattooAcceptable,
  nextInterviewDate,
  parseInterviewWindow,
} from "../src/modules/dify/chatflow-flows.js";
import type { HualinState } from "../src/modules/dify/chatflow-state.js";

/** 清溪的新造物玩具厂：可面试周一至周六，12:30-13:30。 */
const factory = CHATFLOW_CATALOG.find((f) => f.factory === "新造物东莞玩具厂")!;

/** 2026-10-27 是周二，与抓包当天一致。 */
const TUESDAY_EARLY = new Date("2026-10-27T09:00:00");
const TUESDAY_NOON = new Date("2026-10-27T12:40:00");
const TUESDAY_LATE = new Date("2026-10-27T15:00:00");

function state2(patch: Partial<HualinState> = {}): HualinState {
  return {
    flow_step: 2,
    switched_factories: [],
    current_city: "东莞",
    current_district: "清溪",
    matched_factory: "新造物东莞玩具厂",
    seeker_age: "25",
    seeker_gender: "男",
    ...patch,
  };
}

describe("interview window and dates", () => {
  it("parses both colon and dot separators", () => {
    expect(parseInterviewWindow("12:30-13.30")).toEqual({ startMin: 750, endMin: 810 });
    expect(parseInterviewWindow("10:00-11:30")).toEqual({ startMin: 600, endMin: 690 });
    expect(parseInterviewWindow("不限")).toBeNull();
  });

  it("knows which weekdays a factory interviews", () => {
    // 2026-10-27 周二 → 可面试；2026-11-01 周日 → 新造物不可面试
    expect(isInterviewDay(factory, new Date("2026-10-27T00:00:00"))).toBe(true);
    expect(isInterviewDay(factory, new Date("2026-11-01T00:00:00"))).toBe(false);
  });

  it("books today only when at least two hours remain before the window ends", () => {
    // 09:00 距 13:30 结束还有 4.5 小时 → 今天可用
    expect(nextInterviewDate(TUESDAY_EARLY, factory).isToday).toBe(true);
    // 12:40 距 13:30 只有 50 分钟 → 今天不可用，顺延到次日
    const noon = nextInterviewDate(TUESDAY_NOON, factory);
    expect(noon.isToday).toBe(false);
    expect(noon.date.getDate()).toBe(28);
  });

  it("skips non-interview days when rolling forward", () => {
    // 周六 15:00 之后 → 周日不可面试 → 落到下周一
    const saturdayLate = new Date("2026-10-31T15:00:00");
    expect(nextInterviewDate(saturdayLate, factory).date.getDay()).toBe(1);
  });

  it("labels today, tomorrow and plain dates", () => {
    expect(formatDateLabel(TUESDAY_EARLY, TUESDAY_EARLY)).toBe("今天2026-10-27（周二）");
    expect(formatDateLabel(TUESDAY_EARLY, new Date("2026-10-28T00:00:00"))).toBe("明天2026-10-28（周三）");
    expect(formatDateLabel(TUESDAY_EARLY, new Date("2026-10-29T00:00:00"))).toBe("后天2026-10-29（周四）");
    expect(formatDateLabel(TUESDAY_EARLY, new Date("2026-10-30T00:00:00"))).toBe("2026-10-30（周五）");
  });
});

describe("answer classification", () => {
  it("recognises acknowledgement replies", () => {
    expect(isAcknowledgement("好的")).toBe(true);
    expect(isAcknowledgement("嗯")).toBe(true);
    expect(isAcknowledgement("没问题")).toBe(true);
    expect(isAcknowledgement("你那边包住吗")).toBe(false);
  });

  it("classifies tattoo and record answers", () => {
    expect(classifyTattooRecord("没有纹身，也没有案底")).toBe("none");
    expect(classifyTattooRecord("都没有")).toBe("none");
    expect(classifyTattooRecord("有案底")).toBe("record");
    expect(classifyTattooRecord("手上有个纹身")).toBe("tattoo");
    expect(classifyTattooRecord("你那边累不累")).toBeUndefined();
  });

  it("accepts a small hidden tattoo only", () => {
    expect(isTattooAcceptable("很小，穿短袖看不到")).toBe(true);
    expect(isTattooAcceptable("手臂上一大片，盖不住")).toBe(false);
  });
});

describe("flow two", () => {
  it("answers questions without revealing the tattoo question too early", () => {
    const first = generateFlowTwoReply(state2({ flow2_turns: 0 }), "加班多吗", factory, TUESDAY_EARLY);
    expect(first.reply).toContain("加班");
    expect(first.reply).not.toContain("纹身");
    expect(first.advanced).toBe(false);
    expect(first.state.flow2_turns).toBe(1);
  });

  it("brings up the tattoo question on the third interaction", () => {
    const third = generateFlowTwoReply(state2({ flow2_turns: 2 }), "还有啥", factory, TUESDAY_EARLY);
    expect(third.reply).toContain("纹身案底");
  });

  it("jumps straight to the tattoo question on an acknowledgement", () => {
    const ack = generateFlowTwoReply(state2({ flow2_turns: 0 }), "好的", factory, TUESDAY_EARLY);
    expect(ack.reply).toContain("纹身案底");
  });

  it("stalls without advancing when the candidate admits a criminal record", () => {
    const result = generateFlowTwoReply(state2({ flow2_turns: 3 }), "有案底", factory, TUESDAY_EARLY);
    expect(result.reply).toContain("过几分钟后续再聊");
    expect(result.advanced).toBe(false);
    expect(result.state.flow_step).toBe(2);
    expect(result.state.tattoo_record).toBe("record");
  });

  it("advances to the form with a concrete interview date once cleared", () => {
    const result = generateFlowTwoReply(state2({ flow2_turns: 3 }), "没有纹身也没有案底", factory, TUESDAY_EARLY);
    expect(result.advanced).toBe(true);
    expect(result.state.flow_step).toBe(3);
    expect(result.state.tattoo_record).toBe("none");
    expect(result.state.interview_date).toBe("2026-10-27");
    // 该厂[报名表单]原文是「麻烦填一下预约面试信息」，逐字来自数据块
    expect(result.reply).toContain("预约面试信息");
    expect(result.reply).toContain("2026-10-27");
  });

  it("sends the form when the candidate agrees after clearing", () => {
    const result = generateFlowTwoReply(state2({ tattoo_record: "none" }), "可以，我过去", factory, TUESDAY_EARLY);
    expect(result.advanced).toBe(true);
    expect(result.state.flow_step).toBe(3);
  });
});

describe("flow three", () => {
  it("asks for name and phone when the form is incomplete", () => {
    const result = generateFlowThreeReply(state2({ flow_step: 3 }), "好的", factory, TUESDAY_EARLY);
    expect(result.reply).toContain("姓名和电话");
    expect(result.advanced).toBe(false);
  });

  it("sends the notice with the date filled and the address appended", () => {
    const result = generateFlowThreeReply(
      state2({ flow_step: 3, interview_date: "2026-10-28" }),
      "我叫测试，电话13800000000",
      factory,
      TUESDAY_EARLY,
    );
    expect(result.advanced).toBe(true);
    expect(result.state.flow_step).toBe(4);
    expect(result.state.form_received).toBe(true);
    expect(result.reply).toContain("报名成功");
    expect(result.reply).toContain("2026-10-28");
    expect(result.reply).toContain("清溪莲塘路73号");
  });
});

describe("flow four", () => {
  it("stays silent on a bare acknowledgement", () => {
    // 抓包原文：求职者发语气词（好的/谢谢/ok）→ 只回「###」，即不发送任何内容
    const result = generateFlowFourReply(
      state2({ flow_step: 4, interview_date: "2026-10-27" }),
      "好的",
      factory,
      TUESDAY_NOON,
    );
    expect(result.reply).toBe("");
    expect(result.advanced).toBe(false);
  });

  it("acknowledges a promise to attend on time", () => {
    const result = generateFlowFourReply(
      state2({ flow_step: 4, interview_date: "2026-10-27" }),
      "我明天一定准时到",
      factory,
      TUESDAY_NOON,
    );
    expect(result.reply).toBe("###好的");
  });

  it("asks the candidate to report on arrival when only en route", () => {
    const result = generateFlowFourReply(state2({ flow_step: 4 }), "我在路上了", factory, TUESDAY_NOON);
    expect(result.reply).toContain("到了给我说一声");
  });

  it("refuses to send the guide before the interview day", () => {
    const result = generateFlowFourReply(
      state2({ flow_step: 4, interview_date: "2026-10-28" }),
      "我到了",
      factory,
      TUESDAY_NOON,
    );
    expect(result.reply).toContain("还没到面试时间");
    expect(result.advanced).toBe(false);
  });

  it("refuses to send the guide more than 15 minutes early", () => {
    const early = new Date("2026-10-27T11:50:00"); // 距 12:30 还有 40 分钟
    const result = generateFlowFourReply(
      state2({ flow_step: 4, interview_date: "2026-10-27" }),
      "我到了",
      factory,
      early,
    );
    expect(result.reply).toContain("面试还没开始");
    expect(result.advanced).toBe(false);
  });

  it("sends the guide inside the window", () => {
    const result = generateFlowFourReply(
      state2({ flow_step: 4, interview_date: "2026-10-27" }),
      "我到了，在厂门口",
      factory,
      TUESDAY_NOON,
    );
    expect(result.advanced).toBe(true);
    expect(result.state.flow_step).toBe(5);
    expect(result.state.arrived).toBe(true);
  });

  it("handles a late arrival by offering to reschedule", () => {
    const result = generateFlowFourReply(
      state2({ flow_step: 4, interview_date: "2026-10-27" }),
      "我到了",
      factory,
      TUESDAY_LATE,
    );
    expect(result.reply).toContain("已经过了");
    expect(result.advanced).toBe(false);
  });
});

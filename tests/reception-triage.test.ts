import { describe, expect, it } from "vitest";
import type { Conversation } from "../frontend/src/api/agent";
import { buildHook, tabTitle } from "../frontend/src/pages/reception/hook";
import { parseDbTime, triage, type ThreadInfo } from "../frontend/src/pages/reception/triage";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function conv(customerId: number, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: customerId, device_code: "d1", customer_id: customerId, nickname: `c${customerId}`, state: "active",
    recruit_status: "none", takeover: 0, unread: 0, city: "", district: "", last_msg: "",
    last_msg_at: minutesAgo(5), updated_at: "", ...overrides,
  };
}

const thread = (lastDirection: ThreadInfo["lastDirection"], inboundMinutesAgo: number): ThreadInfo => ({
  lastDirection, lastInboundAt: NOW - inboundMinutesAgo * 60_000, simulated: false, lastOutboundFailed: false,
});

describe("reception triage", () => {
  it("reads zone-less SQLite timestamps as UTC", () => {
    expect(parseDbTime("2026-10-28 09:00:00")).toBe(NOW);
  });

  it("counts a taken-over conversation as waiting only when the last message is inbound", () => {
    const items = triage(
      [conv(1, { takeover: 1 }), conv(2, { takeover: 1 }), conv(3)],
      new Map([["d1:1", thread("inbound", 18)], ["d1:2", thread("outbound", 30)]]),
      NOW,
    );
    expect(items.map((i) => i.group)).toEqual(["waiting", "active", "active"]);
    expect(items[0].waitingMinutes).toBe(18);
  });

  it("ends conversations with no message in 24 hours or marked disqualified", () => {
    const items = triage([conv(1, { last_msg_at: minutesAgo(25 * 60) }), conv(2, { state: "disqualified" })], new Map(), NOW);
    expect(items.map((i) => i.group)).toEqual(["ended", "ended"]);
  });
});

describe("reception hook sentence", () => {
  it("drops zero clauses and reports the longest wait", () => {
    const triaged = triage([conv(1, { takeover: 1 }), conv(2)], new Map([["d1:1", thread("inbound", 18)]]), NOW);
    const hook = buildHook({ triaged, deviceStates: ["online", "offline"], failedDeliveries: 0, now: NOW });
    expect(hook.text).toBe("2 个人在聊 · 1 个等你回（最久 18 分钟） · 1 个号掉线");
    expect(tabTitle(hook.waiting)).toBe("(1) 招聘接待台");
  });

  it("shows the all-clear sentence and never counts unpaired devices as offline", () => {
    const hook = buildHook({ triaged: triage([conv(1)], new Map(), NOW), deviceStates: ["unpaired"], failedDeliveries: 0, now: NOW });
    expect(hook).toEqual({ text: "1 个人在聊 · 都在 AI 手里，没有人等你", waiting: 0, isAllClear: true, tone: "clear" });
    expect(tabTitle(0)).toBe("招聘接待台");
  });

  it("tones the page by the most severe clause", () => {
    const waitingOnly = triage([conv(1, { takeover: 1 })], new Map([["d1:1", thread("inbound", 5)]]), NOW);
    const base = { triaged: waitingOnly, deviceStates: ["online" as const], failedDeliveries: 0, now: NOW };
    expect(buildHook(base).tone).toBe("waiting");
    expect(buildHook({ ...base, deviceStates: ["offline"] }).tone).toBe("alert");
    expect(buildHook({ ...base, triaged: triage([conv(2)], new Map(), NOW), failedDeliveries: 2 }).tone).toBe("alert");
  });
});

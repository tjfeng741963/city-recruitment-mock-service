import type { BridgeState } from "../../api/agent";
import { ACTIVE_WINDOW_MS, formatWait, type TriagedConversation } from "./triage";

export interface HookInput {
  triaged: TriagedConversation[];
  deviceStates: Array<BridgeState | "unpaired">;
  failedDeliveries: number;
  now: number;
}

export type HookTone = "clear" | "waiting" | "alert";

export interface HookSentence {
  text: string;
  waiting: number;
  isAllClear: boolean;
  tone: HookTone;
}

export function buildHook({ triaged, deviceStates, failedDeliveries, now }: HookInput): HookSentence {
  const chatting = triaged.filter((t) => t.lastAt !== null && now - t.lastAt <= ACTIVE_WINDOW_MS).length;
  const waitingItems = triaged.filter((t) => t.group === "waiting");
  const longest = Math.max(0, ...waitingItems.map((t) => t.waitingMinutes ?? 0));
  // Never-paired devices count as 未连接, not 掉线.
  const offline = deviceStates.filter((s) => s === "offline").length;

  const needsAction = waitingItems.length > 0 || offline > 0 || failedDeliveries > 0;
  if (!needsAction) {
    return { text: `${chatting} 个人在聊 · 都在 AI 手里，没有人等你`, waiting: 0, isAllClear: true, tone: "clear" };
  }

  const clauses: string[] = [];
  if (chatting) clauses.push(`${chatting} 个人在聊`);
  if (waitingItems.length) clauses.push(`${waitingItems.length} 个等你回（最久 ${formatWait(longest)}）`);
  if (offline) clauses.push(`${offline} 个号掉线`);
  if (failedDeliveries) clauses.push(`${failedDeliveries} 条没发出去`);
  const tone: HookTone = offline > 0 || failedDeliveries > 0 ? "alert" : "waiting";
  return { text: clauses.join(" · "), waiting: waitingItems.length, isAllClear: false, tone };
}

export function tabTitle(waiting: number, base = "招聘接待台"): string {
  return waiting > 0 ? `(${waiting}) ${base}` : base;
}

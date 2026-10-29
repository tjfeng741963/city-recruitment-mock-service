import type { AgentMessage, Conversation } from "../../api/agent";

export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REENTRY_GAP_MS = 60 * 60 * 1000;
const MINUTE = 60_000;

// SQLite CURRENT_TIMESTAMP is UTC without a zone marker; Date.parse would read it as local time.
export function parseDbTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

export function minutesSince(ms: number, now: number): number {
  return Math.max(0, Math.floor((now - ms) / MINUTE));
}

export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
}

export interface ThreadInfo {
  lastDirection: AgentMessage["direction"] | null;
  lastInboundAt: number | null;
  simulated: boolean;
  lastOutboundFailed: boolean;
}

export function threadInfo(messages: AgentMessage[]): ThreadInfo {
  const last = messages[messages.length - 1];
  const reversed = [...messages].reverse();
  const lastInbound = reversed.find((m) => m.direction === "inbound");
  const lastOutbound = reversed.find((m) => m.direction === "outbound");
  return {
    lastDirection: last?.direction ?? null,
    lastInboundAt: lastInbound ? parseDbTime(lastInbound.created_at) : null,
    simulated: messages.some((m) => m.direction === "outbound" && m.status === "simulated"),
    lastOutboundFailed: lastOutbound?.status === "failed",
  };
}

export type GroupKey = "waiting" | "active" | "ended";

export interface TriagedConversation {
  key: string;
  conversation: Conversation;
  group: GroupKey;
  waitingMinutes: number | null;
  lastAt: number | null;
}

export const conversationKey = (c: Pick<Conversation, "device_code" | "customer_id">) => `${c.device_code}:${c.customer_id}`;

export function triage(conversations: Conversation[], threads: Map<string, ThreadInfo>, now: number): TriagedConversation[] {
  return conversations.map((conversation) => {
    const key = conversationKey(conversation);
    const lastAt = parseDbTime(conversation.last_msg_at);
    const thread = threads.get(key);
    if (conversation.takeover === 1 && thread?.lastDirection === "inbound") {
      const since = thread.lastInboundAt ?? lastAt;
      return { key, conversation, group: "waiting", waitingMinutes: since === null ? 0 : minutesSince(since, now), lastAt };
    }
    const isRecent = lastAt !== null && now - lastAt <= ACTIVE_WINDOW_MS;
    const isEnded = conversation.state === "disqualified" || !isRecent;
    return { key, conversation, group: isEnded ? "ended" : "active", waitingMinutes: null, lastAt };
  });
}

export function sortGroup(items: TriagedConversation[], group: GroupKey): TriagedConversation[] {
  const inGroup = items.filter((item) => item.group === group);
  if (group === "waiting") return [...inGroup].sort((a, b) => (b.waitingMinutes ?? 0) - (a.waitingMinutes ?? 0));
  // Taken-over conversations stay on top so the operator can find what they are handling.
  return [...inGroup].sort((a, b) => b.conversation.takeover - a.conversation.takeover || (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

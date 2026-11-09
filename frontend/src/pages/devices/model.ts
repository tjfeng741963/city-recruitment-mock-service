import type { Conversation } from "../../api/agent";
import type { BridgeCommand } from "../../api/admin";
import { parseDbTime } from "../reception/triage";
import type { DeviceState } from "../reception/useReception";

export const STATE_LABEL: Record<DeviceState, string> = {
  offline: "掉线",
  scanning: "等扫码",
  online: "在线",
  unpaired: "未连接",
};

// Orange is reserved for "waiting on you" in reception; scanning stays blue.
export const STATE_TONE: Record<DeviceState, "danger" | "accent" | "success" | "neutral"> = {
  offline: "danger",
  scanning: "accent",
  online: "success",
  unpaired: "neutral",
};

// Offline first: a dropped number means nobody is answering there.
const STATE_ORDER: Record<DeviceState, number> = { offline: 0, scanning: 1, unpaired: 2, online: 3 };

export function sortByUrgency<T extends { state: DeviceState; name: string }>(cards: T[]): T[] {
  return [...cards].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name, "zh"));
}

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function receivedToday(conversations: Conversation[], now: number): number {
  const start = startOfLocalDay(now);
  return conversations.filter((c) => (parseDbTime(c.last_msg_at) ?? 0) >= start).length;
}

export function failedCommands(commands: BridgeCommand[]): BridgeCommand[] {
  return commands.filter((c) => c.status === "failed" || c.status === "unknown");
}

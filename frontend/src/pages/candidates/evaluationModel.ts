import type { DailyMetric, EvaluationDetail, EvaluationDevice, RawMetricKey } from "../../api/candidates";
import { localDate } from "./shared";

export type Preset = "today" | "week" | "month" | "custom";

export const PRESET_DAYS: Record<Exclude<Preset, "custom">, number> = { today: 1, week: 7, month: 30 };

export interface Range {
  preset: Preset;
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;

export function presetRange(preset: Exclude<Preset, "custom">, now = new Date()): Range {
  const start = new Date(now.getTime() - (PRESET_DAYS[preset] - 1) * DAY_MS);
  return { preset, start: localDate(start), end: localDate(now) };
}

export function rangeDays(r: Range): number {
  const diff = Math.round((new Date(r.end).getTime() - new Date(r.start).getTime()) / DAY_MS) + 1;
  return Number.isFinite(diff) && diff > 0 ? diff : 1;
}

/** Same default as the old page: first device scored today, else the first device. */
export function defaultDevice(items: EvaluationDevice[]): string {
  return (items.find((d) => d.today_score != null) ?? items[0])?.device_code ?? "";
}

export function hasScores(d: EvaluationDetail | null | undefined): d is EvaluationDetail {
  return Boolean(d && (d.weighted_score != null || d.dimension_scores || d.raw_metrics));
}

export const DIMENSIONS = [
  { key: "conversion", label: "邀约转化", icon: "check" },
  { key: "independence", label: "AI 独立性", icon: "robot" },
  { key: "depth", label: "对话深度", icon: "chat" },
  { key: "stability", label: "稳定性", icon: "bolt" },
] as const;

export const DIMENSION_LABEL: Record<string, string> = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.label]));

export const RAW_METRICS: Array<[RawMetricKey, string]> = [
  ["total_conversations", "总对话数"],
  ["total_messages", "总消息数"],
  ["ai_message_count", "AI 消息"],
  ["customer_message_count", "求职者消息"],
  ["timeout_count", "超时次数"],
  ["deep_conv_count", "深度对话"],
  ["customer_last_reply_count", "求职者最后回复"],
  ["short_ai_msg_count", "AI 短回复次数"],
  ["invited_count", "邀约成功"],
  ["takeover_count", "转人工次数"],
  ["disqualified_count", "不符合"],
  ["checked_in_count", "签到成功"],
];

export function levelTone(level?: string): "success" | "accent" | "warning" | "danger" | "neutral" {
  if (level === "S" || level === "A") return "success";
  if (level === "B") return "accent";
  if (level === "C") return "warning";
  if (level === "D") return "danger";
  return "neutral";
}

export function dayTotal(m: DailyMetric): number {
  return m.invited + m.pending_invite + m.disqualified + m.checked_in;
}

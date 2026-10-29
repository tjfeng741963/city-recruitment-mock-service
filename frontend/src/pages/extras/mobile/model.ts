import type { Tone } from "@ui";
import type { MobileConversation, MobileMessage } from "../../../api/extras";
import { parseDbTime } from "../../reception/triage";
import { localDate } from "../model";

export type StatusKey = "active" | "pending_invite" | "invited" | "disqualified" | "ai_abnormal";

export const STATUS_FILTERS: Array<{ value: "" | StatusKey; label: string }> = [
  { value: "", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "pending_invite", label: "待邀约" },
  { value: "invited", label: "已邀约" },
  { value: "disqualified", label: "不符合" },
  { value: "ai_abnormal", label: "AI 异常" },
];

const INVITED_STATES = new Set(["silent_invite", "followup_invite"]);

export function statusOf(c: MobileConversation): StatusKey {
  if (c.recruit_status === "invited" || INVITED_STATES.has(c.state)) return "invited";
  if (c.recruit_status === "disqualified" || c.state === "disqualified") return "disqualified";
  if (c.recruit_status === "pending_invite" || c.state === "pending_invite") return "pending_invite";
  if (c.state === "ai_abnormal") return "ai_abnormal";
  return "active";
}

const STATE_LABEL: Record<string, string> = { new: "新对话", active: "对话中", waiting: "等待回复", silent: "沉默" };

// Detail header label: finer than the list filter (keeps 新对话 / 等待回复 / 沉默).
export function statusLabel(c: MobileConversation): { label: string; tone: Tone } {
  const key = statusOf(c);
  if (key === "invited") return { label: "已邀约", tone: "success" };
  if (key === "pending_invite") return { label: "待邀约", tone: "warning" };
  if (key === "disqualified") return { label: "不符合", tone: "danger" };
  if (key === "ai_abnormal") return { label: "AI 异常", tone: "danger" };
  return { label: STATE_LABEL[c.state] ?? "对话中", tone: "neutral" };
}

export function displayName(c: MobileConversation): string {
  return c.name || c.nickname || String(c.customer_id);
}

export function preview(text: string | undefined): string {
  if (!text) return "";
  if (text.startsWith("###图片")) return "[图片]";
  if (text.startsWith("###文件")) return "[文件]";
  return text;
}

export function shortTime(value: string | null | undefined, now = new Date()): string {
  const ms = parseDbTime(value);
  if (ms === null) return "";
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return localDate(d) === localDate(now) ? hm : `${localDate(d).slice(5)} ${hm}`;
}

export function inRange(c: MobileConversation, start: string, end: string): boolean {
  if (!start || !end) return true;
  const ms = parseDbTime(c.last_msg_at);
  if (ms === null) return false;
  const day = localDate(new Date(ms));
  return day >= start && day <= end;
}

export type MessageBody =
  | { kind: "text"; text: string }
  | { kind: "image" | "video" | "file"; url: string };

const IMAGE_RE = /^###图片（([^）]+)）\s*$/;
const FILE_RE = /^###文件（([^）]+)）\s*$/;
const WRAPPED_RE = /.*?（(.+?)）/;

// Only same-origin paths and http(s) links are rendered as media or links.
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function messageBody(m: MobileMessage): MessageBody {
  const content = (m.content || "").trim();
  const unwrap = (s: string) => s.replace(WRAPPED_RE, "$1");
  const asMedia = (kind: "image" | "video" | "file", raw: string): MessageBody => {
    const url = safeUrl(raw);
    return url ? { kind, url } : { kind: "text", text: m.content };
  };
  if (m.content_type === "image" || IMAGE_RE.test(content)) return asMedia("image", unwrap(content));
  if (m.content_type === "video") return asMedia("video", unwrap(content));
  if (FILE_RE.test(content)) return asMedia("file", unwrap(content));
  return { kind: "text", text: m.content };
}

export function isFromCustomer(m: MobileMessage): boolean {
  return m.role ? m.role === "customer" : m.direction === "inbound";
}

export function lastSevenDays(now = new Date()): [string, string] {
  const start = new Date(now);
  start.setDate(now.getDate() - 6);
  return [localDate(start), localDate(now)];
}

import { ApiError, request, type ListResult } from "./client";

export type StrategyCode = "no_reply" | "date_trigger" | "misjudge" | "paused";
export type RecordStatus =
  | "pending_extract"
  | "pending_generate"
  | "pending_review"
  | "pending_send"
  | "sent"
  | "replied"
  | "failed"
  | "skipped"
  | "frozen"
  | "expired";

export interface ActivationConfig {
  auto_review: boolean;
  freeze_days: number;
  paused: boolean;
  schedule_time: string;
}

export interface DashboardStats {
  today_pending: number;
  today_sent: number;
  today_replied: number;
  reply_rate: number | string;
  frozen_total: number;
  paused: boolean;
}

export interface TrendPoint {
  date: string;
  sent: number;
  replied: number;
}

export interface PopulationSlice {
  name: string;
  value: number;
}

export interface StrategyEffect {
  code: string;
  sent: number;
  replied: number;
  rate: number | string;
  good: number | string | boolean;
}

export interface FeedItem {
  id: string | number;
  type: string;
  nickname: string;
  time: string;
  recruiter_id: string;
}

export interface ActivationRecord {
  id: number | string;
  customer_id: number | string;
  nickname: string;
  strategy: string;
  recruiter_id: string;
  device_code: string;
  device_name?: string;
  status: string;
  summary: string;
  script: string;
  tier: number;
  stale_days?: number;
  frozen_until: string | null;
  next_push_at: string | null;
  reason?: string;
  created_at: string;
  updated_at?: string;
}

export interface RecordQuery {
  page: number;
  page_size: number;
  strategy?: string;
  recruiter_id?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  keyword?: string;
}

export interface RunResult {
  tier?: number;
  next_push_at?: string | null;
  sent_content?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  time: string;
}

export interface HistoryEntry {
  time: string;
  title: string;
  desc: string;
}

/** The old page read {customer, messages, activation_history}; the local backend answers {customer_id, records}. Both are optional here. */
export interface CustomerDetail {
  customer_id?: number | string;
  customer?: Partial<ActivationRecord>;
  summary?: string;
  messages?: ChatMessage[];
  activation_history?: HistoryEntry[];
  records?: ActivationRecord[];
}

export interface AutoPush {
  enabled: boolean;
  offsets_days: number[];
}

export interface Strategy {
  code: string;
  enabled: boolean;
  description: string;
  trigger: string;
  daily_limit: number;
  send_window: string[] | string;
  cooldown_days: number;
  auto_push: AutoPush | null;
  stale_days?: number;
  stale_days_max?: number;
}

export interface StrategyList {
  items: Strategy[];
  engine: { auto_review: boolean; freeze_days: number; schedule_time: string };
}

export interface StrategyPatch {
  enabled?: boolean;
  send_window?: string[];
  daily_limit?: number;
  stale_days?: number;
  stale_days_max?: number;
  auto_push?: AutoPush;
}

export interface StrategyTestResult {
  summary?: string;
  [key: string]: unknown;
}

export interface ActivationDevice {
  device_code: string;
  name: string;
  recruiter_id: string;
  activation_enabled: boolean;
  daily_limit: number;
  hourly_limit: number;
  burst10_limit: number;
  today_sent: number;
  dify_url: string;
}

export interface DeviceLimits {
  hourly_limit: number;
  burst10_limit: number;
  daily_limit: number;
}

export interface Script {
  id: number;
  content: string;
  category: string;
  is_active: boolean;
  used_count: number;
  last_used_at: string;
  updated_at?: string;
}

export interface ScriptList extends ListResult<Script> {
  active_total: number;
  categories: string[];
}

export interface ScriptQuery {
  page: number;
  page_size: number;
  keyword?: string;
  category?: string;
  is_active?: string;
}

export interface ScriptInput {
  content: string;
  category: string;
  is_active: boolean;
}

export interface ImportResult {
  created?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
}

const BASE = "/api/v1/activation";

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** request() always sends JSON content-type; file transfer needs raw fetch with the same token. */
function authHeader(): Record<string, string> {
  const token = localStorage.getItem("rea_token");
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function failure(response: Response, fallback: string): Promise<ApiError> {
  const body = await response.json().catch(() => ({}));
  return new ApiError(response.status, typeof body.detail === "string" ? body.detail : fallback);
}

export const activationApi = {
  config: () => request<ActivationConfig>(`${BASE}/config`),
  setPaused: (paused: boolean) => request<ActivationConfig>(`${BASE}/config/paused`, { method: "PUT", ...json({ paused }) }),
  updateEngine: (patch: Partial<Pick<ActivationConfig, "auto_review" | "schedule_time">>) =>
    request<ActivationConfig>(`${BASE}/config`, { method: "PUT", ...json(patch) }),

  stats: () => request<DashboardStats>(`${BASE}/dashboard/stats`),
  trend: () => request<{ items: TrendPoint[] }>(`${BASE}/dashboard/trend`),
  population: () => request<PopulationSlice[]>(`${BASE}/dashboard/population`),
  strategyEffect: () => request<StrategyEffect[]>(`${BASE}/dashboard/strategy-effect`),
  feed: () => request<{ items: FeedItem[] }>(`${BASE}/dashboard/feed`),

  records: (q: RecordQuery) => request<ListResult<ActivationRecord>>(`${BASE}/records${query(q)}`),
  approve: (id: ActivationRecord["id"], scriptId?: number | null) =>
    request<ActivationRecord>(`${BASE}/records/${id}/approve`, { method: "POST", ...json(scriptId != null ? { script_id: scriptId } : {}) }),
  skip: (id: ActivationRecord["id"], reason?: string) =>
    request<ActivationRecord>(`${BASE}/records/${id}/skip`, { method: "POST", ...json(reason ? { reason } : {}) }),
  freeze: (id: ActivationRecord["id"], days: number) =>
    request<ActivationRecord>(`${BASE}/records/${id}/freeze`, { method: "POST", ...json({ days }) }),
  run: (id: ActivationRecord["id"]) => request<RunResult>(`${BASE}/records/${id}/run`, { method: "POST", ...json({}) }),

  customer: (id: string) => request<CustomerDetail>(`${BASE}/customers/${encodeURIComponent(id)}`),
  updateSummary: (id: string, summary: string) =>
    request<{ summary?: string }>(`${BASE}/customers/${encodeURIComponent(id)}/summary`, { method: "PUT", ...json({ summary }) }),
  regenerateSummary: (id: string) =>
    request<{ summary: string }>(`${BASE}/customers/${encodeURIComponent(id)}/regenerate-summary`, { method: "POST", ...json({}) }),

  strategies: () => request<StrategyList>(`${BASE}/strategies`),
  updateStrategy: (code: string, patch: StrategyPatch) =>
    request<Strategy>(`${BASE}/strategies/${encodeURIComponent(code)}`, { method: "PUT", ...json(patch) }),
  testStrategy: (code: string, customerId: string) =>
    request<StrategyTestResult>(`${BASE}/strategies/${encodeURIComponent(code)}/test`, { method: "POST", ...json({ customer_id: customerId }) }),

  devices: () => request<{ items: ActivationDevice[] }>(`${BASE}/devices`),
  updateDevice: (code: string, patch: Partial<DeviceLimits> & { activation_enabled?: boolean }) =>
    request<{ success: boolean }>(`${BASE}/devices/${encodeURIComponent(code)}`, { method: "PUT", ...json(patch) }),
  batchToggle: (deviceCodes: string[], enabled: boolean) =>
    request<{ success: boolean; updated: number }>(`${BASE}/devices/batch-toggle`, { method: "POST", ...json({ device_codes: deviceCodes, enabled }) }),

  scripts: (q: ScriptQuery) => request<ScriptList>(`${BASE}/scripts${query(q)}`),
  createScript: (input: ScriptInput) => request<Script>(`${BASE}/scripts`, { method: "POST", ...json(input) }),
  updateScript: (id: number, patch: Partial<ScriptInput>) => request<Script>(`${BASE}/scripts/${id}`, { method: "PUT", ...json(patch) }),
  deleteScript: (id: number) => request<{ success: boolean }>(`${BASE}/scripts/${id}`, { method: "DELETE" }),
  async randomScript(): Promise<{ id: number; content: string }> {
    const result = await request<{ id?: number; content?: string; detail?: string }>(`${BASE}/scripts/random`);
    if (typeof result.id !== "number" || !result.content) throw new ApiError(404, result.detail ?? "语料库为空");
    return { id: result.id, content: result.content };
  },
  async exportScripts(): Promise<Blob> {
    const response = await fetch(`${BASE}/scripts/export`, { headers: authHeader() });
    if (!response.ok) throw await failure(response, "导出失败");
    return response.blob();
  },
  async importScripts(file: File): Promise<ImportResult> {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${BASE}/scripts/import`, { method: "POST", headers: authHeader(), body: form });
    if (!response.ok) throw await failure(response, "导入失败");
    return (await response.json()) as ImportResult;
  },
};

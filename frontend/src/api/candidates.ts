import { request } from "./client";

export type CandidateEventType = "invited" | "disqualified" | "checked_in";

export interface Candidate {
  id: number;
  device_code: string;
  customer_id: string;
  nickname: string;
  event_type: string;
  event_at: string;
  name: string;
  phone: string;
  interview_date: string;
  interview_time: string;
  factory_name: string;
  city: string;
  district: string;
  status: string;
  remind_count: number;
  disqualified_reason: string;
  created_at: string;
  wechat_id: string;
}

export interface CandidateQuery {
  event_type: CandidateEventType;
  page: number;
  page_size: number;
  device_code?: string;
  event_date?: string;
  interview_date?: string;
}

export interface MyDevice {
  id: number;
  device_code: string;
  name: string;
}

/** Message rows differ between backends: the target uses `role`, the local one `direction`. */
export interface ChatMessage {
  id: number;
  content: string;
  role?: string;
  direction?: "inbound" | "outbound";
  dedup_original?: string;
  created_at?: string;
}

export type OldFriendStatus = "released" | "unreleased" | "active";

export interface OldFriend {
  id: number;
  account: string;
  customer_id: string;
  nickname: string;
  device_code: string;
  status: OldFriendStatus | string;
  created_at: string;
}

export interface OldFriendQuery {
  page: number;
  page_size: number;
  status?: string;
  account?: string;
  device_code?: string;
  keyword?: string;
}

export interface OldFriendMark {
  device_code: string;
  customer_id: string;
  nickname?: string;
  account?: string;
  status?: string;
}

export interface StatusDashboard {
  devices: { total: number; active_today: number };
  messages: { total: number; hourly: Array<{ hour: number; count: number }> };
  queue: { pending: number };
  errors: { failed_today: number; ai_abnormal: number };
  state_distribution: Record<string, number>;
  device_ranking: Array<{ device_code: string; count: number }>;
  dify_health: Array<{ device_code: string; fail_count: number; last_fail: string }>;
  degraded: Array<{ device_code: string; fail_rate: number }>;
  daily_trend: Array<{ date: string; total: number; invited: number; rate: number }>;
}

export interface EvaluationDevice {
  device_code: string;
  device_name?: string;
  today_score?: number | null;
  trend?: Array<{ date: string; score: number | null }>;
}

export interface DimensionScores {
  conversion?: number;
  independence?: number;
  depth?: number;
  stability?: number;
}

export interface EvaluationSuggestion {
  dimension: string;
  priority: string;
  message: string;
}

export interface EvaluationDetail {
  device_code: string;
  eval_date?: string;
  weighted_score?: number | null;
  level?: string;
  message?: string;
  dimension_scores?: DimensionScores;
  raw_metrics?: Partial<Record<RawMetricKey, number>>;
  suggestions?: EvaluationSuggestion[];
}

export type RawMetricKey =
  | "total_conversations"
  | "total_messages"
  | "ai_message_count"
  | "customer_message_count"
  | "timeout_count"
  | "deep_conv_count"
  | "customer_last_reply_count"
  | "short_ai_msg_count"
  | "invited_count"
  | "takeover_count"
  | "disqualified_count"
  | "checked_in_count";

export interface DailyMetric {
  date: string;
  new_total: number;
  invited: number;
  pending_invite: number;
  disqualified: number;
  checked_in: number;
}

export interface EvaluationRunResult {
  success?: boolean;
  count?: number;
  total?: number;
}

const AGENT = "/api/v1/agent";

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)]);
  const s = new URLSearchParams(entries).toString();
  return s ? `?${s}` : "";
}

export const candidatesApi = {
  list(query: CandidateQuery) {
    return request<{ items: Candidate[]; total: number }>(`${AGENT}/candidates${qs(query)}`);
  },
  mark(id: number, deviceCode: string, status: string) {
    return request<Candidate>(`${AGENT}/candidates/${id}/mark${qs({ device_code: deviceCode })}`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  },
  myDevices() {
    return request<{ items: MyDevice[] }>(`${AGENT}/devices${qs({ my: true })}`);
  },
  messages(deviceCode: string, customerId: string) {
    return request<{ items: ChatMessage[] }>(`${AGENT}/messages${qs({ device_code: deviceCode, customer_id: customerId, after_id: 0 })}`);
  },
};

export const oldFriendsApi = {
  list(query: OldFriendQuery) {
    return request<{ items: OldFriend[]; total: number }>(`${AGENT}/old-friends${qs(query)}`);
  },
  accounts() {
    return request<{ items: string[] }>(`${AGENT}/old-friends/accounts`);
  },
  mark(body: OldFriendMark) {
    return request<OldFriend>(`${AGENT}/old-friends/mark`, { method: "POST", body: JSON.stringify(body) });
  },
  release(id: number) {
    return request<{ success: boolean }>(`${AGENT}/old-friends/${id}/release`, { method: "PUT" });
  },
  unrelease(id: number) {
    return request<{ success: boolean }>(`${AGENT}/old-friends/${id}/unrelease`, { method: "PUT" });
  },
  remove(id: number) {
    return request<{ success: boolean }>(`${AGENT}/old-friends/${id}`, { method: "DELETE" });
  },
};

export const statusApi = {
  dashboard() {
    return request<StatusDashboard>(`${AGENT}/status/dashboard`);
  },
};

export const evaluationApi = {
  overview(days: number) {
    return request<{ days: number; items: EvaluationDevice[] }>(`${AGENT}/evaluation/overview${qs({ days })}`);
  },
  detail(deviceCode: string, evalDate = "") {
    return request<EvaluationDetail>(`${AGENT}/evaluation/detail${qs({ device_code: deviceCode, eval_date: evalDate })}`);
  },
  run(deviceCode = "") {
    return request<EvaluationRunResult>(`${AGENT}/evaluation/run${qs({ device_code: deviceCode })}`, { method: "POST" });
  },
  metrics(params: { device_code?: string; start_date: string; end_date: string }) {
    return request<{ start_date: string; end_date: string; items: DailyMetric[] }>(`${AGENT}/report/metrics${qs(params)}`);
  },
};

import { request, type ListResult } from "./client";

export interface KnowledgeItem {
  id: number;
  question: string;
  /** The list/detail endpoints currently omit the answer; only export returns it. */
  answer?: string;
  keywords: string[];
  is_active: boolean;
  sort_order: number;
  recruiter_id: string;
  updated_at: string | null;
}

export interface KnowledgeInput {
  question: string;
  answer?: string;
  keywords: string[];
  sort_order: number;
  is_active: boolean;
}

export interface KnowledgeExportItem {
  question: string;
  answer: string;
  keywords?: string[];
  sort_order?: number;
  is_active?: boolean;
  recruiter_id?: string;
}

export interface KnowledgeBatchPatch {
  is_active?: boolean;
  sort_order?: number;
}

export type UnknownStatus = "pending" | "resolved" | "ignored";

export interface UnknownQuestion {
  id: number;
  question: string;
  status: UnknownStatus | string;
  count?: number;
  city_name?: string | null;
  merged_questions?: string[];
  last_seen_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ConvertInput {
  question: string;
  answer: string;
  keywords: string[];
}

export interface ReminderConfig {
  id?: number;
  recruiter_id?: string;
  enabled: boolean;
  mode: "advance" | "fixed";
  advance_hours: number;
  fixed_time: string;
  script: string;
}

export interface FollowupConfig {
  id?: number;
  recruiter_id?: string;
  enabled: boolean;
  interval_seconds: number;
  max_count: number;
  scripts: string[];
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "");
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const knowledgeApi = {
  list(search: string, page: number, pageSize: number) {
    return request<ListResult<KnowledgeItem>>(`/api/v1/knowledge?${query({ page, page_size: pageSize, search: search || undefined })}`);
  },
  get(id: number) {
    return request<KnowledgeItem>(`/api/v1/knowledge/${id}`);
  },
  create(input: KnowledgeInput) {
    return request<KnowledgeItem>("/api/v1/knowledge", json("POST", input));
  },
  update(id: number, input: KnowledgeInput) {
    return request<KnowledgeItem>(`/api/v1/knowledge/${id}`, json("PUT", input));
  },
  remove(id: number) {
    return request<{ success: boolean }>(`/api/v1/knowledge/${id}`, { method: "DELETE" });
  },
  exportAll(search: string) {
    return request<KnowledgeExportItem[]>(`/api/v1/knowledge/batch/export?${query({ search: search || undefined })}`);
  },
  importItems(items: KnowledgeExportItem[]) {
    return request<{ created?: number; skipped?: number }>("/api/v1/knowledge/batch/import", json("POST", { items }));
  },
  batchDelete(ids: number[]) {
    return request<{ success: boolean; deleted: number }>("/api/v1/knowledge/batch/delete", json("POST", { ids }));
  },
  batchUpdate(ids: number[], patch: KnowledgeBatchPatch) {
    return request<{ success: boolean; updated: number }>("/api/v1/knowledge/batch/update", json("POST", { ids, ...patch }));
  },
};

export const unknownQuestionsApi = {
  list(params: { page: number; pageSize: number; status: string; search: string }) {
    const q = query({ page: params.page, page_size: params.pageSize, status: params.status || undefined, search: params.search || undefined });
    return request<ListResult<UnknownQuestion>>(`/api/v1/unknown-questions?${q}`);
  },
  convert(id: number, input: ConvertInput) {
    return request<KnowledgeItem>(`/api/v1/unknown-questions/${id}/convert`, json("POST", input));
  },
  remove(id: number) {
    return request<{ success: boolean }>(`/api/v1/unknown-questions/${id}`, { method: "DELETE" });
  },
};

export const agentRulesApi = {
  getReminder() {
    return request<ReminderConfig>("/api/v1/agent/reminder-config");
  },
  saveReminder(config: ReminderConfig) {
    return request<ReminderConfig>("/api/v1/agent/reminder-config", json("POST", config));
  },
  getFollowup() {
    return request<FollowupConfig>("/api/v1/agent/followup-config");
  },
  saveFollowup(config: FollowupConfig) {
    return request<FollowupConfig>("/api/v1/agent/followup-config", json("POST", config));
  },
};

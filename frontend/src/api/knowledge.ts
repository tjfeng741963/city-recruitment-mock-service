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
  device_code?: string;
  customer_id?: string;
  question: string;
  /** 新契约字段名；旧后端用 count。 */
  occurrence_count?: number;
  /** 兼容旧字段，新后端 absence 时回退。 */
  count?: number;
  status: UnknownStatus | string;
  city_name?: string | null;
  merged_questions?: string[];
  created_at?: string;
  last_seen_at?: string | null;
  updated_at?: string;
}

export interface ConvertInput {
  /** 答案必填；标题选填，不传时后端默认取问题原话截断。 */
  answer: string;
  title?: string;
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
  /** 标记已处理。 */
  resolve(id: number) {
    return request<{ success?: boolean }>(`/api/v1/unknown-questions/${id}/resolve`, { method: "POST" });
  },
  convert(id: number, input: ConvertInput) {
    return request<KnowledgeItem>(`/api/v1/unknown-questions/${id}/convert`, json("POST", input));
  },
  remove(id: number) {
    return request<{ success: boolean }>(`/api/v1/unknown-questions/${id}`, { method: "DELETE" });
  },
};

/** /api/v1/kb/entries 话术库（kind=script），8090 提供。 */
export interface KbEntry {
  id: number;
  title?: string;
  question: string;
  answer: string;
  kind: string;
  keywords?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface KbEntryInput {
  title?: string;
  question: string;
  answer: string;
  kind: string;
  keywords?: string[];
}

export const kbEntriesApi = {
  async list(params: { kind?: string; search?: string; page?: number; pageSize?: number } = {}) {
    const q = query({ kind: params.kind, search: params.search, page: params.page, page_size: params.pageSize });
    // 8090 可能返回裸数组或 {items,total}，统一归一化。
    const res = await request<ListResult<KbEntry> | KbEntry[]>(`/api/v1/kb/entries${q ? `?${q}` : ""}`);
    return Array.isArray(res) ? { items: res, total: res.length } : res;
  },
  create(input: KbEntryInput) {
    return request<KbEntry>("/api/v1/kb/entries", json("POST", input));
  },
  update(id: number, input: KbEntryInput) {
    return request<KbEntry>(`/api/v1/kb/entries/${id}`, json("PUT", input));
  },
  remove(id: number) {
    return request<{ success?: boolean }>(`/api/v1/kb/entries/${id}`, { method: "DELETE" });
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

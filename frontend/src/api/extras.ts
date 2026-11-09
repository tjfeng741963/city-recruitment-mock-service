import { ApiError, request, type City, type ListResult } from "./client";
import type { AgentMessage, Conversation } from "./agent";

const qs = (params: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("rea_token");
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function failure(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({}));
  const detail = typeof body.detail === "string" ? body.detail : `请求失败（${response.status}）`;
  return new ApiError(response.status, detail);
}

// request() always sends JSON; uploads and file downloads need the raw fetch.
async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(path, { method: "POST", headers: authHeader(), body: form });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

async function download(path: string): Promise<Blob> {
  const response = await fetch(path, { headers: authHeader() });
  if (!response.ok) throw await failure(response);
  return response.blob();
}

/* ---------- 放假总表 ---------- */

export interface HolidaySchedule {
  id: number;
  city_name: string;
  interview_site_name: string;
  year: number;
  holiday_name: string;
  start_date: string;
  end_date: string;
  can_interview: boolean;
  is_makeup_day: boolean;
  special_note: string;
  sort_order: number;
  is_active: boolean;
  updated_at?: string;
}

export type HolidayInput = Omit<HolidaySchedule, "id" | "updated_at">;

export interface HolidayFilter {
  city_name?: string;
  year?: number;
  is_active?: boolean;
}

export interface MyCity {
  city_name: string;
  interview_site_name: string;
  id?: number;
}

export interface ImportResult {
  success?: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
}

// The local replica stores holidays in (city_id, date, kind) columns that the target
// API does not expose. Sending them alongside the target fields keeps both backends happy.
function withStorageFields(input: HolidayInput, cityId?: number) {
  return { ...input, city_id: cityId, date: input.start_date, kind: input.is_makeup_day ? "makeup" : "holiday" };
}

export const holidayApi = {
  async myCities(): Promise<MyCity[]> {
    const mine = await request<{ cities: MyCity[]; unlimited: boolean }>("/api/v1/holiday-schedules/my-cities");
    const all = await request<ListResult<City & { interview_site_name?: string }>>("/api/v1/cities?page_size=1000").catch(() => null);
    const ids = new Map((all?.items ?? []).map((c) => [c.city_name, c] as const));
    const base: MyCity[] = mine.unlimited && all
      ? all.items.map((c) => ({ city_name: c.city_name, interview_site_name: c.interview_site_name ?? "" }))
      : mine.cities;
    return base.map((c) => ({ ...c, id: ids.get(c.city_name)?.id }));
  },
  list(filter: HolidayFilter) {
    // Filtering and paging are done on the page; the cap matches the server's page_size limit.
    return request<ListResult<HolidaySchedule>>(`/api/v1/holiday-schedules?${qs({ ...filter, page: 1, page_size: 1000 })}`);
  },
  create(input: HolidayInput, cityId?: number) {
    return request<HolidaySchedule>("/api/v1/holiday-schedules", { method: "POST", body: JSON.stringify(withStorageFields(input, cityId)) });
  },
  update(id: number, input: HolidayInput, cityId?: number) {
    return request<HolidaySchedule>(`/api/v1/holiday-schedules/${id}`, { method: "PUT", body: JSON.stringify(withStorageFields(input, cityId)) });
  },
  remove(id: number) {
    return request<unknown>(`/api/v1/holiday-schedules/${id}`, { method: "DELETE" });
  },
  exportPositionHolidays() {
    return download("/api/v1/service-positions/holidays-export");
  },
  importPositionHolidays(file: File) {
    return upload<ImportResult>("/api/v1/service-positions/holidays-import", file);
  },
};

/* ---------- 城市关联 ---------- */

export interface CityLinkOptions {
  options: Array<{ city: string; count: number }>;
  default_districts: Record<string, string[]>;
}

export interface CityLinkState {
  links: Record<string, string[]>;
  districts: Record<string, string[]>;
}

export interface CityLinkEntry {
  source_city: string;
  target_cities: string[];
  districts: string[];
}

export const cityLinkApi = {
  options() {
    return request<CityLinkOptions>("/api/v1/city-links/options");
  },
  list() {
    return request<CityLinkState>("/api/v1/city-links");
  },
  save(links: CityLinkEntry[]) {
    return request<unknown>("/api/v1/city-links/batch", { method: "POST", body: JSON.stringify({ links }) });
  },
};

/* ---------- 账户汇总 ---------- */

export interface SummaryTotal {
  device_count: number;
  new_conversations: number;
  invited: number;
  pending_invite: number;
  disqualified: number;
  checked_in: number;
  invite_rate: number;
}

export interface SummaryAccount {
  recruiter_id: string;
  name: string;
  device_count: number;
  new_total: number;
  invited: number;
  pending_invite: number;
  disqualified: number;
  checked_in: number;
}

export interface SummaryDay {
  date: string;
  new_total: number;
  invited: number;
  rate: number;
}

export interface AccountSummary {
  prefix: string;
  date_range: { start: string; end: string };
  total?: Partial<SummaryTotal>;
  accounts?: SummaryAccount[];
  daily_trend?: SummaryDay[];
}

export const summaryApi = {
  get(prefix: string, startDate: string, endDate: string) {
    return request<AccountSummary>(`/api/v1/agent/report/account-summary?${qs({ prefix, start_date: startDate, end_date: endDate })}`);
  },
};

/* ---------- 手机端聊天 ---------- */

export interface MobileDevice {
  id: number;
  device_code: string;
  name: string;
  online?: boolean;
}

export type MobileConversation = Conversation & {
  name?: string;
  remark?: string;
  is_old_friend?: boolean;
  interview_date?: string | null;
};

export type MobileMessage = AgentMessage & {
  role?: string;
  content_type?: string;
  dedup_original?: string;
};

export interface FeaturedPosition {
  id: number;
  position_name: string;
  store_name?: string;
  district?: string;
  is_featured?: boolean;
}

export interface FeaturedCity {
  city_name: string;
  has_custom?: boolean;
  position_ids?: number[];
  positions?: FeaturedPosition[];
}

export const mobileApi = {
  myDevices() {
    return request<{ items: MobileDevice[] }>("/api/v1/agent/devices?my=true");
  },
  conversations(deviceCode: string, startDate?: string, endDate?: string) {
    return request<{ items: MobileConversation[]; total_unread?: number }>(
      `/api/v1/agent/conversations?${qs({ device_code: deviceCode, start_date: startDate, end_date: endDate })}`,
    );
  },
  messages(deviceCode: string, customerId: number, afterId = 0) {
    return request<{ items: MobileMessage[]; takeover?: boolean }>(
      `/api/v1/agent/messages?${qs({ device_code: deviceCode, customer_id: customerId, after_id: afterId })}`,
    );
  },
  resetDisqualified(deviceCode: string, customerId: number) {
    return request<unknown>(`/api/v1/agent/conversations/${customerId}/reset-disqualified?${qs({ device_code: deviceCode })}`, { method: "PUT" });
  },
  restart(deviceCode: string, customerId: number) {
    return request<unknown>(`/api/v1/agent/conversations/${customerId}/restart?${qs({ device_code: deviceCode })}`, { method: "PUT" });
  },
  markOldFriend(deviceCode: string, customerId: number, nickname: string) {
    return request<unknown>("/api/v1/agent/old-friends/mark", {
      method: "POST",
      body: JSON.stringify({ device_code: deviceCode, customer_id: customerId, nickname }),
    });
  },
  uploadFile(file: File) {
    // The old page sent images and videos through the image endpoint as well.
    return upload<{ url: string }>("/api/v1/upload/image", file);
  },
  featuredCities() {
    return request<{ cities?: FeaturedCity[]; max_featured?: number }>("/api/v1/recruiter-featured/cities");
  },
  setCityFeatured(cityName: string, positionIds: number[]) {
    return request<unknown>(`/api/v1/recruiter-featured/cities/${encodeURIComponent(cityName)}`, {
      method: "PUT",
      body: JSON.stringify({ position_ids: positionIds }),
    });
  },
};

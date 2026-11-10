import { request, type City, type ListResult } from "./client";

export interface Position {
  id: number;
  position_name: string;
  city_name: string;
  district: string;
  gender: string;
  age_range: string;
  job_type: string;
  accommodation: string;
  contact_phone: string;
  store_name: string;
  interview_time: string;
  is_active: boolean;
  is_featured: boolean;
  base_sections: Record<string, string>;
  base_section_labels: Record<string, string>;
  updated_at?: string;
}

export interface Holiday {
  id: number;
  position_id: number;
  holiday_date: string;
  label: string;
  is_active: number;
}

export interface DeviceDetail {
  id: number;
  device_code: string;
  name: string;
  recruiter_id: string;
  mode: string;
  created_at: string;
}

export interface BridgeCommand {
  id: string;
  status: "queued" | "claimed" | "succeeded" | "failed" | "unknown";
  message_id: string;
  simulated: number;
  created_at: number;
}

export interface Settings {
  company_name: string;
  dedup_llm_api_key: string;
  dedup_llm_model: string;
  requirements: { age_range: string; age_limit: { min: number; max: number } };
}

export interface Recruiter {
  id: number;
  recruiter_id: string;
  name: string;
  description: string;
  is_active: boolean;
  city_count: number;
  cities: Array<{ id: number; city_name: string }>;
}

export interface AdminUser {
  id: number;
  username: string;
  role: "admin" | "customer" | "recruiter";
  recruiter_id: string;
  is_active: number;
  created_at: string;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const positionsApi = {
  cities: () => request<ListResult<City>>("/api/v1/cities?page_size=1000"),
  createCity: (city_name: string, province: string) =>
    request<City>("/api/v1/cities", { method: "POST", ...json({ city_name, province }) }),
  setCityStatus: (id: number, recruitment_status: string) =>
    request<City>(`/api/v1/cities/${id}/status`, { method: "PATCH", ...json({ recruitment_status }) }),
  // Filters by city_id server-side; positions' own city_name field is often blank.
  positionsInCity: (cityName: string) =>
    request<ListResult<Position>>(`/api/v1/service-positions?city_name=${enc(cityName)}&page_size=1000`),
  position: (id: number) => request<Position>(`/api/v1/service-positions/${id}`),
  createPosition: (position_name: string, store_name: string, city: City) =>
    request<Position>("/api/v1/service-positions", {
      method: "POST",
      ...json({ position_name, store_name, city_id: city.id, city_name: city.city_name, is_active: true }),
    }),
  updatePosition: (id: number, body: Record<string, unknown>) =>
    request<Position>(`/api/v1/service-positions/${id}`, { method: "PUT", ...json(body) }),
  toggleFeatured: (id: number) => request<Position>(`/api/v1/service-positions/${id}/toggle-featured`, { method: "PUT" }),
  holidays: (positionId: number) => request<ListResult<Holiday>>(`/api/v1/service-positions/${positionId}/holidays`),
  // The request contract demands year/holiday_name/start_date/end_date; the handler stores holiday_date/label.
  addHoliday: (positionId: number, name: string, date: string) =>
    request<Holiday>(`/api/v1/service-positions/${positionId}/holidays`, {
      method: "POST",
      ...json({ year: Number(date.slice(0, 4)), holiday_name: name, start_date: date, end_date: date, holiday_date: date, label: name }),
    }),
  removeHoliday: (positionId: number, holidayId: number) =>
    request<{ success: boolean }>(`/api/v1/service-positions/${positionId}/holidays/${holidayId}`, { method: "DELETE" }),
};

export const devicesApi = {
  list: () => request<{ items: DeviceDetail[] }>("/api/v1/agent/devices"),
  create: (device_code: string, name: string) =>
    request<DeviceDetail>("/api/v1/agent/devices", { method: "POST", ...json({ device_code, name, device_name: name, status: "enabled" }) }),
  rename: (id: number, name: string) =>
    request<unknown>(`/api/v1/agent/devices/${id}`, { method: "PUT", ...json({ name, device_name: name }) }),
  bridge: (code: string) =>
    request<{ device: { state: string; heartbeat_at: number; account_id: string } | null; commands: BridgeCommand[] }>(
      `/api/v1/bridge/devices/${enc(code)}`,
    ),
  pair: (code: string) =>
    request<{ device_code: string; device_token: string }>(`/api/v1/bridge/devices/${enc(code)}/pair`, { method: "POST", ...json({}) }),
  workflow: (id: number) => request<{ ok: boolean; message: string }>(`/api/v1/agent/device/${id}/workflow`),
};

export const settingsApi = {
  get: () => request<Settings>("/api/v1/settings"),
  save: (patch: Partial<Settings>) => request<Settings>("/api/v1/settings", { method: "PUT", ...json(patch) }),
  recruiters: () => request<ListResult<Recruiter>>("/api/v1/recruiters?page_size=1000"),
  createRecruiter: (recruiter_id: string, name: string) =>
    request<Recruiter>("/api/v1/recruiters", { method: "POST", ...json({ recruiter_id, name, status: "enabled" }) }),
  addRecruiterCity: (id: number, cityId: number) =>
    request<{ success: boolean }>(`/api/v1/recruiters/${id}/cities`, { method: "POST", ...json({ city_id: cityId }) }),
  removeRecruiterCity: (id: number, cityId: number) =>
    request<{ success: boolean }>(`/api/v1/recruiters/${id}/cities/${cityId}`, { method: "DELETE" }),
  users: () => request<{ items: AdminUser[]; total: number }>("/api/v1/auth/users"),
  createUser: (body: { username: string; password: string; role: AdminUser["role"]; recruiter_id: string }) =>
    request<AdminUser>("/api/v1/auth/users", { method: "POST", ...json(body) }),
  disableUser: (id: number) => request<{ success: boolean }>(`/api/v1/auth/users/${id}`, { method: "DELETE" }),
};

import http from './http'
import type {
  AgentDevice,
  City,
  CityPayload,
  Factory,
  OkResult,
  PageQuery,
  PageResult,
  ServicePosition,
} from './types'

export type { City, CityPayload, Factory, ServicePosition, AgentDevice }

export interface LocationCardOption {
  sha256: string
  name: string
  address: string
  bytes: number
  device_code?: string
  account_id?: string
}

export const locationCardsApi = {
  list: (accountId?: string) => http.get<{ items: LocationCardOption[]; favorites?: Array<Record<string, unknown>> }>(
    '/api/v1/location-cards', { params: accountId ? { account_id: accountId } : undefined },
  ),
}

/** 城市历史快照（GET /cities/:id/history 的行结构） */
export interface CityHistoryEntry {
  id: number
  city_id: number
  snapshot_json: string
  created_at?: string
  [key: string]: unknown
}

/** 岗位节假日记录 */
export interface PositionHoliday {
  id: number
  position_id?: number
  holiday_date: string
  label?: string
  is_active?: boolean | number
  [key: string]: unknown
}

/** 全局节假日安排 */
export interface HolidaySchedule {
  id: number
  city_id?: number | null
  city_name?: string
  year?: number
  holiday_name?: string
  start_date?: string
  end_date?: string
  date?: string
  is_active?: boolean
  status?: string
  [key: string]: unknown
}

/** 周边城市页的候选城市 */
export interface CityLinkOption {
  city: string
  count: number
}

/** 周边城市设置（后端返回 {districts, links} 两个字典） */
export interface CityLinksPayload {
  districts: Record<string, string[]>
  links: Record<string, string[]>
}

/** 岗位导入/导出结果 */
export interface ImportResult extends OkResult {
  total?: number
  created?: number
  updated?: number
  filename?: string | null
}

/** 岗位 Agent 配置摘要（列表页「配置数」） */
export interface PositionPersonaSummary {
  position_id: number
  has_persona: boolean
  opening_count: number
}

/** 统一提取后端错误文案（detail 可能是字符串或校验错误数组） */
export function apiErrorMessage(error: unknown, fallback = '操作失败'): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) return String((item as { msg: unknown }).msg)
        return String(item)
      })
      .filter(Boolean)
    if (messages.length) return messages.join('；')
  }
  return fallback
}

export const citiesApi = {
  list: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<City>>('/api/v1/cities', { params }),
  get: (id: number | string) => http.get<City>(`/api/v1/cities/${id}`),
  create: (payload: CityPayload) => http.post<City>('/api/v1/cities', payload),
  updateBasics: (id: number | string, payload: { city_name: string; province: string; districts: string[] }) =>
    http.patch<City>(`/api/v1/cities/${id}`, payload),
  update: (id: number | string, payload: Partial<CityPayload>) =>
    http.put<City>(`/api/v1/cities/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/cities/${id}`),
  setStatus: (id: number | string, status: string) =>
    http.patch<City>(`/api/v1/cities/${id}/status`, { recruitment_status: status }),
  history: (id: number | string, params: PageQuery = { page: 1, page_size: 20 }) =>
    http.get<PageResult<Record<string, unknown>>>(`/api/v1/cities/${id}/history`, { params }),
  historyDetail: (id: number | string, historyId: number | string) =>
    http.get<Record<string, unknown>>(`/api/v1/cities/${id}/history/${historyId}`),
  restore: (id: number | string, historyId: number | string) =>
    http.post<City>(`/api/v1/cities/${id}/restore/${historyId}`),
}

/** ---------- 厂区 ---------- */
export const factoriesApi = {
  list: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<Factory>>('/api/v1/factories', { params }),
  get: (id: number | string) => http.get<Factory>(`/api/v1/factories/${id}`),
  create: (payload: Partial<Factory>) => http.post<Factory>('/api/v1/factories', payload),
  update: (id: number | string, payload: Partial<Factory>) =>
    http.put<Factory>(`/api/v1/factories/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/factories/${id}`),
  byCity: (cityId: number | string) =>
    http.get<{ items?: Factory[] } | Factory[]>(`/api/v1/cities/${cityId}/factories`),
  createInCity: (cityId: number | string, payload: Partial<Factory>) =>
    http.post<Factory>(`/api/v1/cities/${cityId}/factories`, payload),
  updateInCity: (cityId: number | string, factoryId: number | string, payload: Partial<Factory>) =>
    http.put<Factory>(`/api/v1/cities/${cityId}/factories/${factoryId}`, payload),
  removeInCity: (cityId: number | string, factoryId: number | string) =>
    http.delete<OkResult>(`/api/v1/cities/${cityId}/factories/${factoryId}`),
}

/** ---------- 岗位 ---------- */
export const positionsApi = {
  list: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<ServicePosition>>('/api/v1/service-positions', { params }),
  get: (id: number | string) => http.get<ServicePosition>(`/api/v1/service-positions/${id}`),
  create: (payload: Partial<ServicePosition>) =>
    http.post<ServicePosition>('/api/v1/service-positions', payload),
  update: (id: number | string, payload: Partial<ServicePosition>) =>
    http.put<ServicePosition>(`/api/v1/service-positions/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/service-positions/${id}`),
  toggleFeatured: (id: number | string, featured?: boolean) =>
    http.put<ServicePosition>(`/api/v1/service-positions/${id}/toggle-featured`, featured === undefined ? {} : { is_featured: featured }),
  bindingGet: (id: number | string) =>
    http.get<Record<string, unknown>>(`/api/v1/service-positions/${id}/factory-binding`),
  bindingPut: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/service-positions/${id}/factory-binding`, payload),
  personaSummary: () =>
    http.get<{ items?: PositionPersonaSummary[] }>('/api/v1/agent-persona'),
  holidays: (id: number | string) =>
    http.get<{ items?: PositionHoliday[] } | PositionHoliday[]>(
      `/api/v1/service-positions/${id}/holidays`,
    ),
  addHoliday: (id: number | string, payload: Record<string, unknown>) =>
    http.post<PositionHoliday>(`/api/v1/service-positions/${id}/holidays`, payload),
  updateHoliday: (id: number | string, holidayId: number | string, payload: Record<string, unknown>) =>
    http.put<PositionHoliday>(
      `/api/v1/service-positions/${id}/holidays/${holidayId}`,
      payload,
    ),
  removeHoliday: (id: number | string, holidayId: number | string) =>
    http.delete<OkResult>(`/api/v1/service-positions/${id}/holidays/${holidayId}`),
  holidaysExport: () =>
    http.get<Blob>('/api/v1/service-positions/holidays-export', { responseType: 'blob' }),
  holidaysImport: (form: FormData) =>
    http.post<ImportResult>('/api/v1/service-positions/holidays-import', form),
  jingcaiImport: (form: FormData, recruiterId?: string) =>
    http.post<ImportResult>(
      '/api/v1/service-positions/jingcai-import',
      form,
      recruiterId ? { params: { recruiter_id: recruiterId } } : undefined,
    ),
}

/** ---------- 周边城市 ---------- */
export const cityLinksApi = {
  list: () => http.get<CityLinksPayload>('/api/v1/city-links'),
  options: () =>
    http.get<{ options?: CityLinkOption[]; default_districts?: Record<string, string[]> }>(
      '/api/v1/city-links/options',
    ),
  batch: (payload: {
    links: Array<{ source_city: string; target_cities: string[]; districts?: string[] }>
  }) => http.post<{ saved?: number }>('/api/v1/city-links/batch', payload),
}

/** ---------- 节假日 ---------- */
export const holidaysApi = {
  list: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<HolidaySchedule>>('/api/v1/holiday-schedules', { params }),
  get: (id: number | string) => http.get<HolidaySchedule>(`/api/v1/holiday-schedules/${id}`),
  create: (payload: Record<string, unknown>) =>
    http.post<HolidaySchedule>('/api/v1/holiday-schedules', payload),
  update: (id: number | string, payload: Record<string, unknown>) =>
    http.put<HolidaySchedule>(`/api/v1/holiday-schedules/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/holiday-schedules/${id}`),
  myCities: () =>
    http.get<{ cities?: Array<{ city_name: string; interview_site_name?: string }>; unlimited?: boolean }>(
      '/api/v1/holiday-schedules/my-cities',
    ),
}

/** ---------- 基础字典 ---------- */
export const dictApi = {
  locations: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<Record<string, unknown>>>('/api/v1/locations', { params }),
  createLocation: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/locations', payload),
  updateLocation: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/locations/${id}`, payload),
  removeLocation: (id: number | string) => http.delete<OkResult>(`/api/v1/locations/${id}`),
  employers: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<Record<string, unknown>>>('/api/v1/employers', { params }),
  createEmployer: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/employers', payload),
  updateEmployer: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/employers/${id}`, payload),
  removeEmployer: (id: number | string) => http.delete<OkResult>(`/api/v1/employers/${id}`),
  verticals: () => http.get<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    '/api/v1/verticals',
  ),
  createVertical: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/verticals', payload),
  updateVertical: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/verticals/${id}`, payload),
  removeVertical: (id: number | string) => http.delete<OkResult>(`/api/v1/verticals/${id}`),
}

/** ---------- 导入导出 / 素材 ---------- */
export const transferApi = {
  template: () => http.get<Blob>('/api/v1/import-export/template', { responseType: 'blob' }),
  importAll: (form: FormData) =>
    http.post<ImportResult>('/api/v1/import-export/import', form),
  exportFactories: () =>
    http.get<Blob>('/api/v1/import-export/factories/export', { responseType: 'blob' }),
  importFactories: (form: FormData) =>
    http.post<ImportResult>('/api/v1/import-export/factories/import', form),
  exportPositions: () =>
    http.get<Blob>('/api/v1/import-export/service-positions/export', { responseType: 'blob' }),
  importPositions: (form: FormData) =>
    http.post<ImportResult>('/api/v1/import-export/service-positions/import', form),
}

/** ---------- 工厂配置总览：设备聚合 ---------- */
export const overviewApi = {
  devices: () => http.get<{ items?: AgentDevice[] }>('/api/v1/agent/devices'),
}

export const mediaApi = {
  list: (params: PageQuery = { page: 1, page_size: 100 }) =>
    http.get<PageResult<Record<string, unknown>>>('/api/v1/media', { params }),
  /** base64 JSON 直传（media_assets 内容寻址），与 /upload/image 的临时文件通道不同 */
  add: (payload: Record<string, unknown>) => http.post<Record<string, unknown>>('/api/v1/media', payload),
  uploadImage: (form: FormData) => http.post<Record<string, unknown>>('/api/v1/upload/image', form),
  uploadVideo: (form: FormData) => http.post<Record<string, unknown>>('/api/v1/upload/video', form),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/media/${id}`),
  bind: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/media/${id}/binding`, payload),
  downloadUrl: (name: string) => `/api/v1/agent/media/${encodeURIComponent(name)}`,
}

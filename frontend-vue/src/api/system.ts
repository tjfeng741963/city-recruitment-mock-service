import http from './http'
import type { OkResult, PageQuery, Recruiter } from './types'

export { apiErrorMessage } from './core'

/** 列表接口统一返回 { items, total }，部分接口额外带 page/page_size */
export interface ListResult<T> {
  items: T[]
  total: number
  page?: number
  page_size?: number
  [key: string]: unknown
}

/* ---------------- 招聘员 ---------------- */

export interface RecruiterCity {
  city_id: number
  city_name: string
  is_enabled?: boolean | number
  sort_order?: number
  recruiter_id?: string
  [key: string]: unknown
}

export interface CityOption {
  id: number
  city_name: string
  [key: string]: unknown
}

export interface RecruiterPayload {
  recruiter_id?: string
  name?: string
  description?: string
  recruiter_type?: string
  is_active?: boolean
  sort_order?: number
  llm_config?: Record<string, unknown>
}

export const recruiterTypes = [
  { value: 'service', label: '服务员' },
  { value: 'agent', label: '代理' },
] as const

export function recruiterTypeLabel(value?: string): string {
  return recruiterTypes.find((item) => item.value === value)?.label || value || '-'
}

export const recruitersApi = {
  list: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<ListResult<Recruiter>>('/api/v1/recruiters', { params }),
  get: (id: number | string) => http.get<Recruiter>(`/api/v1/recruiters/${id}`),
  create: (payload: RecruiterPayload) =>
    http.post<Recruiter>('/api/v1/recruiters', payload),
  update: (id: number | string, payload: RecruiterPayload) =>
    http.put<Recruiter>(`/api/v1/recruiters/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/recruiters/${id}`),
  setPassword: (id: number | string, password: string) =>
    http.put<OkResult>(`/api/v1/recruiters/${id}/password`, { password }),

  /** 负责城市 */
  cities: (id: number | string) =>
    http.get<ListResult<RecruiterCity>>(`/api/v1/recruiters/${id}/cities`),
  addCity: (id: number | string, cityId: number) =>
    http.post<OkResult>(`/api/v1/recruiters/${id}/cities`, { city_id: cityId }),
  addCities: (id: number | string, cityIds: number[]) =>
    http.post<OkResult>(`/api/v1/recruiters/${id}/cities/batch`, { city_ids: cityIds }),
  /** 幂等重写单条负责城市绑定（PUT /recruiters/:id/cities/:cityId） */
  syncCity: (id: number | string, cityId: number) =>
    http.put<OkResult>(`/api/v1/recruiters/${id}/cities/${cityId}`, {}),
  removeCity: (id: number | string, cityId: number) =>
    http.delete<OkResult>(`/api/v1/recruiters/${id}/cities/${cityId}`),
  /** 城市下拉选项（用于负责城市绑定） */
  cityOptions: () =>
    http.get<ListResult<CityOption>>('/api/v1/cities', { params: { page: 1, page_size: 1000 } }),

  /** 服务城市 */
  serviceCities: (id: number | string) =>
    http.get<ListResult<RecruiterCity>>(`/api/v1/recruiters/${id}/service-cities`),
  serviceCityOptions: (id: number | string) =>
    http.get<ListResult<CityOption>>(`/api/v1/recruiters/${id}/service-cities/options`),
  batchServiceCities: (id: number | string, cityNames: string[], isEnabled = true) =>
    http.post<OkResult>(`/api/v1/recruiters/${id}/service-cities/batch`, {
      city_names: cityNames,
      is_enabled: isEnabled,
    }),
}

/* ---------------- 用户与权限 ---------------- */

export interface UserItem {
  id: number
  username: string
  role: string
  recruiter_id?: string
  recruiter_type?: string
  is_active?: number | boolean
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface UserPayload {
  username?: string
  password?: string
  role?: string
  recruiter_id?: string
  recruiter_type?: string
  is_active?: boolean
}

export type ScopeType = 'recruiter' | 'city' | 'device'
export interface UserScope {
  type: ScopeType
  id: string
}

export interface DeviceOption {
  device_code: string
  name?: string
  [key: string]: unknown
}

export const userRoles = [
  { value: 'admin', label: '管理员', tag: 'danger' },
  { value: 'customer', label: '客户', tag: 'info' },
  { value: 'recruiter', label: '招聘员', tag: 'warning' },
] as const

export function roleLabel(role?: string): string {
  return userRoles.find((item) => item.value === role)?.label || role || '-'
}

export function roleTagType(role?: string): 'danger' | 'info' | 'warning' {
  return (userRoles.find((item) => item.value === role)?.tag || 'info') as
    | 'danger'
    | 'info'
    | 'warning'
}

export const usersApi = {
  list: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<ListResult<UserItem>>('/api/v1/auth/users', { params }),
  create: (payload: UserPayload) =>
    http.post<UserItem>('/api/v1/auth/users', payload),
  update: (id: number | string, payload: UserPayload) =>
    http.put<UserItem>(`/api/v1/auth/users/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/auth/users/${id}`),
  resetPassword: (id: number | string, password: string) =>
    http.post<OkResult>(`/api/v1/auth/users/${id}/reset-password`, { password }),
  scopes: (id: number | string) =>
    http.get<{ scopes?: UserScope[] }>(`/api/v1/auth/users/${id}/scopes`),
  saveScopes: (id: number | string, scopes: UserScope[]) =>
    http.put<{ scopes?: UserScope[] }>(`/api/v1/auth/users/${id}/scopes`, { scopes }),
  /** 权限范围抽屉的设备候选：坐席设备列表 */
  deviceOptions: () =>
    http.get<ListResult<DeviceOption>>('/api/v1/agent/devices', {
      params: { page: 1, page_size: 1000 },
    }),
}

/* ---------------- 主推设置 ---------------- */

export interface FeaturedPosition {
  id: number
  position_name: string
  city_name?: string
  factory_id?: number | null
  is_featured?: boolean
  [key: string]: unknown
}

export interface FeaturedCity {
  city_id: number
  city_name: string
  has_custom?: boolean
  position_ids?: number[]
  positions?: FeaturedPosition[]
  [key: string]: unknown
}

export interface FeaturedCityList {
  items: FeaturedCity[]
  total: number
  max_featured?: number
}

export const featuredApi = {
  list: () => http.get<FeaturedCityList>('/api/v1/recruiter-featured/cities'),
  save: (cityId: number | string, positionIds: number[]) =>
    http.put<OkResult>(`/api/v1/recruiter-featured/cities/${cityId}`, {
      position_ids: positionIds,
    }),
  remove: (cityId: number | string) =>
    http.delete<OkResult>(`/api/v1/recruiter-featured/cities/${cityId}`),
}

/* ---------------- 全局设置 ---------------- */

export interface GlobalSettings {
  company_name: string
  dedup_llm_api_key?: string
  dedup_llm_model?: string
  requirements: {
    age_range: string
    age_limit: {
      min: number
      max: number
    }
  }
}

export interface AgentSettings {
  agent_base_url: string
  is_default?: boolean
}

export interface SyncResult {
  success?: boolean
  synced?: string[]
  [key: string]: unknown
}

export interface ImportResult {
  success?: boolean
  filename?: string | null
  total?: number
  created?: number
  updated?: number
}

export type SettingsPayload = GlobalSettings & Record<string, unknown>

export interface AgentModelSettings {
  base_url: string
  model: string
  source: 'settings' | 'environment'
  key_configured: boolean
  revision: number
  updated_at: string | null
}

type ModelCredentials = { base_url: string; api_key?: string }
type ModelDraft = ModelCredentials & { model: string; revision: number }
const agentModelPath = '/api/v1/settings/agent/model'

export const settingsApi = {
  get: () => http.get<GlobalSettings>('/api/v1/settings'),
  save: (payload: SettingsPayload) => http.put<GlobalSettings>('/api/v1/settings', payload),
  agentGet: () => http.get<AgentSettings>('/api/v1/settings/agent'),
  agentSave: (agentBaseUrl: string) =>
    http.put<AgentSettings>('/api/v1/settings/agent', { agent_base_url: agentBaseUrl }),
  agentModel: () => http.get<AgentModelSettings>(agentModelPath),
  discoverAgentModels: (payload: ModelCredentials) =>
    http.post<{ models: string[] }>(agentModelPath + '/models', payload, { timeout: 15000 }),
  testAgentModel: (payload: ModelDraft) =>
    http.post<{ test_id: string; latency_ms: number }>(agentModelPath + '/test', payload, { timeout: 25000 }),
  saveAgentModel: (payload: ModelDraft & { test_id: string }) =>
    http.put<AgentModelSettings>(agentModelPath, payload),
  sync: () => http.post<SyncResult>('/api/v1/settings/sync', {}),

  /** 数据初始化模板（xlsx blob） */
  downloadTemplate: () =>
    http.get<Blob>('/api/v1/import-export/template', { responseType: 'blob' }),
  /** 导入数据（multipart/form-data，字段名 file） */
  importFile: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return http.post<ImportResult>('/api/v1/import-export/import', form)
  },
}

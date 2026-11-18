/** 通用分页与共用结构 */
export interface PageQuery {
  page?: number
  page_size?: number
  [key: string]: unknown
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface OkResult {
  ok?: boolean
  message?: string
  [key: string]: unknown
}

export interface City {
  id: number
  city_name: string
  recruitment_status: 'active' | 'inactive' | string
  available_lines?: string[]
  [key: string]: unknown
}

export interface CityPayload {
  city_name: string
  recruitment_status?: string
  available_lines?: string[]
  [key: string]: unknown
}

export interface Factory {
  id: number
  factory_name: string
  city_id?: number
  [key: string]: unknown
}

export interface ServicePosition {
  id: number
  position_name: string
  city_name?: string
  factory_id?: number | null
  is_featured?: boolean
  is_active?: boolean
  [key: string]: unknown
}

export interface Recruiter {
  id: number
  recruiter_id: string
  name: string
  description?: string
  recruiter_type?: string
  is_active?: boolean
  sort_order?: number
  city_count?: number
  cities?: unknown[]
  password_set?: boolean
  updated_at?: string
  [key: string]: unknown
}

export interface AgentDevice {
  id: number
  device_code: string
  name: string
  recruiter_id?: string
  factory_name?: string
  city?: string
  status?: boolean
  online?: boolean
  mode?: string
  config?: Record<string, unknown>
  [key: string]: unknown
}

export interface User {
  id?: number
  username: string
  role?: string
  recruiter_id?: string | null
  created_at?: string
  [key: string]: unknown
}

/** 岗位：与 ServicePosition 同构，保留旧命名以兼容既有页面 */
export interface Position {
  id: number
  position_name: string
  city_name?: string
  factory_id?: number | null
  gender?: string
  job_type?: string
  accommodation?: string
  age_range?: string
  is_featured?: boolean
  is_active?: boolean
  updated_at?: string
  base_sections?: Record<string, string>
  [key: string]: unknown
}

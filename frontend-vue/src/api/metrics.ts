import http from './http'
import type { PageQuery, PageResult } from './types'

/** ---------- 后台运营总览（监控看板 / 设备报表） ---------- */
export interface AdminOverview {
  total_users: number
  active_users: number
  recruiters: number
  cities: number
  positions: number
  devices: number
  conversations: number
  pending_activations: number
  retry_jobs: number
  dead_jobs: number
  rejected_webhooks: number
  [key: string]: unknown
}

export interface HourlyMessagePoint {
  hour: number
  count: number
}

export interface DailyTrendPoint {
  date: string
  total: number
  invited: number
  rate: number
  [key: string]: unknown
}

export interface DifyHealthItem {
  device_code: string
  fail_count: number
  last_fail: string
  [key: string]: unknown
}

export interface DeviceMessageRankItem {
  device_code: string
  count: number
  [key: string]: unknown
}

export interface DegradedDevice {
  device_code: string
  fail_rate: number
  [key: string]: unknown
}

/** GET /api/v1/agent/status/dashboard 的实际返回结构 */
export interface StatusDashboard {
  devices: {
    total: number
    active_today: number
  }
  messages: {
    total: number
    hourly: HourlyMessagePoint[]
  }
  queue: {
    pending: number
  }
  errors: {
    failed_today: number
    ai_abnormal: number
  }
  state_distribution: Record<string, number>
  device_ranking: DeviceMessageRankItem[]
  dify_health: DifyHealthItem[]
  daily_trend: DailyTrendPoint[]
  degraded: DegradedDevice[]
  [key: string]: unknown
}

export const adminApi = {
  overview: () => http.get<AdminOverview>('/api/v1/admin/overview'),
}

/** ---------- 设备与状态报表 ---------- */
export const metricsApi = {
  statusDashboard: (params: PageQuery = {}) =>
    http.get<StatusDashboard>('/api/v1/agent/status/dashboard', { params }),
  reportMetrics: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>('/api/v1/agent/report/metrics', { params }),
  /** 后端未提供，调用方需捕获 404 并降级 */
  accountSummary: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>('/api/v1/agent/report/account-summary', { params }),
}

/** ---------- 激活 / 复聊 ---------- */
export interface ActivationScript {
  id: number | string
  content: string
  category?: string | null
  is_active: boolean
  used_count: number
  last_used_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  [key: string]: unknown
}

export const activationApi = {
  scripts: (params: PageQuery = { page: 1, page_size: 1000 }) =>
    http.get<PageResult<ActivationScript>>('/api/v1/activation/scripts', { params }),
  exportScripts: () =>
    http.get<Blob>('/api/v1/activation/scripts/export', { responseType: 'blob' }),
  importScripts: (form: FormData) =>
    http.post<Record<string, unknown>>('/api/v1/activation/scripts/import', form),
  updateCustomerSummary: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/activation/customers/${id}/summary`, payload),
  regenerateSummary: (id: number | string, payload: Record<string, unknown> = {}) =>
    http.post<Record<string, unknown>>(
      `/api/v1/activation/customers/${id}/regenerate-summary`,
      payload,
    ),
}

/**
 * 后端明确未提供的接口路径。
 * 页面直接按这里降级，避免向 404 端点发请求污染控制台；
 * 若后端未来补上，只需删掉对应常量即可恢复真实调用。
 */
export const MISSING_APIS = {
  activationDashboardStats: '/api/v1/activation/dashboard/stats',
  activationDashboardTrend: '/api/v1/activation/dashboard/trend',
  activationDashboardPopulation: '/api/v1/activation/dashboard/population',
  activationDashboardStrategyEffect: '/api/v1/activation/dashboard/strategy-effect',
  activationDashboardFeed: '/api/v1/activation/dashboard/feed',
  activationCustomers: '/api/v1/activation/customers',
  activationStrategies: '/api/v1/activation/strategies',
  activationDevices: '/api/v1/activation/devices',
  accountSummary: '/api/v1/agent/report/account-summary',
} as const

/** 判断错误是否为后端未提供（404/405/501），供真实调用兜底降级 */
export function isApiMissing(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status
  return status === 404 || status === 405 || status === 501
}

/** 后端尚未实现的激活接口：保留原封装，方便后续切换为真实调用 */
export const activationMissingApi = {
  dashboardStats: () => http.get<Record<string, unknown>>(MISSING_APIS.activationDashboardStats),
  dashboardTrend: () => http.get<Record<string, unknown>>(MISSING_APIS.activationDashboardTrend),
  dashboardPopulation: () =>
    http.get<Record<string, unknown>>(MISSING_APIS.activationDashboardPopulation),
  dashboardStrategyEffect: () =>
    http.get<Record<string, unknown>>(MISSING_APIS.activationDashboardStrategyEffect),
  dashboardFeed: () => http.get<Record<string, unknown>>(MISSING_APIS.activationDashboardFeed),
  customers: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>(MISSING_APIS.activationCustomers, { params }),
  strategies: () => http.get<Record<string, unknown>>(MISSING_APIS.activationStrategies),
  devices: () => http.get<Record<string, unknown>>(MISSING_APIS.activationDevices),
}

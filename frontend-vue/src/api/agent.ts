import http from './http'
import type { AgentDevice, Factory, OkResult, PageQuery, PageResult, ServicePosition } from './types'
import type { ConfigSyncEvidence } from '../components/agent/config-sync-view'

/** ---------- 坐席设备 ---------- */
export interface AgentDeviceFactory {
  id: number
  name: string
  city_name?: string
  [key: string]: unknown
}

export interface AgentDeviceItem extends AgentDevice {
  reply_provider?: 'agent' | 'dify'
  factory_ids?: number[]
  factories?: AgentDeviceFactory[]
  position_id?: number | null
  group_chat?: string
  queue_depth?: number
  queue_stale?: string
  last_online?: string
  last_offline?: string
  created_at?: string
  device_name?: string
}

export interface DeviceGroup {
  id?: number | string
  name?: string
  chat_id?: string
  member_count?: number
  [key: string]: unknown
}

export interface LoginQrResult {
  available: boolean
  image?: string
  width?: number
  height?: number
  captured_at?: string
}

export interface VerifyCodeResult {
  available?: boolean
  code?: string
  at?: string
  ok?: boolean
}

export interface WorkflowResult {
  items: Array<Record<string, unknown>>
  total: number
  [key: string]: unknown
}

export const devicesApi = {
  list: (params: PageQuery = {}) => http.get<{ items: AgentDeviceItem[] }>('/api/v1/agent/devices', { params }),
  create: (payload: Record<string, unknown>) => http.post<AgentDeviceItem>('/api/v1/agent/devices', payload),
  update: (id: number | string, payload: Record<string, unknown>) =>
    http.put<AgentDeviceItem>(`/api/v1/agent/devices/${id}`, payload),
  remove: (id: number | string) => http.delete<OkResult>(`/api/v1/agent/devices/${id}`),
  groups: (code: string) =>
    http.get<{ items: DeviceGroup[] }>(`/api/v1/agent/devices/${encodeURIComponent(code)}/groups`),
  loginQr: (code: string) =>
    http.get<LoginQrResult>(`/api/v1/agent/devices/${encodeURIComponent(code)}/login-qr`),
  verifyCodeGet: (code: string) =>
    http.get<VerifyCodeResult>(`/api/v1/agent/devices/${encodeURIComponent(code)}/verify-code`),
  verifyCodePost: (code: string, payload: Record<string, unknown>) =>
    http.post<VerifyCodeResult>(
      `/api/v1/agent/devices/${encodeURIComponent(code)}/verify-code`,
      payload,
    ),
  clearUnread: (id: number | string) =>
    http.post<OkResult>(`/api/v1/agent/device/${id}/clear-unread`),
  workflowGet: (id: number | string) =>
    http.get<WorkflowResult>(`/api/v1/agent/device/${id}/workflow`),
  workflowPut: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/agent/device/${id}/workflow`, payload),
  workflowDelete: (id: number | string) =>
    http.delete<OkResult>(`/api/v1/agent/device/${id}/workflow`),
  /** 设备表单的工厂多选选项（基础配置域接口，仅在坐席域内聚合使用） */
  factoryOptions: () =>
    http.get<PageResult<Factory>>('/api/v1/factories', { params: { page: 1, page_size: 1000 } }),
  positionOptions: () =>
    http.get<PageResult<ServicePosition>>('/api/v1/service-positions', { params: { page: 1, page_size: 1000 } }),
}

/** ---------- 会话与消息 ---------- */
export interface AgentConversation {
  id: number
  device_code: string
  customer_id: number
  nickname: string
  state: string
  recruit_status: string
  takeover: number | boolean
  unread: number
  city: string
  district: string
  last_msg: string
  last_msg_at: string
  created_at?: string
  updated_at?: string
  name?: string
  phone?: string
  remark?: string
  factory_name?: string
  interview_date?: string
  interview_time?: string
  is_old_friend?: boolean
  external_conversation_id?: string
  [key: string]: unknown
}

export interface AgentMessage {
  id: number
  device_code: string
  customer_id: number
  direction: 'inbound' | 'outbound' | string
  content: string
  status: string
  created_at: string
  role: 'customer' | 'agent' | string
  content_type?: string
  dedup_original?: string
  [key: string]: unknown
}

export interface ConversationListResult {
  items: AgentConversation[]
  total_unread?: number
}

export interface MessageListResult {
  items: AgentMessage[]
  takeover?: boolean
}

export const conversationsApi = {
  list: (params: PageQuery = {}) =>
    http.get<ConversationListResult>('/api/v1/agent/conversations', { params }),
  messages: (params: PageQuery = {}) =>
    http.get<MessageListResult>('/api/v1/agent/messages', { params }),
  /** 优先走会话发送口，失败回退人工回复口（两条路径后端都存在） */
  sendMessage: async (deviceCode: string, customerId: number | string, content: string) => {
    try {
      const { data } = await http.post<Record<string, unknown>>(
        `/api/v1/agent/conversations/${customerId}/send`,
        { device_code: deviceCode, content },
      )
      return data
    } catch (error) {
      const { data } = await http.post<Record<string, unknown>>('/api/v1/agent/manual-reply', {
        device_code: deviceCode,
        customer_id: Number(customerId),
        content,
      })
      return data
    }
  },
  takeover: (deviceCode: string, customerId: number | string, takeover: boolean) =>
    http.post<Record<string, unknown>>('/api/v1/agent/takeover', {
      device_code: deviceCode,
      customer_id: Number(customerId),
      takeover,
    }),
  restart: (customerId: number | string, deviceCode: string) =>
    http.put<Record<string, unknown>>(`/api/v1/agent/conversations/${customerId}/restart`, null, {
      params: { device_code: deviceCode },
    }),
  resetDisqualified: (customerId: number | string, deviceCode: string) =>
    http.put<Record<string, unknown>>(
      `/api/v1/agent/conversations/${customerId}/reset-disqualified`,
      null,
      { params: { device_code: deviceCode } },
    ),
  manualReply: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/agent/manual-reply', payload),
}

/** ---------- 面试登记 / 归档 ---------- */
export interface ArchiveRecord {
  session_key: string
  customer_nickname: string
  device_code: string
  group_chat: string
  name: string
  phone: string
  city: string
  interview_date: string
  interview_time: string
  interview_confirmed: boolean
  arrival_status: string
  notify_status: string
  updated_at: string
  [key: string]: unknown
}

export const archiveApi = {
  list: (params: PageQuery = {}) =>
    http.get<{ items: ArchiveRecord[] }>('/api/v1/agent/archive/list', { params }),
  detail: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>('/api/v1/agent/archive', { params }),
  manual: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/agent/archive/manual', payload),
  setArrival: (key: string, arrival: string) =>
    http.put<Record<string, unknown>>(
      `/api/v1/agent/archive/${encodeURIComponent(key)}/arrival`,
      { arrival_status: arrival },
    ),
  markCandidate: (id: number | string, payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>(`/api/v1/agent/candidates/${id}/mark`, payload),
}

/** ---------- 明确 404 的旧接口：仅保留封装，页面做降级提示，不发起请求 ---------- */
export const candidatesApi = {
  list: (params: PageQuery = {}) =>
    http.get<PageResult<Record<string, unknown>>>('/api/v1/agent/candidates', { params }),
}

export const oldFriendsApi = {
  list: (params: PageQuery = {}) =>
    http.get<PageResult<Record<string, unknown>>>('/api/v1/agent/old-friends', { params }),
}

/** ---------- 开场白 / 人设 / 聊天 ---------- */
export interface AgentFlowPart {
  kind: 'text' | 'image' | 'video' | string
  body?: string
  media_name?: string
  delay_ms?: number
}

export interface AgentFlowNode {
  node_key: string
  node_type: 'text' | 'image' | 'video' | 'followup' | 'branch' | 'end' | string
  title?: string
  body?: string
  parts?: AgentFlowPart[]
  await_reply?: boolean
  wait_minutes?: number
  max_times?: number
  status?: string
  [key: string]: unknown
}

export interface AgentFlowEdge {
  from_key: string
  to_key: string
  trigger: string
  condition_value?: string
  priority?: number
  [key: string]: unknown
}

export interface AgentFlow {
  position_id: number
  version: number
  status: 'disabled' | 'enabled' | string
  entry_key: string
  canvas?: Record<string, unknown>
  nodes: AgentFlowNode[]
  edges: AgentFlowEdge[]
  [key: string]: unknown
}

export interface FlowStateSummary {
  position_id: number
  flow_version: number
  node_key: string
  phase: string
  count: number
  updated_at: string
}

export const agentApi = {
  persona: () => http.get<Record<string, unknown>>('/api/v1/agent-persona'),
  personaGet: (positionId: number | string) =>
    http.get<{ persona?: { content?: string; status?: string }; openings?: Record<string, unknown>[]; opening_version?: string }>(
      '/api/v1/agent-persona',
      { params: { position_id: positionId } },
    ),
  personaSave: (payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>('/api/v1/agent-persona', payload),
  openings: () =>
    http.get<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>(
      '/api/v1/agent/opening',
    ),
  createOpening: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/agent-opening', payload),
  updateOpening: (id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`/api/v1/agent-opening/${id}`, payload),
  removeOpening: (id: number | string) =>
    http.delete<OkResult>(`/api/v1/agent-opening/${id}`),
  reorderOpenings: (payload: Record<string, unknown>) =>
    http.post<OkResult>('/api/v1/agent-opening/reorder', payload),
  flowGet: (positionId: number | string) =>
    http.get<AgentFlow>(`/api/v1/agent-flow`, { params: { position_id: positionId } }),
  flowMigrate: (positionId: number | string) =>
    http.post<AgentFlow>('/api/v1/agent-flow/migrate', { position_id: positionId }),
  flowSave: (payload: AgentFlow) =>
    http.put<AgentFlow>('/api/v1/agent-flow', payload),
  configSync: (deviceCode: string) =>
    http.get<ConfigSyncEvidence>('/api/v1/agent/config-sync', { params: { device_code: deviceCode } }),
  flowStateSummary: (deviceCode: string) =>
    http.get<{ device_code: string; items: FlowStateSummary[] }>('/api/v1/agent/state', {
      params: { device_code: deviceCode, summary: 1 },
    }),
  logOpening: (payload: Record<string, unknown>) =>
    http.post<OkResult>('/api/v1/agent/opening/log', payload),
  chat: (payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>('/api/v1/agent/chat', payload),
  context: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>('/api/v1/agent/context', { params }),
  reminderTasks: (params: PageQuery = {}) =>
    http.get<PageResult<Record<string, unknown>>>('/api/v1/agent/reminder-tasks', { params }),
  metrics: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>('/api/v1/agent/report/metrics', { params }),
  agentCities: () => http.get<Record<string, unknown>>('/api/v1/agent/cities'),
  followupRun: (payload: Record<string, unknown> = {}) =>
    http.post<Record<string, unknown>>('/api/v1/agent/followup/run', payload),
  statusDashboard: (params: PageQuery = {}) =>
    http.get<Record<string, unknown>>('/api/v1/agent/status/dashboard', { params }),
}

/** SSE 地址：EventSource 不能带 Authorization，用 query token */
export function streamUrl(token: string): string {
  return `/api/v1/agent/stream?token=${encodeURIComponent(token)}`
}

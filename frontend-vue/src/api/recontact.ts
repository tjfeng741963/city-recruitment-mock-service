import http from './http'

export type RecontactKind = 'text' | 'image' | 'video' | 'location'
export type RecontactStage = 'work_location' | 'interview_invite'
export type RecontactTime = number | string | null
export type RecontactResolution = 'sent' | 'not_sent' | 'cancel'

export interface RecontactPart {
  kind: RecontactKind
  value: string
  delay_ms: number
}

export interface RecontactRule {
  position_id: number
  stage: RecontactStage
  enabled: boolean
  wait_minutes: number
  start_minute: number
  end_minute: number
  parts: RecontactPart[]
}

export interface RecontactTemplate {
  id: number
  position_id: number
  name: string
  parts: RecontactPart[]
}

export interface RecontactOptions {
  positions: { id: number; name: string }[]
  devices: { code: string; name: string; position_ids?: number[] }[]
  assets: { name: string; kind: 'image' | 'video'; position_id: number }[]
  locations: { position_id: number; key: string; name: string; address: string; mappable: boolean }[]
}

export interface RecontactCandidate {
  id: number
  customer_id: number
  position_id: number
  device_code: string
  nickname: string
  last_contact_at: RecontactTime
  reason: string
}

export interface RecontactPreview {
  token: string
  items: (Pick<RecontactCandidate, 'id' | 'position_id' | 'device_code' | 'nickname' | 'reason'> & {
    parts: RecontactPart[]
  })[]
}

export interface RecontactJob {
  id: number
  device_code: string
  customer_id: number
  conversation_id: number
  nickname: string
  position_id: number
  source: string
  status: string
  due_at: RecontactTime
  reason: string
  steps: {
    kind: RecontactKind
    content: string
    status: string
    reason: string
    due_at: RecontactTime
    confirmed_at: RecontactTime
  }[]
}

type RecontactFilters = { position_id?: number; device_code?: string }

const base = '/api/v1/recontact'

export const recontactApi = {
  options: () => http.get<RecontactOptions>(`${base}/options`),
  rules: (position_id: number) =>
    http.get<{ items: RecontactRule[] }>(`${base}/rules`, { params: { position_id } }),
  saveRule: ({ position_id, stage, ...rule }: RecontactRule) =>
    http.put<{ item: RecontactRule }>(`${base}/rules/${position_id}/${stage}`, rule),
  templates: (position_id?: number) =>
    http.get<{ items: RecontactTemplate[] }>(`${base}/templates`, { params: { position_id } }),
  saveTemplate: ({ id, ...template }: RecontactTemplate) =>
    id
      ? http.put<{ item: RecontactTemplate }>(`${base}/templates/${id}`, template)
      : http.post<{ item: RecontactTemplate }>(`${base}/templates`, template),
  candidates: (params: RecontactFilters & { days: number }) =>
    http.get<{ items: RecontactCandidate[] }>(`${base}/candidates`, { params }),
  preview: (conversation_ids: number[], template_ids: Record<number, number>, days: number) =>
    http.post<RecontactPreview>(`${base}/batches/preview`, { conversation_ids, template_ids, days }),
  send: (token: string) =>
    http.post<{ created: number; skipped: { id: number; reason: string }[] }>(`${base}/batches`, { token }),
  jobs: (params: RecontactFilters & { status?: string; q?: string }) =>
    http.get<{ items: RecontactJob[] }>(`${base}/jobs`, { params }),
  review: (id: number, resolution: RecontactResolution) =>
    http.post(`${base}/jobs/${id}/review`, { resolution }),
}

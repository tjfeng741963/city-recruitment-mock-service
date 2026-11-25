import http from './http'
import type { OkResult, PageQuery, PageResult } from './types'

/**
 * 知识管理域接口封装。
 *
 * 背景：本地 8080 的 /api/v1/knowledge 由“旧页面契约兼容层”负责，
 * 数据实际落在 kb_faq；该兼容层在部分环境未挂载时会退化为泛型占位接口
 * （GET 永远空、POST 返回 success 但不落库）。因此这里做一次运行时探测：
 *   - /knowledge 有数据 → 走旧契约；
 *   - /knowledge 为空而 /kb-faqs 有数据 → 直接读写 kb_faq，保证页面可用。
 * 视图只依赖本文件，不直接碰 axios。
 */

export type KnowledgeSource = 'knowledge' | 'kb_faq'

export interface Vertical {
  id: number
  code: string
  name: string
  status: string
  sort_order: number
  config?: Record<string, unknown>
  [key: string]: unknown
}

export interface LocationNode {
  id: number
  parent_id: number | null
  level: string
  name: string
  code?: string
  status: string
  [key: string]: unknown
}

export interface Employer {
  id: number
  vertical_id: number
  display_name: string
  short_name?: string
  location_id?: number | null
  status: string
  aliases?: string[]
  [key: string]: unknown
}

export interface KnowledgeItem {
  id: number
  question: string
  answer: string
  keywords: string[]
  media?: string[]
  status: string
  is_active: boolean
  sort_order: number
  vertical_id: number | null
  scope_level: string
  scope_location_id: number | null
  scope_position_id?: number | null
  scope_employer_id: number | null
  template_item_id: number | null
  updated_at: string
  created_at: string
  source: KnowledgeSource
  [key: string]: unknown
}

export interface KnowledgeDraft {
  question: string
  answer: string
  keywords: string[]
  media?: string[]
  vertical_id: number | null
  scope_level: string
  scope_location_id: number | null
  scope_position_id?: number | null
  scope_employer_id: number | null
  status: string
  sort_order: number
}

export interface KnowledgeListResult {
  items: KnowledgeItem[]
  total: number
  source: KnowledgeSource
}

export interface KbFaqAuditIssue {
  code: string
  detail: string
}

export interface KbFaqAuditItem extends KnowledgeItem {
  governance: KbFaqAuditIssue[]
}

export interface KbFaqAuditResult {
  source: string
  total: number
  needs_review: number
  items: KbFaqAuditItem[]
}

export interface KbTemplate {
  id: number
  code: string
  name: string
  vertical_code: string
  industry?: string
  version?: number
  status?: string
  item_count: number
  [key: string]: unknown
}

export interface KbPublishPreview {
  preview_id: string
  target_id?: string
  target_revision?: string
  target_generation?: number
  changes?: Array<Record<string, unknown>>
  issues?: Array<Record<string, unknown>>
  note?: string
  [key: string]: unknown
}

export interface UnknownQuestionItem {
  id: number
  question: string
  count: number
  occurrence_count: number
  city_name: string
  status: string
  last_seen_at: string
  merged_questions: string[]
  [key: string]: unknown
}

/* ------------------------------------------------------------------ */
/* 通用解析                                                            */
/* ------------------------------------------------------------------ */

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asNullableId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map((item) => asString(item).trim()).filter(Boolean)
  } catch {
    // 兼容 "a,b,c" 形式
  }
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function itemsOf<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  const obj = payload as { items?: unknown; data?: unknown } | null | undefined
  if (Array.isArray(obj?.items)) return obj.items as T[]
  if (Array.isArray(obj?.data)) return obj.data as T[]
  return []
}

function totalOf(payload: unknown, fallback: number): number {
  const obj = payload as { total?: unknown } | null | undefined
  return obj?.total === undefined ? fallback : asNumber(obj.total, fallback)
}

function errorDetail(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: unknown }
    if (typeof first?.msg === 'string') return first.msg
  }
  return fallback
}

export function knowledgeErrorMessage(error: unknown, fallback = '操作失败'): string {
  return errorDetail(error, fallback)
}

/* ------------------------------------------------------------------ */
/* 映射                                                                */
/* ------------------------------------------------------------------ */

function mapKnowledgeRow(row: Record<string, unknown>): KnowledgeItem {
  const active = row.is_active === undefined
    ? asString(row.status, 'enabled') !== 'disabled'
    : Boolean(row.is_active)
  return {
    id: asNumber(row.id),
    question: asString(row.question),
    answer: asString(row.answer),
    keywords: asStringList(row.keywords),
    status: active ? 'enabled' : 'disabled',
    is_active: active,
    sort_order: asNumber(row.sort_order ?? row.priority),
    vertical_id: asNullableId(row.vertical_id),
    scope_level: asString(row.scope_level, 'global'),
    scope_location_id: asNullableId(row.scope_location_id ?? row.location_id),
    scope_employer_id: asNullableId(row.scope_employer_id ?? row.employer_id),
    template_item_id: asNullableId(row.template_item_id),
    updated_at: asString(row.updated_at),
    created_at: asString(row.created_at),
    source: 'knowledge',
    recruiter_id: asString(row.recruiter_id),
  }
}

function mapFaqRow(row: Record<string, unknown>): KnowledgeItem {
  return {
    id: asNumber(row.id),
    question: asString(row.question),
    answer: asString(row.answer),
    keywords: asStringList(row.keywords),
    media: asStringList(row.media),
    status: asString(row.status, 'enabled'),
    is_active: asString(row.status, 'enabled') === 'enabled',
    sort_order: asNumber(row.priority ?? row.sort_order),
    vertical_id: asNullableId(row.vertical_id),
    scope_level: asString(row.scope_level, 'global'),
    scope_location_id: asNullableId(row.scope_location_id),
    scope_position_id: asNullableId(row.scope_position_id),
    scope_employer_id: asNullableId(row.scope_employer_id),
    template_item_id: asNullableId(row.template_item_id),
    updated_at: asString(row.updated_at),
    created_at: asString(row.created_at),
    source: 'kb_faq',
  }
}

/* ------------------------------------------------------------------ */
/* 数据源探测                                                          */
/* ------------------------------------------------------------------ */

let activeSource: KnowledgeSource = 'knowledge'
let cachedNativeRows: Record<string, unknown>[] = []
let cachedFaqRows: Record<string, unknown>[] = []

export function getKnowledgeSource(): KnowledgeSource {
  return activeSource
}

/** 一次取回全部（后端 page_size=1000），筛选与分页在前端做。 */
export async function listKnowledgeItems(): Promise<KnowledgeListResult> {
  const rows: Record<string, unknown>[] = []
  let page = 1
  let total = 0
  do {
    const { data } = await http.get<PageResult<Record<string, unknown>>>('/api/v1/kb-faqs', { params: { page, page_size: 1000 } })
    const batch = itemsOf<Record<string, unknown>>(data)
    rows.push(...batch)
    total = totalOf(data, rows.length)
    if (!batch.length) break
    page++
  } while (rows.length < total)
  cachedFaqRows = rows
  activeSource = 'kb_faq'
  return { items: rows.map(mapFaqRow), total, source: activeSource }
}

export async function getKnowledgeItem(
  id: number | string,
  source: KnowledgeSource,
): Promise<KnowledgeItem | null> {
  if (source === 'kb_faq') {
    let rows = cachedFaqRows
    if (!rows.length) {
      const { data } = await http.get<PageResult<Record<string, unknown>>>('/api/v1/kb-faqs', {
        params: { page: 1, page_size: 1000 },
      })
      rows = itemsOf<Record<string, unknown>>(data)
      cachedFaqRows = rows
    }
    const row = rows.find((item) => asNumber(item.id) === Number(id))
    return row ? mapFaqRow(row) : null
  }

  try {
    const { data } = await http.get<Record<string, unknown>>(`/api/v1/knowledge/${id}`)
    const mapped = mapKnowledgeRow(data ?? {})
    if (mapped.question) return mapped
  } catch {
    // 兼容层未挂载时该接口会返回列表结构，走下面的兜底。
  }

  const row = cachedFaqRows.find((item) => asNumber(item.id) === Number(id))
  return row ? mapFaqRow(row) : null
}

/* ------------------------------------------------------------------ */
/* 基础数据                                                            */
/* ------------------------------------------------------------------ */

export async function listVerticals(): Promise<Vertical[]> {
  const { data } = await http.get<PageResult<Vertical>>('/api/v1/verticals')
  const rows = itemsOf<Vertical>(data)
  return rows
    .map((row) => ({
      ...row,
      id: asNumber(row.id),
      code: asString(row.code),
      name: asString(row.name),
      status: asString(row.status, 'enabled'),
      sort_order: asNumber(row.sort_order),
    }))
    .filter((row) => row.status !== 'deleted')
}

export async function listLocations(): Promise<LocationNode[]> {
  const { data } = await http.get<PageResult<LocationNode>>('/api/v1/locations', {
    params: { page_size: 1000 },
  })
  return itemsOf<LocationNode>(data)
    .map((row) => ({
      ...row,
      id: asNumber(row.id),
      parent_id: asNullableId(row.parent_id),
      level: asString(row.level),
      name: asString(row.name),
      status: asString(row.status, 'enabled'),
    }))
    .filter((row) => row.status !== 'deleted')
}

export async function listEmployers(): Promise<Employer[]> {
  const { data } = await http.get<PageResult<Employer>>('/api/v1/employers', {
    params: { page_size: 1000 },
  })
  return itemsOf<Employer>(data)
    .map((row) => ({
      ...row,
      id: asNumber(row.id),
      vertical_id: asNumber(row.vertical_id),
      display_name: asString(row.display_name),
      status: asString(row.status, 'enabled'),
    }))
    .filter((row) => row.status !== 'deleted')
}

/* ------------------------------------------------------------------ */
/* 知识库写操作                                                        */
/* ------------------------------------------------------------------ */

function toFaqPayload(draft: KnowledgeDraft): Record<string, unknown> {
  return {
    question: draft.question.trim(),
    answer: draft.answer.trim(),
    keywords: draft.keywords,
    ...(draft.media && { media: draft.media }),
    vertical_id: draft.vertical_id,
    scope_level: draft.scope_level,
    scope_location_id: draft.scope_level === 'city' ? draft.scope_location_id : null,
    scope_employer_id: draft.scope_level === 'employer' ? draft.scope_employer_id : null,
    scope_position_id: draft.scope_level === 'position' ? draft.scope_position_id : null,
    priority: draft.sort_order,
    status: draft.status === 'disabled' ? 'disabled' : 'enabled',
  }
}

function toNativePayload(draft: KnowledgeDraft): Record<string, unknown> {
  return {
    question: draft.question.trim(),
    answer: draft.answer.trim(),
    keywords: draft.keywords,
    sort_order: draft.sort_order,
    is_active: draft.status !== 'disabled',
  }
}

export async function createKnowledgeItem(draft: KnowledgeDraft): Promise<KnowledgeItem> {
  const { data } = await http.post<Record<string, unknown>>('/api/v1/kb-faqs', toFaqPayload(draft))
  activeSource = 'kb_faq'
  return mapFaqRow(data ?? {})
}

export async function updateKnowledgeItem(
  id: number | string,
  draft: KnowledgeDraft,
  source: KnowledgeSource = activeSource,
): Promise<KnowledgeItem> {
  if (source === 'kb_faq') {
    const { data } = await http.put<Record<string, unknown>>(`/api/v1/kb-faqs/${id}`, toFaqPayload(draft))
    return mapFaqRow(data ?? {})
  }

  const { data } = await http.put<Record<string, unknown>>(`/api/v1/knowledge/${id}`, toNativePayload(draft))
  if (data && data.id !== undefined) return mapKnowledgeRow(data)

  activeSource = 'kb_faq'
  const { data: faqData } = await http.put<Record<string, unknown>>(`/api/v1/kb-faqs/${id}`, toFaqPayload(draft))
  return mapFaqRow(faqData ?? {})
}

export async function removeKnowledgeItem(
  id: number | string,
  source: KnowledgeSource = activeSource,
): Promise<void> {
  if (source === 'kb_faq') {
    await http.delete<OkResult>(`/api/v1/kb-faqs/${id}`)
    return
  }
  await http.delete<OkResult>(`/api/v1/knowledge/${id}`)
}

export async function batchSetKnowledgeStatus(
  ids: number[],
  enabled: boolean,
  source: KnowledgeSource = activeSource,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!ids.length) return
  if (source === 'knowledge') {
    await http.post<OkResult>('/api/v1/knowledge/batch/update', {
      ids,
      status: enabled ? 'enabled' : 'disabled',
      is_active: enabled,
    })
    onProgress?.(ids.length, ids.length)
    return
  }
  let done = 0
  for (const id of ids) {
    await http.put<Record<string, unknown>>(`/api/v1/kb-faqs/${id}`, {
      status: enabled ? 'enabled' : 'disabled',
    })
    done += 1
    onProgress?.(done, ids.length)
  }
}

export async function batchRemoveKnowledgeItems(
  ids: number[],
  source: KnowledgeSource = activeSource,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!ids.length) return
  if (source === 'knowledge') {
    await http.post<OkResult>('/api/v1/knowledge/batch/delete', { ids })
    onProgress?.(ids.length, ids.length)
    return
  }
  let done = 0
  for (const id of ids) {
    await http.delete<OkResult>(`/api/v1/kb-faqs/${id}`)
    done += 1
    onProgress?.(done, ids.length)
  }
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

function csvCell(value: unknown): string {
  const text = asString(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(items: KnowledgeItem[], categoryName: (id: number | null) => string): string {
  const header = ['问题', '答案', '关键词', '分类', '状态', '排序', 'scope_level', 'scope_position_id']
  const lines = items.map((item) =>
    [
      item.question,
      item.answer,
      item.keywords.join(','),
      categoryName(item.vertical_id),
      item.status === 'enabled' ? '启用' : '停用',
      item.sort_order,
      item.scope_level,
      item.scope_position_id || '',
    ]
      .map(csvCell)
      .join(','),
  )
  return [header.join(','), ...lines].join('\r\n')
}

/** 优先用后端导出；后端返回占位内容时在前端生成 CSV。 */
export async function exportKnowledge(
  items: KnowledgeItem[],
  categoryName: (id: number | null) => string,
): Promise<{ blob: Blob; filename: string; degraded: boolean }> {
  const filename = `knowledge-${new Date().toISOString().slice(0, 10)}.csv`
  const csv = `\uFEFF${toCsv(items, categoryName)}`
  return {
    blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    filename,
    degraded: true,
  }
}

/** 简单 CSV 解析：支持引号包裹、双引号转义和单元格内换行。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((line) => line.some((value) => value.trim()))
}

export interface ImportKnowledgeResult {
  created: number
  failed: number
  errors: string[]
  degraded: boolean
}

function parseImportFile(text: string, verticalId: number | null): KnowledgeDraft[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed)
    const rows = Array.isArray(parsed)
      ? parsed
      : itemsOf<Record<string, unknown>>((parsed as { items?: unknown }).items ?? [])
    return rows.map((row) => {
      const record = row as Record<string, unknown>
      return {
        question: asString(record.question ?? record['问题']),
        answer: asString(record.answer ?? record['答案']),
        keywords: asStringList(record.keywords ?? record['关键词']),
        vertical_id: asNullableId(record.vertical_id) ?? verticalId,
        scope_level: (asNullableId(record.vertical_id) ?? verticalId) ? 'vertical' : 'global',
        scope_location_id: null,
        scope_employer_id: null,
        status: asString(record.status) === 'disabled' ? 'disabled' : 'enabled',
        sort_order: asNumber(record.sort_order ?? record.priority),
      }
    }).filter((draft) => draft.question && draft.answer)
  }

  const lines = parseCsv(trimmed)
  if (!lines.length) return []
  const header = lines[0].map((cell) => cell.trim())
  const questionIndex = Math.max(header.indexOf('问题'), header.indexOf('question'))
  const answerIndex = Math.max(header.indexOf('答案'), header.indexOf('answer'))
  const keywordIndex = Math.max(header.indexOf('关键词'), header.indexOf('keywords'))
  const statusIndex = Math.max(header.indexOf('状态'), header.indexOf('status'))
  const sortIndex = Math.max(header.indexOf('排序'), header.indexOf('sort_order'))
  const qIndex = questionIndex >= 0 ? questionIndex : 0
  const aIndex = answerIndex >= 0 ? answerIndex : 1

  return lines.slice(1).map((line) => ({
    question: asString(line[qIndex]).trim(),
    answer: asString(line[aIndex]).trim(),
    keywords: keywordIndex >= 0 ? asStringList(line[keywordIndex]) : [],
    vertical_id: verticalId,
    scope_level: verticalId ? 'vertical' : 'global',
    scope_location_id: null,
    scope_employer_id: null,
    status: statusIndex >= 0 && /停用|disabled/i.test(asString(line[statusIndex])) ? 'disabled' : 'enabled',
    sort_order: sortIndex >= 0 ? asNumber(line[sortIndex]) : 0,
  })).filter((draft) => draft.question && draft.answer)
}

/**
 * 导入：先尝试后端批量接口；若接口是泛型占位（不回导入统计），
 * 则解析文件后逐条调用知识库写接口，保证导入结果可见。
 */
export async function importKnowledgeFile(
  file: File,
  verticalId: number | null,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportKnowledgeResult> {
  const form = new FormData()
  form.append('file', file)
  try {
    const { data } = await http.post<Record<string, unknown>>('/api/v1/knowledge/batch/import', form)
    const imported = asNumber(data?.imported ?? data?.created ?? data?.success_count, -1)
    if (imported >= 0 && data?.errors === undefined) {
      onProgress?.(imported, imported)
      return { created: imported, failed: 0, errors: [], degraded: false }
    }
  } catch {
    // 后端不可用，走前端逐条导入
  }

  const text = await file.text()
  let drafts: KnowledgeDraft[] = []
  try {
    drafts = parseImportFile(text, verticalId)
  } catch {
    return { created: 0, failed: 0, errors: ['文件格式无法解析，请使用 CSV 或 JSON'], degraded: true }
  }
  if (!drafts.length) {
    return { created: 0, failed: 0, errors: ['没有可导入的行（需要“问题”和“答案”两列）'], degraded: true }
  }

  let created = 0
  const errors: string[] = []
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]
    try {
      await createKnowledgeItem(draft)
      created += 1
    } catch (error) {
      errors.push(`第 ${index + 1} 行：${knowledgeErrorMessage(error, '导入失败')}`)
    }
    onProgress?.(index + 1, drafts.length)
  }
  return { created, failed: errors.length, errors, degraded: true }
}

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

export async function listKbTemplates(): Promise<KbTemplate[]> {
  const { data } = await http.get<{ items?: KbTemplate[] }>('/api/v1/kb-templates')
  return itemsOf<KbTemplate>(data).map((row) => ({
    ...row,
    id: asNumber(row.id),
    code: asString(row.code),
    name: asString(row.name),
    vertical_code: asString(row.vertical_code),
    item_count: asNumber(row.item_count),
  }))
}

export async function importKbTemplate(code: string): Promise<Record<string, unknown>> {
  const { data } = await http.post<Record<string, unknown>>(`/api/v1/kb-templates/${code}/import`, {})
  return data ?? {}
}

/* ------------------------------------------------------------------ */
/* 发布                                                                */
/* ------------------------------------------------------------------ */

export async function previewKbPublish(payload: Record<string, unknown> = {}): Promise<KbPublishPreview> {
  const { data } = await http.post<KbPublishPreview>('/api/v1/kb-publish/preview', payload)
  return data
}

export async function applyKbPublish(previewId: string): Promise<Record<string, unknown>> {
  const { data } = await http.post<Record<string, unknown>>('/api/v1/kb-publish/apply', {
    preview_id: previewId,
  })
  return data ?? {}
}

export async function listKbPublishHistory(): Promise<Record<string, unknown>> {
  const { data } = await http.get<Record<string, unknown>>('/api/v1/kb-publish/history')
  return data ?? {}
}

/* ------------------------------------------------------------------ */
/* FAQ 治理                                                            */
/* ------------------------------------------------------------------ */

export async function listKbFaqs(params: PageQuery = { page: 1, page_size: 1000 }): Promise<PageResult<KnowledgeItem>> {
  const { data } = await http.get<PageResult<Record<string, unknown>>>('/api/v1/kb-faqs', { params })
  const rows = itemsOf<Record<string, unknown>>(data).map(mapFaqRow)
  return { items: rows, total: totalOf(data, rows.length), page: 1, page_size: rows.length || 1000 }
}

export async function auditKbFaqs(): Promise<KbFaqAuditResult> {
  const { data } = await http.get<Record<string, unknown>>('/api/v1/kb-faqs/audit')
  const rows = itemsOf<Record<string, unknown>>(data).map((row) => {
    const mapped = mapFaqRow(row) as KbFaqAuditItem
    mapped.governance = Array.isArray(row.governance)
      ? (row.governance as Array<Record<string, unknown>>).map((issue) => ({
        code: asString(issue.code),
        detail: asString(issue.detail),
      }))
      : []
    return mapped
  })
  return {
    source: asString(data?.source, 'node'),
    total: asNumber(data?.total, rows.length),
    needs_review: asNumber(data?.needs_review, rows.filter((row) => row.governance.length).length),
    items: rows,
  }
}

export async function createKbFaq(draft: KnowledgeDraft): Promise<KnowledgeItem> {
  const { data } = await http.post<Record<string, unknown>>('/api/v1/kb-faqs', toFaqPayload(draft))
  return mapFaqRow(data ?? {})
}

export async function updateKbFaq(id: number | string, draft: KnowledgeDraft): Promise<KnowledgeItem> {
  const { data } = await http.put<Record<string, unknown>>(`/api/v1/kb-faqs/${id}`, toFaqPayload(draft))
  return mapFaqRow(data ?? {})
}

/** 只改状态：停用治理未通过的条目时不会被完整编辑校验拦住。 */
export async function setKbFaqStatus(id: number | string, enabled: boolean): Promise<KnowledgeItem> {
  const { data } = await http.put<Record<string, unknown>>(`/api/v1/kb-faqs/${id}`, {
    status: enabled ? 'enabled' : 'disabled',
  })
  return mapFaqRow(data ?? {})
}

export async function removeKbFaq(id: number | string): Promise<void> {
  await http.delete<OkResult>(`/api/v1/kb-faqs/${id}`)
}

/* ------------------------------------------------------------------ */
/* 未知问题                                                            */
/* ------------------------------------------------------------------ */

function mapUnknownQuestion(row: Record<string, unknown>): UnknownQuestionItem {
  const count = asNumber(row.occurrence_count ?? row.count)
  return {
    id: asNumber(row.id),
    question: asString(row.question),
    count,
    occurrence_count: count,
    city_name: asString(row.city_name ?? row.city),
    status: asString(row.status, 'pending'),
    last_seen_at: asString(row.last_seen_at ?? row.updated_at ?? row.created_at),
    merged_questions: asStringList(row.merged_questions),
  }
}

export async function listUnknownQuestions(): Promise<UnknownQuestionItem[]> {
  const { data } = await http.get<PageResult<Record<string, unknown>>>('/api/v1/unknown-questions', {
    params: { page: 1, page_size: 1000 },
  })
  return itemsOf<Record<string, unknown>>(data).map(mapUnknownQuestion)
}

export async function removeUnknownQuestion(id: number | string): Promise<void> {
  await http.delete<OkResult>(`/api/v1/unknown-questions/${id}`)
}

export async function convertUnknownQuestion(
  id: number | string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data } = await http.post<Record<string, unknown>>(`/api/v1/unknown-questions/${id}/convert`, payload)
  return data ?? {}
}

/* ------------------------------------------------------------------ */
/* 兼容旧调用：保留原有 knowledgeApi / kbFaqApi 形状                    */
/* ------------------------------------------------------------------ */

export const knowledgeApi = {
  list: listKnowledgeItems,
  get: getKnowledgeItem,
  create: createKnowledgeItem,
  update: updateKnowledgeItem,
  remove: removeKnowledgeItem,
  batchDelete: (ids: number[]) => batchRemoveKnowledgeItems(ids),
  batchUpdate: (ids: number[], enabled: boolean) => batchSetKnowledgeStatus(ids, enabled),
  batchImport: (file: File) => importKnowledgeFile(file, null),
  batchExport: (items: KnowledgeItem[], categoryName: (id: number | null) => string) =>
    exportKnowledge(items, categoryName),
}

export const kbFaqApi = {
  list: listKbFaqs,
  create: createKbFaq,
  update: updateKbFaq,
  remove: removeKbFaq,
  setStatus: setKbFaqStatus,
  audit: auditKbFaqs,
}

export const kbPublishApi = {
  templates: listKbTemplates,
  importTemplate: importKbTemplate,
  preview: previewKbPublish,
  apply: applyKbPublish,
  history: listKbPublishHistory,
}

export const unknownQuestionApi = {
  list: listUnknownQuestions,
  remove: removeUnknownQuestion,
  convert: convertUnknownQuestion,
}

/* ------------------------------------------------------------------ */
/* 配置台实体 CRUD（对齐 theme/kb-console.js）                          */
/* ------------------------------------------------------------------ */

export type KbResource = 'verticals' | 'locations' | 'employers'

function resourcePath(resource: KbResource): string {
  return `/api/v1/${resource}`
}

export const kbResourceApi = {
  create: (resource: KbResource, payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>(resourcePath(resource), payload),
  update: (resource: KbResource, id: number | string, payload: Record<string, unknown>) =>
    http.put<Record<string, unknown>>(`${resourcePath(resource)}/${id}`, payload),
  remove: (resource: KbResource, id: number | string) =>
    http.delete<OkResult>(`${resourcePath(resource)}/${id}`),
  /** 状态启停走 PUT 部分更新（kb-console 的 statusChip 切换） */
  setStatus: (resource: KbResource, id: number | string, status: 'enabled' | 'disabled') =>
    http.put<Record<string, unknown>>(`${resourcePath(resource)}/${id}`, { status }),
}

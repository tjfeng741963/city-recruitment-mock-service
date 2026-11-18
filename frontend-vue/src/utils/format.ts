/** 通用格式化工具 */

export function formatDateTime(value: unknown): string {
  if (!value) return '-'
  const raw = String(value)
  // 已是 "YYYY-MM-DD HH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) return raw.slice(0, 19)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatShortTime(value: unknown): string {
  if (!value) return '-'
  const raw = String(value)
  const m = raw.match(/(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]} ${m[3]}:${m[4]}`
  return formatDateTime(value).slice(5, 16)
}

export function maskPhone(value: unknown): string {
  const raw = String(value ?? '')
  return raw.replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/g, (s) => `${s.slice(0, 3)}****${s.slice(7)}`)
}

export function toArray<T = Record<string, unknown>>(payload: unknown): T[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload as T[]
  const obj = payload as { items?: unknown }
  return Array.isArray(obj.items) ? (obj.items as T[]) : []
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function formatBytes(bytes: unknown): string {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '-'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

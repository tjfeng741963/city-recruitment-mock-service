import type { RecontactDevice, RecontactPart, RecontactTime } from '../../api/recontact'

type Query = Record<string, unknown>

const stringQuery = (value: unknown) => typeof value === 'string' ? value : undefined

export function accountRecontactAction(device?: Pick<RecontactDevice, 'recontact_enabled' | 'recontact_account_ready'>) {
  if (!device) return undefined
  const enabled = !device.recontact_enabled
  return {
    enabled,
    disabled: enabled && !device.recontact_account_ready,
    label: enabled ? '启用此账号复聊' : '暂停此账号复聊',
  }
}

export function conversationRoute(
  row: { device_code: string; customer_id: number },
  filters: { position_id?: string; device_code?: string; status?: string; q?: string },
) {
  return {
    name: 'conversations',
    query: {
      device_code: row.device_code,
      customer_id: String(row.customer_id),
      from_recontact: '1',
      recontact_position_id: filters.position_id,
      recontact_device_code: filters.device_code,
      recontact_status: filters.status,
      recontact_q: filters.q,
    },
  }
}

export function recontactReturnRoute(query: Query) {
  if (query.from_recontact !== '1') return undefined
  const filters = {
    position_id: stringQuery(query.recontact_position_id),
    device_code: stringQuery(query.recontact_device_code),
    status: stringQuery(query.recontact_status),
    q: stringQuery(query.recontact_q),
  }
  return {
    name: 'recontact',
    query: { tab: 'records', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) },
  }
}

export function reorderParts(parts: RecontactPart[], index: number, direction: -1 | 1): RecontactPart[] {
  const target = index + direction
  if (index < 0 || index >= parts.length || target < 0 || target >= parts.length) return parts
  const next = [...parts]
  const moved = next[index]!
  next[index] = next[target]!
  next[target] = moved
  return next
}

export function selectedTemplateIds(positions: number[], choices: Record<number, number | undefined>) {
  const ids: Record<number, number> = {}
  for (const id of new Set(positions)) {
    const choice = choices[id]
    if (choice) ids[id] = choice
  }
  return ids
}

export function toMinute(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return (hour ?? NaN) * 60 + (minute ?? NaN)
}

export function asClock(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

const chinaTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function recontactTime(value: RecontactTime | undefined): string {
  if (!value) return '—'
  const iso = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : chinaTime.format(date).replaceAll('/', '-')
}

type Device = { device_code?: string; reply_provider?: unknown; position_id?: number | null; online?: unknown; status?: unknown }

export function receptionTestHref(engine: 'agent' | 'dify', context: {positionId?: number | null; deviceCode?: string} = {}) {
  const search = new URLSearchParams({ test_engine: engine })
  if (context.deviceCode) search.set('device_code', context.deviceCode)
  if (context.positionId && Number.isSafeInteger(context.positionId) && context.positionId > 0) {
    search.set('position_id', String(context.positionId))
  }
  return '/recruitment-flow?' + search.toString()
}

export function deviceWorkflowEntry(device: Device): { href: string | null; label: string; reason: string } {
  const unavailable = (reason: string) => ({ href: null, label: '工作流配置', reason })
  if (!device.device_code) return unavailable('缺少客户端标识，请先检查账号配置')
  if (device.reply_provider === 'dify') {
    return {
      href: receptionTestHref('dify', { deviceCode: device.device_code, positionId: device.position_id }),
      label: '工作流配置',
      reason: '',
    }
  }
  if (device.reply_provider !== 'agent') return unavailable('回复来源尚未确认，请刷新后重试')
  const id = Number(device.position_id)
  if (!Number.isSafeInteger(id) || id <= 0) return unavailable('请先在接待设置中选择岗位')
  return { href: `/recruitment-flow?position_id=${id}`, label: '工作流配置', reason: '' }
}

// Existing dedicated web preview asset; a real Dify account is still a reception account.
export function isWebTestDevice(device: Device): boolean {
  return device.device_code === 'dify-sandbox-only'
}

export function deviceOnline(device: Device): boolean {
  return device.online === true || (device.online === undefined && device.status === true)
}

export function workflowPositionSelection(explicit: unknown, remembered: number, ids: number[]): {id: number; error: string} {
  if (explicit !== undefined) {
    const id = typeof explicit === 'string' ? Number(explicit) : 0
    return Number.isSafeInteger(id) && id > 0 && ids.includes(id)
      ? {id, error: ''}
      : {id: 0, error: '指定岗位不存在或无权访问，请返回账号接待设置重新选择'}
  }
  return {id: ids.includes(remembered) ? remembered : ids[0] ?? 0, error: ''}
}

export type FavoriteLocationPreview =
  | { status: 'needs_point'; point_names: string[] }
  | { status: 'not_configured' | 'position_disabled'; point_name?: string }
  | { status: 'windows_unavailable'; point_name: string; favorite_title: string; trigger?: 'navigation_requested'; after_address_delay_ms?: number }

export function describeFavoriteLocation(preview?: FavoriteLocationPreview): string {
  switch (preview?.status) {
    case 'needs_point': return `请先确认求职者要去哪个面试点。可选 ${preview.point_names.join('、')}。`
    case 'not_configured': return `${preview.point_name || '此岗位'}没有配置企微位置卡。`
    case 'position_disabled': return '此岗位已停用。'
    case 'windows_unavailable': {
      const delay = preview.after_address_delay_ms
      const timing = delay === undefined ? '' : `索要定位并确定该点后，地址文字发出 ${delay / 1000} 秒后轮到位置卡。`
      return `已选面试点「${preview.point_name}」，配置的收藏名称为「${preview.favorite_title}」。${timing}Windows 自动发送尚未启用。`
    }
    default: return ''
  }
}

export function locationPointOptions(value: unknown): Array<{ name: string; title: string }> {
  if (!Array.isArray(value)) return []
  const points = value.flatMap(point => {
    const rawName = typeof point === 'string' ? point : point?.name
    const name = typeof rawName === 'string' ? rawName.trim().normalize('NFC') : ''
    const title = typeof point?.favorite_title === 'string' ? point.favorite_title.trim() : ''
    return name ? [{ name, title }] : []
  })
  return points.filter(point => point.title && points.filter(other => other.name === point.name).length === 1)
}

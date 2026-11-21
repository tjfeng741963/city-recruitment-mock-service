export interface FlowMediaOption {
  name: string
  kind: string
  position_id: number
  status: string
}

/** The media list endpoint already excludes inactive assets and omits status. */
export function normalizeFlowMediaOptions(items: Record<string, unknown>[]): FlowMediaOption[] {
  return items.map((item) => ({
    name: String(item.name || ''),
    kind: String(item.kind || ''),
    position_id: Number(item.position_id || 0),
    status: item.status == null ? 'enabled' : String(item.status),
  })).filter((item) => item.name)
}

export function availableFlowMedia(items: FlowMediaOption[], kind: string, positionId: number): FlowMediaOption[] {
  return items.filter((item) =>
    item.kind === kind && item.status === 'enabled' && (item.position_id === 0 || item.position_id === positionId),
  )
}

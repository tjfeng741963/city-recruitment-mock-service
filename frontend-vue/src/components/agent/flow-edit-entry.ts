export type AgentDrawerTab = 'persona' | 'opening' | 'flow'
export type RuntimeEditEntry = 'edit-node' | 'edit-opening' | 'manage-media' | 'edit-persona' | 'manage-knowledge'

/** Only a fresh drawer opening selects its requested tab; data refreshes keep the active editor. */
export function drawerTabForLoad(current: AgentDrawerTab, initial: AgentDrawerTab | undefined, opening: boolean): AgentDrawerTab {
  return opening ? initial ?? 'persona' : current
}

/** Runtime stages link to their real configuration source, never to a synthetic flow-node editor. */
export function runtimeEditEntries(
  node: { node_key: string; node_type: string } | null,
  legacy: boolean,
  editable: boolean,
): RuntimeEditEntry[] {
  if (!node) return []
  if (node.node_type === 'system_media') return ['manage-media']
  if (node.node_type === 'system_ai') return ['edit-persona', 'manage-knowledge']
  if (node.node_type.startsWith('system_')) return []
  if (legacy) return /^legacy_[1-9]\d*$/.test(node.node_key) ? ['edit-opening'] : []
  return editable ? ['edit-node'] : []
}

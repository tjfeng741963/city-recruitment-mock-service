export type AgentDrawerTab = 'persona' | 'opening'

/** Only a fresh drawer opening selects its requested tab; data refreshes keep the active editor. */
export function drawerTabForLoad(current: AgentDrawerTab, initial: AgentDrawerTab | undefined, opening: boolean): AgentDrawerTab {
  return opening ? initial ?? 'persona' : current
}

import type { AgentFlow, AgentFlowEdge, AgentFlowNode } from '../../api/agent'

export interface LegacyOpening {
  id?: number
  seq: number
  kind: string
  content?: string
  media_name?: string
  delay_ms?: number
  status?: string
}

export const START_KEY = '__runtime_start'
export const AI_KEY = '__runtime_ai'

export interface AiMediaBranch {
  name: string
  kind: string
  position_id: number
  condition: string
  source: string
}

/** Only expose media present in the same facts used by the AI prompt. */
export function buildAiMediaBranches(
  assets: Array<{name: string; kind: string; position_id: number; status?: string}>,
  facts: Record<string, string>,
  positionId: number,
): AiMediaBranch[] {
  const catalog = new Set(String(facts.media_catalog || '').split('、').map(name => name.trim()).filter(Boolean))
  return assets.filter(asset => asset.status !== 'disabled' && asset.status !== 'deleted' && ['image', 'video'].includes(asset.kind) &&
    ((asset.position_id === 0 && catalog.has(asset.name)) || (asset.position_id === positionId &&
      [facts.interview_address_image, facts.interview_video].includes(asset.name))))
    .map(asset => ({ ...asset,
      condition: asset.position_id === 0 ? '按需：客户问相关内容，AI选择素材' : '按需：客户询问面试地点或指引',
      source: asset.position_id === 0 ? '通用素材库' : '本岗位专属素材',
    }))
}

export function activeOpenings(items: LegacyOpening[]): LegacyOpening[] {
  return items.filter(item => item.status !== 'disabled').slice().sort((a, b) => a.seq - b.seq)
}

/** A presentation graph only: never submit its system stages to the flow API. */
export function buildRuntimeFlow(saved: AgentFlow, openings: LegacyOpening[], aiMedia: AiMediaBranch[] = []): AgentFlow {
  const usesFlow = saved.status === 'enabled' && saved.nodes.length > 0
  const nodes: AgentFlowNode[] = usesFlow
    ? saved.nodes.map(node => ({ ...node, parts: node.parts?.map(part => ({ ...part })) }))
    : activeOpenings(openings).map((item, index) => ({
      node_key: `legacy_${index + 1}`, node_type: item.kind, title: `旧开场 ${index + 1}`,
      status: 'enabled', await_reply: false,
      parts: [{ kind: item.kind, body: item.content || '', media_name: item.media_name || '', delay_ms: item.delay_ms ?? 2000 }],
    }))
  const edges: AgentFlowEdge[] = usesFlow
    ? saved.edges.filter(edge => {
      const source = saved.nodes.find(node => node.node_key === edge.from_key)
      if (source?.status !== 'disabled') {
        if (edge.trigger === 'giveup') return false
        if (edge.trigger === 'keyword' && source?.node_type !== 'branch' && !source?.await_reply) return false
        return true
      }
      const outgoing = saved.edges.filter(item => item.from_key === edge.from_key)
      const primary = outgoing.find(item => item.trigger === 'default') || outgoing.find(item => item.trigger === 'any_reply')
      return primary === edge
    }).map(edge => {
      const source = saved.nodes.find(node => node.node_key === edge.from_key)
      const isBranchFallback = source?.node_type === 'branch' && edge.trigger === 'keyword' && !edge.to_key
      const branchFallback = isBranchFallback
        ? saved.edges.find(item => item.from_key === edge.from_key && item.trigger === 'default')?.to_key
        : ''
      return { ...edge, to_key: edge.to_key || branchFallback || AI_KEY,
        runtime_label: source?.status === 'disabled' ? '停用节点：不等待，沿主出口跳过'
          : isBranchFallback ? `关键词「${edge.condition_value}」空目标：回退默认连接`
          : edge.to_key ? '' : edge.trigger === 'any_reply' || edge.trigger === 'keyword' ? '客户本条回复 → AI 答疑' : '后续新消息 → AI 答疑' }
    })
    : nodes.map((node, index) => ({
      from_key: node.node_key, to_key: nodes[index + 1]?.node_key || AI_KEY, trigger: 'default',
      runtime_label: nodes[index + 1] ? '连续发送，不等待回复' : '开场结束，后续客户消息进入 AI',
    }))
  const entry = usesFlow ? saved.entry_key : nodes[0]?.node_key || AI_KEY
  edges.unshift({ from_key: START_KEY, to_key: entry, trigger: 'default', runtime_label: '首次触发且未发送过欢迎介绍' })
  // Contacts that have already received messages do not restart the introduction.
  edges.push({ from_key: START_KEY, to_key: AI_KEY, trigger: 'keyword', condition_value: '', runtime_label: '已有会话且没有在途节点流程' })
  for (const node of nodes) {
    if (node.node_type === 'end') edges.push({ from_key: node.node_key, to_key: AI_KEY, trigger: 'default', runtime_label: '固定流程结束；后续新消息进入 AI' })
    if (node.node_type === 'followup' && node.status !== 'disabled') {
      for (let index = edges.length - 1; index >= 0; index -= 1) {
        if (edges[index].from_key === node.node_key) edges.splice(index, 1)
      }
      edges.push({ from_key: node.node_key, to_key: AI_KEY, trigger: 'any_reply', runtime_label: '只复聊一次；客户后续回复进入 AI' })
    }
  }
  nodes.unshift({ node_key: START_KEY, node_type: 'system_start', title: '客户进入', body: 'Windows 检测到客户入站消息；仅指定测试目标还支持无消息的加好友触发。已有客户与新客户分开处理。', parts: [], status: 'enabled' })
  nodes.push({ node_key: AI_KEY, node_type: 'system_ai', title: 'AI 按客户问题答疑', body: '岗位事实 + 人设与话术 + 历史对话 + 已发送流程摘要 → 生成回复；Windows 负责实际发送。', parts: [], status: 'enabled' })

  for (const [index, media] of aiMedia.entries()) {
    const key = `__runtime_media_${index}`
    nodes.push({ node_key: key, node_type: 'system_media', title: media.name,
      body: `${media.condition}；不是开场必发`, status: 'enabled',
      parts: [{kind: media.kind, media_name: media.name, body: ''}], media_source: media.source,
      media_condition: media.condition, media_position_id: media.position_id,
    })
    edges.push({ from_key: AI_KEY, to_key: key, trigger: 'keyword', runtime_label: media.condition })
  }

  // Compute a readable DAG layout without changing the saved node coordinates.
  const levels = new Map<string, number>([[START_KEY, 0]])
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false
    for (const edge of edges) {
      const from = levels.get(edge.from_key)
      if (from === undefined || edge.to_key === AI_KEY || edge.to_key === START_KEY || edge.from_key === AI_KEY) continue
      const next = Math.min(nodes.length, from + 1)
      if (next > (levels.get(edge.to_key) ?? -1)) { levels.set(edge.to_key, next); changed = true }
    }
    if (!changed) break
  }
  const aiDepth = Math.max(1, ...levels.values()) + 1
  levels.set(AI_KEY, aiDepth)
  const slots = new Map<number, number>()
  const levelCounts = new Map<number, number>()
  for (const node of nodes.filter(node => node.node_type !== 'system_media')) { const level = levels.get(node.node_key) ?? 1; levelCounts.set(level, (levelCounts.get(level) || 0) + 1) }
  const bandHeight = 240 + (Math.max(1, ...levelCounts.values()) - 1) * 208
  for (const node of nodes) {
    if (node.node_type === 'system_media') continue
    const level = levels.get(node.node_key) ?? 1
    const slot = slots.get(level) ?? 0
    slots.set(level, slot + 1)
    const band = Math.floor(level / 3)
    const column = band % 2 === 0 ? level % 3 : 2 - level % 3
    node.x = 48 + column * 372
    node.y = 48 + band * bandHeight + slot * 208
  }
  if (aiMedia.length) {
    const mediaTop = Math.max(...nodes.filter(node => node.node_type !== 'system_media').map(node => Number(node.y || 0))) + 240
    nodes.filter(node => node.node_type === 'system_media').forEach((node, index) => {
      node.x = 48 + (index % 3) * 372
      node.y = mediaTop + Math.floor(index / 3) * 208
    })
  }
  return { ...saved, entry_key: START_KEY, nodes, edges, presentation_only: true }
}

export function compareOpeningContents(saved: AgentFlow, openings: LegacyOpening[]): boolean {
  const configured: NonNullable<AgentFlowNode['parts']> = []
  const seen = new Set<string>()
  let key = saved.entry_key
  while (key && !seen.has(key)) {
    seen.add(key)
    const node = saved.nodes.find(item => item.node_key === key)
    if (!node || node.node_type === 'branch' || node.node_type === 'followup') return false
    if (node.status !== 'disabled') configured.push(...(node.parts || []))
    const outgoing = saved.edges.filter(edge => edge.from_key === key)
    if (outgoing.some(edge => ['keyword', 'timeout'].includes(edge.trigger))) return false
    key = (outgoing.find(edge => edge.trigger === 'default') || outgoing.find(edge => edge.trigger === 'any_reply'))?.to_key || ''
  }
  const old = activeOpenings(openings)
  return configured.length === old.length && configured.every((part, index) =>
    part.kind === old[index].kind && (part.kind === 'text'
      ? String(part.body || '').trim() === String(old[index].content || '').trim()
      : part.media_name === old[index].media_name))
}

export function describeRuntimeNode(node: AgentFlowNode, graph: AgentFlow, legacy: boolean): string[] {
  if (node.node_type === 'system_media') return [
    `${node.media_source || '素材库'}；${node.media_condition || '客户问相关内容时，AI选择素材'}。不是开场必发，也不会按图上顺序依次发送所有素材。`,
    '这是当前 AI 上下文中可选择的真实素材。AI 根据客户问题、人设话术和历史记录生成 image/video 消息，Windows 再下载并发送。',
    '画布不把“素材可用”当成“已经发送”。如需每位新客户固定收到此素材，应在启用的节点流程中配置媒体消息。',
  ]
  if (node.node_type === 'system_start') return [
    '新客户：Windows 检测到入站消息，且账本中没有已发送记录，才开始欢迎介绍。',
    '仅指定 target 的测试范围支持“加好友但尚未发消息”触发；全部联系人模式不会据此批量欢迎历史好友。',
    '旧客户：有在途节点快照时继续原快照；没有在途节点时进入 AI 答疑，不重发欢迎介绍。',
    '设备需运行自动回复且企微在线、桌面可交互。服务端有绑定或心跳不代表正在发送。',
  ]
  if (node.node_type === 'system_ai') return [
    '客户问题进入 AI：读取这个设备绑定岗位的事实、人设、话术和已有对话，生成回复。此阶段的每句内容会随客户问题变化。',
    '固定节点由程序按连接执行；AI 不决定固定节点顺序。节点发送阶段不会同时调用 AI 回答。',
    '节点流程结束后，终端等待节点的该条回复交给 AI；其他结束路径由客户后续新消息触发。',
    '已发节点摘要会提供给 AI，减少重复介绍。实际发送仍由 Windows 完成，网页点击节点只查看配置。',
    'AI 可返回多段文本和指定素材。Windows 先发送文本，再预取并发送对应图片/视频；媒体失败会单独记日志，不会把已成功发送的文本回滚，也不自动重发媒体。',
    '本图没有把 AI 动态生成的回答当成固定模板；需要看实际会话，才能知道客户收到的具体内容。',
  ]
  if (node.status === 'disabled') return ['此节点停用：不发送内容，不检查它的关键词或超时条件，沿 default／any_reply 主出口继续。', '已经开始的会话继续原流程快照，不因这里的改动而重写。']
  const result: string[] = []
  if (node.node_type === 'branch') result.push('此节点不发消息。用触发本轮的客户文本按优先级从高到低做关键词包含匹配；没有命中时走默认连接。')
  else if (node.node_type === 'end') result.push('固定节点流程到此结束；不会把“结束”当作一条文字发给客户。后续新客户消息进入 AI。')
  else {
    for (const [index, part] of (node.parts || []).entries()) {
      const seconds = Number(part.delay_ms ?? node.delay_ms ?? 2000) / 1000
      const timing = legacy ? '发送节奏使用 Windows 客户端冷却配置，失败会增加退避；旧开场暂不读取每条的发送间隔设置。' : `完成后间隔 ${seconds} 秒。`
      if (part.kind === 'text') result.push(`第 ${index + 1} 条：发送下面的原文，确认目标会话与文本发送结果。${timing}`)
      else {
        result.push(`第 ${index + 1} 条${part.kind === 'video' ? '视频' : '图片'}：先查 Windows 本地素材，缺失时从服务器预取「${part.media_name || '未选择素材'}」，再通过现有企微媒体发送动作处理。${timing}`)
        if (!legacy) result.push('媒体需要本轮先成功发送文本并确认目标会话；跨过等待闸门后会重新开始本轮校验。独立媒体节点若没有这个前提，会暂停待人工核对。')
        else result.push('旧开场与节点流程是两条运行路径。旧开场媒体失败会记录失败并继续后续项，不会像节点流程一样暂停整条流程；页面显示素材配置不等于媒体已送达。')
      }
    }
  }
  if (legacy) result.push('旧开场连续发送：不会因为文案里问了“能否接受”就自动等待；发送完成后，客户下一条消息进入 AI。')
  else if (node.node_type === 'followup') result.push('等待超时后只发送一次；北京时间 21:00–09:00 不主动复聊，每台设备最多每分钟尝试一次，发送后结束固定介绍。')
  else if (node.await_reply) {
    result.push(`发送完成后等待客户回复；${node.wait_minutes || 15} 分钟后仅在配置了 timeout → 复聊节点时才会主动复聊，等待分钟数本身不会生成消息。`)
    result.push('客户任意有效文本先匹配关键词，未命中走“客户回复”兜底。没有配置同意/拒绝分支时，“不接受”也可能继续下一节点。')
  } else if (!['branch', 'end'].includes(node.node_type)) result.push('连续执行：不等客户回复，沿“继续”连接进入下一节点。')
  const timeout = graph.edges.some(edge => edge.from_key === node.node_key && edge.trigger === 'timeout')
  if (!legacy && node.await_reply && !timeout) result.push('当前没有配置超时复聊连接，因此不会自动催问。')
  result.push(legacy ? '旧开场文本失败时暂停本轮；媒体失败单独记录并继续。真实送达应核对企微消息，不能只看配置。' : '发送失败或目标不明确时暂停待人工核对；不会把按下回车直接当作客户已收到。')
  return result
}

/**
 * 节点流程的纯图操作：归一化、追加节点、删除节点。
 *
 * 这些函数不做 IO、不依赖 Vue，只负责保持图仍然满足后端
 * `src/modules/agent/agent-flow.routes.ts` 的 `validateGraph` 约束：
 * - 非 end 节点必须有出口（default 或 any_reply）
 * - 等待回复的节点必须有 any_reply 兜底
 * - end 节点不能有出边
 * - followup 只能通过 timeout 进入，且发送后必须结束
 * - 不能出现从入口不可达的孤儿节点
 */

const DEFAULT_WAIT_MINUTES = 15
const DEFAULT_DELAY_MS = 2000
const NODE_X_STEP = 360
const NODE_Y_STEP = 196
const NODE_WIDTH = 272
const NODE_HEIGHT = 148
const NO_PARTS_TYPES = new Set(["branch", "end"])
const NO_TAIL_TYPES = new Set(["end", "followup"])

export interface FlowPartLike {
  kind: string
  body?: string
  media_name?: string
  delay_ms?: number
}

export interface FlowNodeLike {
  node_key: string
  node_type: string
  title?: string
  body?: string
  parts?: FlowPartLike[]
  await_reply?: boolean
  wait_minutes?: number
  max_times?: number
  status?: string
  [key: string]: unknown
}

export interface FlowEdgeLike {
  from_key: string
  to_key: string
  trigger: string
  condition_value?: string
  priority?: number
  [key: string]: unknown
}

export interface FlowLike {
  entry_key: string
  nodes: FlowNodeLike[]
  edges: FlowEdgeLike[]
  [key: string]: unknown
}

/** 补齐接口返回里可能缺失的字段，避免编辑器在 `parts[0]` 上崩溃。 */
export function normalizeFlow<T extends FlowLike>(raw: T): T {
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((node) => {
    const parts = Array.isArray(node.parts) ? node.parts : []
    const keepParts = parts.length > 0 || NO_PARTS_TYPES.has(String(node.node_type)) ||
      (Array.isArray(raw.shared_opening) && raw.shared_opening.includes(node.node_key))
    return {
      ...node,
      title: node.title || node.node_key,
      await_reply: Boolean(node.await_reply),
      wait_minutes: Number(node.wait_minutes) || DEFAULT_WAIT_MINUTES,
      parts: keepParts ? parts : [{ kind: "text", body: String(node.body || ""), delay_ms: DEFAULT_DELAY_MS }],
    }
  })
  return {
    ...raw,
    entry_key: String(raw.entry_key || nodes[0]?.node_key || ""),
    nodes,
    edges: (Array.isArray(raw.edges) ? raw.edges : []).map((edge) => ({
      ...edge,
      condition_value: edge.condition_value ?? "",
      priority: Number(edge.priority) || 0,
    })),
  }
}

/** 节点的常规出口：default（连续发送）或 any_reply（等待回复）。 */
export function findPrimaryOut(flow: FlowLike, nodeKey: string): FlowEdgeLike | undefined {
  return flow.edges.find(
    (edge) => edge.from_key === nodeKey && (edge.trigger === "default" || edge.trigger === "any_reply"),
  )
}

export function nextNodeKey(nodes: FlowNodeLike[]): string {
  const used = new Set(nodes.map((node) => node.node_key))
  let index = 1
  while (used.has(`node_${index}`)) index += 1
  return `node_${index}`
}

function storedPosition(node: FlowNodeLike, index: number): { x: number; y: number } {
  return {
    x: Number.isFinite(Number(node.x)) ? Number(node.x) : 80,
    y: Number.isFinite(Number(node.y)) ? Number(node.y) : 48 + index * NODE_Y_STEP,
  }
}

function nextFreePosition(
  nodes: FlowNodeLike[],
  preferred: { x: number; y: number },
): { x: number; y: number } {
  let candidate = { ...preferred }
  for (let attempt = 0; attempt <= nodes.length; attempt += 1) {
    const overlaps = nodes.some((node, index) => {
      const point = storedPosition(node, index)
      return Math.abs(candidate.x - point.x) < NODE_WIDTH + 44 &&
        Math.abs(candidate.y - point.y) < NODE_HEIGHT + 36
    })
    if (!overlaps) return candidate
    candidate = { x: preferred.x, y: candidate.y + NODE_Y_STEP }
  }
  return candidate
}

export function createBlankFlow(positionId: number) {
  return {
    position_id: positionId,
    version: 0,
    status: "disabled",
    entry_key: "intro",
    canvas: { viewport: {} },
    nodes: [{
      node_key: "intro",
      node_type: "text",
      title: "招聘介绍",
      parts: [{ kind: "text", body: "请填写此节点要发送的内容", delay_ms: DEFAULT_DELAY_MS }],
      await_reply: true,
      wait_minutes: DEFAULT_WAIT_MINUTES,
      max_times: 1,
      x: 80,
      y: 64,
      status: "enabled",
    }],
    edges: [{ from_key: "intro", to_key: "", trigger: "any_reply", condition_value: "", priority: 0 }],
  }
}

/**
 * 在流程末尾追加一个节点，并把上一个可续接节点的出口改接到新节点。
 * followup 不能作为链尾（只能通过 timeout 进入），end 不能再有出边，两者都跳过。
 */
export function addFlowNode<T extends FlowLike>(source: T, kind: "text" | "image" | "video" | "end"): T {
  const nodeKey = nextNodeKey(source.nodes)
  const tail = [...source.nodes].reverse().find((item) => !NO_TAIL_TYPES.has(String(item.node_type)))
  const tailIndex = tail ? source.nodes.indexOf(tail) : -1
  const tailPoint = tail ? storedPosition(tail, tailIndex) : { x: 80, y: 48 }
  const maxBottom = source.nodes.reduce((max, item, index) => {
    const point = storedPosition(item, index)
    return Math.max(max, point.y + NODE_HEIGHT)
  }, 0)
  const position = nextFreePosition(source.nodes, {
    x: tailPoint.x,
    y: Math.max(tailPoint.y + NODE_Y_STEP, maxBottom + 40),
  })
  const node: FlowNodeLike =
    kind === "end"
      ? {
          node_key: nodeKey,
          node_type: "end",
          title: "结束",
          parts: [],
          await_reply: false,
          wait_minutes: DEFAULT_WAIT_MINUTES,
          max_times: 1,
          x: position.x,
          y: position.y,
          status: "enabled",
        }
      : {
          node_key: nodeKey,
          node_type: kind,
          title: `新节点 ${source.nodes.length + 1}`,
          parts: [{
            kind,
            body: kind === "text" ? "请填写此节点要发送的内容" : "",
            media_name: "",
            delay_ms: DEFAULT_DELAY_MS,
          }],
          await_reply: true,
          wait_minutes: DEFAULT_WAIT_MINUTES,
          max_times: 1,
          x: position.x,
          y: position.y,
          status: "enabled",
        }

  const edges = source.edges.map((edge) => ({ ...edge }))
  let previousTarget = ""
  if (tail) {
    const out = edges.find(
      (edge) => edge.from_key === tail.node_key && (edge.trigger === "default" || edge.trigger === "any_reply"),
    )
    if (out) {
      previousTarget = out.to_key
      out.to_key = nodeKey
    } else {
      edges.push({
        from_key: tail.node_key,
        to_key: nodeKey,
        trigger: tail.await_reply ? "any_reply" : "default",
        condition_value: "",
        priority: 0,
      })
    }
  }
  if (kind !== "end") {
    const successor = source.nodes.find((item) => item.node_key === previousTarget)
    edges.push({
      from_key: nodeKey,
      to_key: successor?.node_key ?? "",
      trigger: "any_reply",
      condition_value: "",
      priority: 0,
    })
  } else if (previousTarget) {
    throw new Error("结束节点只能添加在流程终端出口")
  }
  return { ...source, nodes: [...source.nodes, node], edges }
}

/** Return a copied graph with only the selected node's persisted coordinates changed. */
export function moveFlowNode<T extends FlowLike>(source: T, nodeKey: string, x: number, y: number): T {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return source
  const index = source.nodes.findIndex((node) => node.node_key === nodeKey)
  if (index < 0) return source
  const nodes = source.nodes.map((node, current) => current === index ? { ...node, x, y } : node)
  return { ...source, nodes }
}

/** Convert window pointer movement into the graph's stored coordinate space. */
export function dragFlowPoint(
  nodeOrigin: { x: number; y: number },
  pointerOrigin: { x: number; y: number },
  pointerCurrent: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return {
    x: nodeOrigin.x + (pointerCurrent.x - pointerOrigin.x) / scale,
    y: nodeOrigin.y + (pointerCurrent.y - pointerOrigin.y) / scale,
  }
}

/** Copy one transition before editing it in the inspector. */
export function updateFlowEdge<T extends FlowLike>(source: T, index: number, patch: Partial<FlowEdgeLike>): T {
  if (!Number.isInteger(index) || index < 0 || index >= source.edges.length) return source
  const edges = source.edges.map((edge, current) => current === index ? { ...edge, ...patch } : edge)
  return { ...source, edges }
}

/** Add an optional keyword route while leaving the node's primary fallback intact. */
export function addFlowEdge<T extends FlowLike>(source: T, fromKey: string): T {
  const node = source.nodes.find((item) => item.node_key === fromKey)
  if (!node || NO_TAIL_TYPES.has(String(node.node_type))) throw new Error("请选择可添加条件连接的节点")
  if (node.node_type !== "branch" && !node.await_reply) throw new Error("关键词连接只能添加在分支或等待回复节点")
  const primary = findPrimaryOut(source, fromKey)
  const target = primary?.to_key || ""
  if (source.edges.some((edge) => edge.from_key === fromKey && edge.to_key === target && edge.trigger === "keyword")) {
    throw new Error("该关键词连接已存在")
  }
  const edge: FlowEdgeLike = {
    from_key: fromKey,
    to_key: target,
    trigger: "keyword",
    condition_value: "新关键词",
    priority: 0,
  }
  return { ...source, edges: [...source.edges.map((item) => ({ ...item })), edge] }
}

export type RemoveEdgeBlocked = "missing" | "required-fallback"

/** Required runtime fallbacks must stay connected; optional conditions can be removed. */
export function removeFlowEdge<T extends FlowLike>(
  source: T,
  index: number,
): { flow: T; blocked?: RemoveEdgeBlocked } {
  if (!Number.isInteger(index) || index < 0 || index >= source.edges.length) {
    return { flow: source, blocked: "missing" }
  }
  const edge = source.edges[index]
  const target = source.nodes.find((node) => node.node_key === edge.to_key)
  if (["default", "any_reply"].includes(edge.trigger) ||
      (edge.trigger === "timeout" && target?.node_type === "followup" && target.status !== "disabled")) {
    return { flow: source, blocked: "required-fallback" }
  }
  return { flow: { ...source, edges: source.edges.filter((_, current) => current !== index) } }
}

/** Insert a branch at an existing primary exit; preserve its prior successor as the fallback. */
export function addBranchNode<T extends FlowLike>(source: T, fromKey: string): T {
  const origin = source.nodes.find((node) => node.node_key === fromKey)
  if (!origin || NO_TAIL_TYPES.has(String(origin.node_type))) throw new Error("请选择可继续的节点")
  const nodeKey = nextNodeKey(source.nodes)
  const edges = source.edges.map((edge) => ({ ...edge }))
  const primaryIndex = edges.findIndex((edge) => edge.from_key === fromKey && (edge.trigger === "default" || edge.trigger === "any_reply"))
  if (primaryIndex < 0) throw new Error("所选节点没有可接入分支的出口")
  const previousTarget = edges[primaryIndex].to_key
  edges[primaryIndex].to_key = nodeKey
  const fallback = source.nodes.find((node) => node.node_key === previousTarget)
  const sourcePoint = storedPosition(origin, source.nodes.indexOf(origin))
  const position = nextFreePosition(source.nodes, { x: sourcePoint.x + NODE_X_STEP, y: sourcePoint.y })
  const node: FlowNodeLike = {
    node_key: nodeKey,
    node_type: "branch",
    title: `分支 ${source.nodes.length + 1}`,
    parts: [],
    await_reply: false,
    wait_minutes: DEFAULT_WAIT_MINUTES,
    max_times: 1,
    x: position.x,
    y: position.y,
    status: "enabled",
  }
  edges.push({ from_key: nodeKey, to_key: fallback?.node_key ?? "", trigger: "default", condition_value: "", priority: 0 })
  return { ...source, nodes: [...source.nodes, node], edges }
}

/** Add a one-time timeout message to a waiting node; the caller edits its text before save. */
export function addFollowupNode<T extends FlowLike>(source: T, awaitNodeKey: string): T {
  const waitingNode = source.nodes.find((node) => node.node_key === awaitNodeKey)
  if (!waitingNode || !waitingNode.await_reply) throw new Error("只能从等待回复节点添加复聊")
  if (source.edges.some((edge) => edge.from_key === awaitNodeKey && edge.trigger === "timeout")) {
    throw new Error("该节点已经有超时复聊")
  }
  const nodeKey = nextNodeKey(source.nodes)
  const sourcePoint = storedPosition(waitingNode, source.nodes.indexOf(waitingNode))
  const position = nextFreePosition(source.nodes, { x: sourcePoint.x + NODE_X_STEP, y: sourcePoint.y })
  const node: FlowNodeLike = {
    node_key: nodeKey,
    node_type: "followup",
    title: "超时复聊",
    parts: [{ kind: "text", body: "请填写复聊内容", delay_ms: DEFAULT_DELAY_MS }],
    await_reply: false,
    wait_minutes: Number(waitingNode.wait_minutes) || DEFAULT_WAIT_MINUTES,
    max_times: 1,
    x: position.x,
    y: position.y,
    status: "enabled",
  }
  const edges = source.edges.map((edge) => ({ ...edge }))
  edges.push(
    { from_key: awaitNodeKey, to_key: nodeKey, trigger: "timeout", condition_value: "", priority: 0 },
    { from_key: nodeKey, to_key: "", trigger: "default", condition_value: "", priority: 0 },
  )
  return { ...source, nodes: [...source.nodes, node], edges }
}

export function flowRequiresEnableConfirmation(previousStatus: string, nextStatus: string): boolean {
  return previousStatus !== "enabled" && nextStatus === "enabled"
}

/** Change the entry and disable active nodes that would no longer be reachable. */
export function changeFlowEntry<T extends FlowLike>(
  source: T,
  nodeKey: string,
): { flow: T; disabledNodeKeys: string[]; blocked?: "missing" | "disabled" } {
  const entry = source.nodes.find((node) => node.node_key === nodeKey)
  if (!entry) return { flow: source, disabledNodeKeys: [], blocked: "missing" }
  if (entry.status === "disabled") return { flow: source, disabledNodeKeys: [], blocked: "disabled" }

  const reached = new Set<string>()
  function visit(key: string): void {
    if (!key || reached.has(key)) return
    reached.add(key)
    const node = source.nodes.find((item) => item.node_key === key)
    if (!node) return
    const outgoing = source.edges.filter((edge) => edge.from_key === key)
    const traversed = node.status === "disabled"
      ? [outgoing.find((edge) => edge.trigger === "default") ?? outgoing.find((edge) => edge.trigger === "any_reply")].filter(Boolean)
      : outgoing
    for (const edge of traversed) visit(edge!.to_key)
  }
  visit(nodeKey)

  const disabledNodeKeys = source.nodes
    .filter((node) => node.status !== "disabled" && !reached.has(node.node_key))
    .map((node) => node.node_key)
  const disabled = new Set(disabledNodeKeys)
  const nodes = source.nodes.map((node) => disabled.has(node.node_key) ? { ...node, status: "disabled" } : node)
  return { flow: { ...source, entry_key: nodeKey, nodes }, disabledNodeKeys }
}

/** Content that could become an accidental customer message must block activation. */
export function flowActivationIssues(source: FlowLike): string[] {
  const placeholders = new Set(["请填写此节点要发送的内容", "请填写复聊内容"])
  const issues: string[] = []
  for (const node of source.nodes) {
    if (node.status === "disabled" || NO_PARTS_TYPES.has(String(node.node_type))) continue
    for (const part of node.parts ?? []) {
      const label = `「${node.title || node.node_key}」`
      if (part.kind === "text") {
        const body = String(part.body || "").trim()
        if (!body) issues.push(`${label}的文本为空。请在「发送内容」中填写要发给候选人的话术。`)
        else if (placeholders.has(body)) {
          issues.push(`${label}还在使用系统示例文字「${body}」。请改成要发给候选人的话术。`)
        }
      } else if ((part.kind === "image" || part.kind === "video") && !String(part.media_name || "").trim()) {
        const media = part.kind === "image" ? "图片" : "视频"
        issues.push(`${label}还没选择${media}。请在「发送内容」中选择要发给候选人的${media}。`)
      }
    }
  }
  return issues
}

/** Identify node-level disable operations that change runtime behavior. */
export function newlyDisabledNodeKeys(before: FlowLike, after: FlowLike): string[] {
  const prior = new Map(before.nodes.map((node) => [node.node_key, node.status !== "disabled"]))
  return after.nodes
    .filter((node) => node.status === "disabled" && prior.get(node.node_key) !== false)
    .map((node) => node.node_key)
}

export type RemoveBlocked = "missing" | "last" | "entry"

/**
 * 删除一个节点：前驱边改指向被删节点的后继，被删节点的出边一并移除。
 * timeout 边只能指向 followup，后继不是复聊节点时这条边只能丢弃。
 */
export function removeFlowNode<T extends FlowLike>(
  source: T,
  nodeKey: string,
): { flow: T; blocked?: RemoveBlocked } {
  const index = source.nodes.findIndex((node) => node.node_key === nodeKey)
  if (index < 0) return { flow: source, blocked: "missing" }
  if (source.nodes.length <= 1) return { flow: source, blocked: "last" }
  if (nodeKey === source.entry_key) return { flow: source, blocked: "entry" }

  const successor = findPrimaryOut(source, nodeKey)?.to_key || ""
  const successorType = source.nodes.find((node) => node.node_key === successor)?.node_type
  const edges = source.edges.reduce<FlowEdgeLike[]>((kept, edge) => {
    if (edge.from_key === nodeKey) return kept
    if (edge.to_key !== nodeKey) {
      kept.push(edge)
      return kept
    }
    if (edge.trigger === "timeout" && successorType !== "followup") return kept
    kept.push({ ...edge, to_key: successor })
    return kept
  }, [])

  return { flow: { ...source, nodes: source.nodes.filter((_, i) => i !== index), edges } }
}

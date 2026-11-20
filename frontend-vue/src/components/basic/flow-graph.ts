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
    const keepParts = parts.length > 0 || NO_PARTS_TYPES.has(String(node.node_type))
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

/**
 * 在流程末尾追加一个节点，并把上一个可续接节点的出口改接到新节点。
 * followup 不能作为链尾（只能通过 timeout 进入），end 不能再有出边，两者都跳过。
 */
export function addFlowNode<T extends FlowLike>(source: T, kind: "text" | "end"): T {
  const nodeKey = nextNodeKey(source.nodes)
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
          status: "enabled",
        }
      : {
          node_key: nodeKey,
          node_type: "text",
          title: `新节点 ${source.nodes.length + 1}`,
          parts: [{ kind: "text", body: "请填写此节点要发送的内容", delay_ms: DEFAULT_DELAY_MS }],
          await_reply: true,
          wait_minutes: DEFAULT_WAIT_MINUTES,
          max_times: 1,
          status: "enabled",
        }

  const edges = source.edges.map((edge) => ({ ...edge }))
  const tail = [...source.nodes].reverse().find((item) => !NO_TAIL_TYPES.has(String(item.node_type)))
  if (tail) {
    const out = edges.find(
      (edge) => edge.from_key === tail.node_key && (edge.trigger === "default" || edge.trigger === "any_reply"),
    )
    if (out) {
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
    edges.push({ from_key: nodeKey, to_key: "", trigger: "any_reply", condition_value: "", priority: 0 })
  }
  return { ...source, nodes: [...source.nodes, node], edges }
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

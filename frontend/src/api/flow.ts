/** /api/v1/flow-nodes、/api/v1/flow-edges —— 节点化编排配置台用。 */
import { request } from "./client";

/** 边条件类型。后端 flow_graph.match_edge 按这个分支判断。 */
export type FlowConditionType = "always" | "keyword" | "regex" | "collected" | "intent";

export const FLOW_CONDITION_TYPES: Array<{ value: FlowConditionType; label: string; hint: string }> = [
  { value: "always", label: "无条件", hint: "按优先级第一条命中即跳转" },
  { value: "keyword", label: "关键词", hint: "客户这句话包含任一关键词就跳转，逗号分隔" },
  { value: "regex", label: "正则", hint: "高级用法，匹配客户原话" },
  { value: "collected", label: "已收集", hint: "某个槽位非空时跳转（如 phone 收到号码）" },
  { value: "intent", label: "意图", hint: "预留：当前按关键词处理" },
];

export function conditionLabel(type: string): string {
  return FLOW_CONDITION_TYPES.find((c) => c.value === type)?.label ?? type;
}

export interface FlowNode {
  id: number;
  tenant_id: number;
  device_code: string;
  vertical_code: string;
  node_key: string;
  title: string;
  body: string;
  media: string;
  is_entry: number;
  status: string;
  sort_order: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlowNodeInput {
  device_code: string;
  vertical_code: string;
  node_key: string;
  title?: string;
  body?: string;
  media?: string;
  is_entry?: number;
  status?: string;
  sort_order?: number;
}

export interface FlowEdge {
  id: number;
  tenant_id: number;
  device_code: string;
  vertical_code: string;
  from_node: string;
  to_node: string;
  condition_type: string;
  condition_value: string;
  priority: number;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlowEdgeInput {
  device_code: string;
  vertical_code: string;
  from_node: string;
  to_node: string;
  condition_type: string;
  condition_value?: string;
  priority?: number;
  status?: string;
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]));
  return new URLSearchParams(entries).toString();
}

export const flowApi = {
  async nodes(params: { vertical_code?: string; device_code?: string } = {}) {
    const q = query(params);
    const res = await request<{ items: FlowNode[]; total?: number }>(`/api/v1/flow-nodes${q ? `?${q}` : ""}`);
    return { items: res.items ?? [], total: res.total ?? (res.items ?? []).length };
  },
  /** 按 (device_code, vertical_code, node_key) upsert */
  saveNode(input: FlowNodeInput) {
    return request<FlowNode>("/api/v1/flow-nodes", { method: "POST", body: JSON.stringify(input) });
  },
  async removeNode(id: number) {
    return request<{ success?: boolean }>(`/api/v1/flow-nodes/${id}`, { method: "DELETE" });
  },
  async edges(params: { vertical_code?: string; device_code?: string } = {}) {
    const q = query(params);
    const res = await request<{ items: FlowEdge[]; total?: number }>(`/api/v1/flow-edges${q ? `?${q}` : ""}`);
    return { items: res.items ?? [], total: res.total ?? (res.items ?? []).length };
  },
  saveEdge(input: FlowEdgeInput) {
    return request<FlowEdge>("/api/v1/flow-edges", { method: "POST", body: JSON.stringify(input) });
  },
  async removeEdge(id: number) {
    return request<{ success?: boolean }>(`/api/v1/flow-edges/${id}`, { method: "DELETE" });
  },
};

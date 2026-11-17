/** /api/v1/agent/device-scripts 按设备话术（4222）。 */
import { request } from "./client";

export type DeviceScriptStage = "greet" | "ask_city" | "send_info" | "ask_interview" | "collect" | "done";

export const DEVICE_SCRIPT_STAGES: Array<{ value: DeviceScriptStage; label: string }> = [
  { value: "greet", label: "加好友招聘介绍" },
  { value: "ask_city", label: "询问城市" },
  { value: "send_info", label: "发送岗位信息" },
  { value: "ask_interview", label: "邀请面试" },
  { value: "collect", label: "收集报名" },
  { value: "done", label: "完成收尾" },
];

export function stageLabel(stage: string): string {
  return DEVICE_SCRIPT_STAGES.find((s) => s.value === stage)?.label ?? stage;
}

/** 内容占位符，后端渲染时替换；前端只做高亮展示。 */
export const DEVICE_SCRIPT_PLACEHOLDERS = ["factory", "wage", "place", "window"] as const;

export interface DeviceScript {
  id: number;
  device_code: string;
  city: string;
  stage: DeviceScriptStage | string;
  title: string;
  content: string;
  status: string;
  updated_at?: string | null;
}

export interface DeviceScriptInput {
  device_code: string;
  stage: DeviceScriptStage | string;
  city?: string;
  title?: string;
  content: string;
  status?: string;
}

export interface DeviceScriptListParams {
  device_code?: string;
  stage?: string;
  city?: string;
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]));
  return new URLSearchParams(entries).toString();
}

export const deviceScriptsApi = {
  async list(params: DeviceScriptListParams = {}) {
    const q = query({ device_code: params.device_code, stage: params.stage, city: params.city });
    const res = await request<DeviceScript[] | { items: DeviceScript[]; total?: number }>(`/api/v1/agent/device-scripts${q ? `?${q}` : ""}`);
    const items = Array.isArray(res) ? res : res.items ?? [];
    return { items, total: Array.isArray(res) ? res.length : res.total ?? items.length };
  },
  /** upsert by device_code+stage+city */
  save(input: DeviceScriptInput) {
    return request<DeviceScript>("/api/v1/agent/device-scripts", { method: "POST", body: JSON.stringify(input) });
  },
  remove(id: number) {
    return request<{ success?: boolean }>(`/api/v1/agent/device-scripts/${id}`, { method: "DELETE" });
  },
};

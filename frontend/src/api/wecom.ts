import { request } from "./client";

export interface WeComConnectionStatus {
  cursor: string;
  generation: number;
  processed_generation: number;
  token_expires_at: number;
  reply_after: number;
  last_sync_at: number;
  next_sync_at: number;
  last_error: string | null;
}

export interface WeComDisabledStatus { enabled: false; missing: string[]; }

export interface WeComEnabledStatus {
  enabled: true;
  corp_id: string;
  open_kfid: string;
  device_code: string;
  connection: WeComConnectionStatus;
  dify_provider: string;
  auto_reply_ready: boolean;
  auto_reply_blocked_reason: string | null;
}

export type WeComStatus = WeComDisabledStatus | WeComEnabledStatus;

export interface WeComSyncResult { pages: number; received: number; processed: number; cursor: string; }

export const wecomApi = {
  status: () => request<WeComStatus>("/api/v1/channels/wecom-kf/status"),
  run: (limit = 1000) => request<WeComSyncResult>("/api/v1/channels/wecom-kf/run", {
    method: "POST",
    body: JSON.stringify({ limit }),
  }),
};

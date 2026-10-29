import { request } from "./client";

export interface AgentDevice {
  id: number;
  device_code: string;
  name: string;
}

export interface Conversation {
  id: number;
  device_code: string;
  customer_id: number;
  nickname: string;
  state: string;
  recruit_status: string;
  takeover: number;
  unread: number;
  city: string;
  district: string;
  last_msg: string;
  last_msg_at: string | null;
  updated_at: string;
}

export interface AgentMessage {
  id: number;
  device_code: string;
  customer_id: number;
  direction: "inbound" | "outbound";
  content: string;
  status: string;
  created_at: string;
}

export type BridgeState = "online" | "offline" | "scanning";

export interface BridgeStatus {
  device_code: string;
  account_id: string;
  state: BridgeState;
  heartbeat_at: number;
}

export interface ActivationRecord {
  id: number;
  strategy: string;
  status: string;
  script: string;
  reason: string;
  created_at: string;
}

export type FunnelEvent = "invited" | "checked_in" | "disqualified";

export interface CandidateEvent {
  id: number;
  device_code: string;
  customer_id: string;
  event_type: string;
  created_at: string;
}

const q = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

export const agentApi = {
  listDevices() {
    return request<{ items: AgentDevice[] }>("/api/v1/agent/devices");
  },
  listConversations(deviceCode: string) {
    return request<{ items: Conversation[]; total_unread: number }>(`/api/v1/agent/conversations?${q({ device_code: deviceCode })}`);
  },
  listMessages(deviceCode: string, customerId: number, afterId = 0) {
    return request<{ items: AgentMessage[] }>(
      `/api/v1/agent/messages?${q({ device_code: deviceCode, customer_id: customerId, after_id: afterId })}`,
    );
  },
  bridgeStatus(deviceCode: string) {
    return request<{ device: BridgeStatus | null }>(`/api/v1/bridge/devices/${encodeURIComponent(deviceCode)}`);
  },
  setTakeover(deviceCode: string, customerId: number, takeover: boolean) {
    return request<{ success: boolean }>("/api/v1/agent/takeover", {
      method: "POST",
      body: JSON.stringify({ device_code: deviceCode, customer_id: customerId, takeover }),
    });
  },
  manualReply(deviceCode: string, customerId: number, content: string, idempotencyKey: string) {
    return request<AgentMessage>("/api/v1/agent/manual-reply", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ device_code: deviceCode, customer_id: customerId, content }),
    });
  },
  markFunnel(conversation: Conversation, eventType: FunnelEvent) {
    return request<unknown>("/api/v1/agent/candidates", {
      method: "POST",
      // The route answers 422 unless customer_id is a string.
      body: JSON.stringify({
        device_code: conversation.device_code,
        customer_id: String(conversation.customer_id),
        nickname: conversation.nickname,
        city: conversation.city,
        event_type: eventType,
      }),
    });
  },
  listCandidateEvents() {
    // No per-customer filter exists server-side; 1000 is the route's page_size cap.
    return request<{ items: CandidateEvent[]; total: number }>("/api/v1/agent/candidates?page_size=1000");
  },
  activationHistory(customerId: number) {
    return request<{ records: ActivationRecord[] }>(`/api/v1/activation/customers/${customerId}`);
  },
};

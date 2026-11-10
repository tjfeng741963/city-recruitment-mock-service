import { useCallback, useEffect, useRef, useState } from "react";
import { agentApi, type AgentDevice, type BridgeState, type Conversation } from "../../api/agent";
import { ApiError } from "../../api/client";
import { conversationKey, threadInfo, type ThreadInfo } from "./triage";

export const POLL_MS = 10_000;

export type DeviceState = BridgeState | "unpaired";

export interface DeviceView {
  device: AgentDevice;
  state: DeviceState;
  heartbeatAt: number;
}

export interface ReceptionData {
  devices: DeviceView[];
  conversations: Conversation[];
  threads: Map<string, ThreadInfo>;
}

async function loadDevice(device: AgentDevice): Promise<{ view: DeviceView; conversations: Conversation[] }> {
  const [bridge, list] = await Promise.all([
    agentApi.bridgeStatus(device.device_code).catch(() => ({ device: null })),
    agentApi.listConversations(device.device_code),
  ]);
  return {
    view: { device, state: bridge.device?.state ?? "unpaired", heartbeatAt: bridge.device?.heartbeat_at ?? 0 },
    conversations: list.items,
  };
}

async function loadAll(): Promise<ReceptionData> {
  const { items: devices } = await agentApi.listDevices();
  const perDevice = await Promise.all(devices.filter((d) => d.device_code).map(loadDevice));
  const conversations = perDevice.flatMap((d) => d.conversations);
  // Only taken-over conversations can be "waiting", so only they need the message thread.
  const threadEntries = await Promise.all(
    conversations
      .filter((c) => c.takeover === 1)
      .map(async (c) => {
        const { items } = await agentApi.listMessages(c.device_code, c.customer_id);
        return [conversationKey(c), threadInfo(items)] as const;
      }),
  );
  return { devices: perDevice.map((d) => d.view), conversations, threads: new Map(threadEntries) };
}

export function useReception() {
  const [data, setData] = useState<ReceptionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await loadAll());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载失败，10 秒后自动重试");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { data, error, refresh };
}

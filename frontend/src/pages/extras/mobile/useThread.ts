import { useCallback, useEffect, useRef, useState } from "react";
import { agentApi } from "../../../api/agent";
import { ApiError } from "../../../api/client";
import { mobileApi, type MobileMessage } from "../../../api/extras";

const THREAD_POLL_MS = 3_000;

export function useThread(deviceCode: string, customerId: number) {
  const [messages, setMessages] = useState<MobileMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(0);

  const pull = useCallback(async () => {
    try {
      const { items } = await mobileApi.messages(deviceCode, customerId, lastId.current);
      setError(null);
      if (!items.length) {
        setMessages((prev) => prev ?? []);
        return;
      }
      lastId.current = items[items.length - 1].id;
      setMessages((prev) => {
        const seen = new Set((prev ?? []).map((m) => m.id));
        return [...(prev ?? []), ...items.filter((m) => !seen.has(m.id))];
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "消息加载失败");
    }
  }, [deviceCode, customerId]);

  useEffect(() => {
    lastId.current = 0;
    setMessages(null);
    pull();
    const timer = window.setInterval(() => {
      if (!document.hidden) pull();
    }, THREAD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pull]);

  return { messages, error, pull };
}

// crypto.randomUUID only exists in secure contexts; phones often open the page over plain http on the LAN.
function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same contract as the old manual-reply sender: one idempotency key per (device, customer, content),
// kept in sessionStorage until the send is confirmed, so a retry after a timeout or reload is deduped.
export async function sendManualReply(deviceCode: string, customerId: number, content: string) {
  const slot = `rea-send:${JSON.stringify([deviceCode, customerId, content])}`;
  const key = sessionStorage.getItem(slot) ?? newKey();
  sessionStorage.setItem(slot, key);
  const result = await agentApi.manualReply(deviceCode, customerId, content, key);
  sessionStorage.removeItem(slot);
  return result;
}

export function sendErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 502) return "微信号没把消息发出去，检查号是否在线后再点发送";
  if (err instanceof ApiError && err.status === 409) return "上一次发送还没有结果，稍等几秒再点发送";
  return err instanceof ApiError ? err.detail : "发送失败，请重试";
}

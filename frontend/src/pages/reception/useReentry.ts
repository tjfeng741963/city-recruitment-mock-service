import { useEffect, useState } from "react";
import type { Conversation } from "../../api/agent";
import { formatWait, minutesSince, parseDbTime, REENTRY_GAP_MS } from "./triage";

const STORAGE_KEY = "rea_reception_last_seen";
const TOUCH_MS = 60_000;

function readLastSeen(): number | null {
  const value = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function writeLastSeen(ms: number): void {
  localStorage.setItem(STORAGE_KEY, String(ms));
}

export function reentryText(conversations: Conversation[], lastSeen: number | null, now: number): string | null {
  if (lastSeen === null || now - lastSeen < REENTRY_GAP_MS) return null;
  const count = conversations.filter((c) => {
    const at = parseDbTime(c.last_msg_at);
    return at !== null && at > lastSeen;
  }).length;
  return count ? `你不在的 ${formatWait(minutesSince(lastSeen, now))}里有 ${count} 人发来消息` : null;
}

export function useReentry(conversations: Conversation[] | null): string | null {
  const [awaySince, setAwaySince] = useState<number | null>(readLastSeen);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!conversations || awaySince === null) return;
    setText(reentryText(conversations, awaySince, Date.now()));
    setAwaySince(null);
  }, [conversations, awaySince]);

  useEffect(() => {
    const touch = () => document.visibilityState === "visible" && writeLastSeen(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        writeLastSeen(Date.now());
        return;
      }
      setAwaySince(readLastSeen());
      writeLastSeen(Date.now());
    };
    touch();
    const timer = window.setInterval(touch, TOUCH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return text;
}

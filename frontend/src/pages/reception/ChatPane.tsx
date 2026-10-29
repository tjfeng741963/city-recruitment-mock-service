import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { agentApi, type AgentMessage, type Conversation } from "../../api/agent";
import { ApiError } from "../../api/client";
import { Badge, Button, Icon } from "@ui";
import { parseDbTime } from "./triage";
import { POLL_MS } from "./useReception";

const STATUS_NOTE: Record<string, string> = {
  failed: "没发出去",
  simulated: "模拟回复",
};

function timeLabel(value: string): string {
  const ms = parseDbTime(value);
  return ms === null ? "" : new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function useThread(conversation: Conversation) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const lastId = useRef(0);
  const { device_code: deviceCode, customer_id: customerId } = conversation;

  const pull = useCallback(async () => {
    const { items } = await agentApi.listMessages(deviceCode, customerId, lastId.current);
    if (!items.length) return;
    lastId.current = items[items.length - 1].id;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...items.filter((m) => !seen.has(m.id))];
    });
  }, [deviceCode, customerId]);

  useEffect(() => {
    lastId.current = 0;
    setMessages([]);
    pull().catch(() => undefined);
    const timer = window.setInterval(() => pull().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pull]);

  return { messages, pull };
}

function sendErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 502) return "微信号没把消息发出去，检查号是否在线后再点发送";
  if (err instanceof ApiError && err.status === 409) return "上一次发送还没有结果，稍等几秒再点发送";
  return err instanceof ApiError ? err.detail : "发送失败，请重试";
}

export function ChatPane({ conversation, onChanged }: { conversation: Conversation; onChanged: () => void }) {
  const { messages, pull } = useThread(conversation);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"takeover" | "release" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reusing the key on retry lets the backend dedupe a send whose result we never saw.
  const pendingKey = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const isTakenOver = conversation.takeover === 1;
  const isSimulated = messages.some((m) => m.direction === "outbound" && m.status === "simulated");
  const name = conversation.nickname || `候选人 ${conversation.customer_id}`;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    setDraft("");
    setError(null);
    pendingKey.current = null;
  }, [conversation.device_code, conversation.customer_id]);

  async function toggleTakeover(next: boolean) {
    setBusy(next ? "takeover" : "release");
    setError(null);
    try {
      await agentApi.setTakeover(conversation.device_code, conversation.customer_id, next);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "操作失败，请重试");
    } finally {
      setBusy(null);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    pendingKey.current ??= crypto.randomUUID();
    setBusy("send");
    setError(null);
    try {
      await agentApi.manualReply(conversation.device_code, conversation.customer_id, content, pendingKey.current);
      pendingKey.current = null;
      setDraft("");
      await pull();
      onChanged();
    } catch (err) {
      setError(sendErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <section className="rc-chat" aria-label={`与 ${name} 的会话`}>
      <header className="rc-chat-head">
        <div>
          <h2>{name}</h2>
          <span className="rc-chat-sub">{isTakenOver ? "你在接待，AI 已暂停" : "AI 在接待"}</span>
        </div>
        <div className="rc-chat-actions">
          {isSimulated && <Badge>模拟回复</Badge>}
          {isTakenOver && (
            <Button variant="secondary" size="sm" icon={<Icon name="robot" size={15} />} loading={busy === "release"} onClick={() => toggleTakeover(false)}>
              交还 AI
            </Button>
          )}
        </div>
      </header>

      <div className="rc-chat-scroll" ref={scroller} role="log" aria-live="polite">
        {messages.length === 0 && <p className="rc-chat-empty">还没有消息</p>}
        {messages.map((m) => (
          <div key={m.id} className={`rc-msg is-${m.direction} ${m.status === "failed" ? "is-failed" : ""}`}>
            <p className="rc-bubble">{m.content}</p>
            <span className="rc-msg-meta">
              {timeLabel(m.created_at)}
              {STATUS_NOTE[m.status] && ` · ${STATUS_NOTE[m.status]}`}
            </span>
          </div>
        ))}
      </div>

      <footer className="rc-compose">
        {error && <p className="rc-compose-error" role="alert">{error}</p>}
        {isTakenOver ? (
          <form className="rc-compose-form" onSubmit={send}>
            <textarea
              aria-label="回复内容"
              placeholder="输入回复，Enter 发送，Shift+Enter 换行"
              rows={2}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                pendingKey.current = null;
              }}
              onKeyDown={onKeyDown}
            />
            <Button type="submit" loading={busy === "send"} disabled={!draft.trim()}>
              发送
            </Button>
          </form>
        ) : (
          <div className="rc-compose-locked">
            <span>接管后 AI 暂停回复，由你来回。</span>
            <Button icon={<Icon name="user" size={15} />} loading={busy === "takeover"} onClick={() => toggleTakeover(true)}>
              接管
            </Button>
          </div>
        )}
      </footer>
    </section>
  );
}

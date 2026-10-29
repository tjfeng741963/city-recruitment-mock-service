import { useEffect, useState } from "react";
import { Alert, Button, Dialog, EmptyState, RadioGroup, Skeleton } from "@ui";
import { candidatesApi, type Candidate, type ChatMessage } from "../../api/candidates";
import { errorText } from "./shared";

export const STATUS_LABEL: Record<string, string> = {
  invited: "报名成功",
  checked_in: "已签到",
  disqualified: "不符合",
  pending_invite: "待邀约",
  marked: "已标记",
};

const MARK_OPTIONS = ["invited", "checked_in", "pending_invite", "disqualified"].map((value) => ({ value, label: STATUS_LABEL[value] }));

function isCustomer(m: ChatMessage): boolean {
  return m.role ? m.role === "customer" : m.direction === "inbound";
}

export function ChatDialog({ candidate, onClose }: { candidate: Candidate; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    candidatesApi
      .messages(candidate.device_code, candidate.customer_id)
      .then((r) => alive && setMessages(r.items ?? []))
      .catch((err) => alive && setError(errorText(err, "对话记录没加载出来")));
    return () => {
      alive = false;
    };
  }, [candidate]);

  const who = candidate.name || candidate.nickname || candidate.customer_id;

  return (
    <Dialog open onClose={onClose} title={`对话记录 · ${who}`} footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}>
      {error ? (
        <Alert tone="danger" title={error} />
      ) : !messages ? (
        <div className="cd-chat">
          <Skeleton width="60%" height={36} />
          <Skeleton width="45%" height={36} />
        </div>
      ) : messages.length === 0 ? (
        <EmptyState icon="chat" title="还没有对话记录" description="这个人和 AI 之间还没有消息往来。" />
      ) : (
        <ol className="cd-chat" aria-label="对话记录">
          {messages.map((m) => (
            <li key={m.id} className={`cd-msg ${isCustomer(m) ? "is-customer" : "is-ai"}`}>
              <span className="cd-msg-who">{isCustomer(m) ? "求职者" : "AI"}</span>
              <p className="cd-msg-text">{m.content}</p>
              {m.dedup_original && <p className="cd-msg-orig">原文：{m.dedup_original}</p>}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

/** Marks one or more candidates with the same status. Calls the API once per candidate. */
export function MarkDialog({
  targets,
  onClose,
  onDone,
}: {
  targets: Candidate[];
  onClose: () => void;
  onDone: (status: string, failed: number) => void;
}) {
  const [status, setStatus] = useState(targets.length === 1 ? targets[0].status : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!status) {
      setError("请选择要标记的状态");
      return;
    }
    setSaving(true);
    setError(null);
    const results = await Promise.allSettled(targets.map((c) => candidatesApi.mark(c.id, c.device_code, status)));
    const failed = results.filter((r) => r.status === "rejected");
    setSaving(false);
    if (failed.length === targets.length) {
      setError(errorText((failed[0] as PromiseRejectedResult).reason, "标记失败，请稍后再试"));
      return;
    }
    onDone(status, failed.length);
  }

  const title = targets.length === 1 ? `标记 ${targets[0].name || targets[0].nickname || "候选人"}` : `标记 ${targets.length} 位候选人`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description="标记只改这个人当前的跟进状态，不会给对方发消息。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={submit} loading={saving}>保存标记</Button>
        </>
      }
    >
      <RadioGroup name="cd-mark" legend={<>标记为 <span className="ui-field-required">*</span></>} options={MARK_OPTIONS} value={status} onChange={setStatus} />
      {error && <p className="cd-field-error" role="alert">{error}</p>}
    </Dialog>
  );
}

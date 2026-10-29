import { useEffect, useState } from "react";
import { agentApi, type ActivationRecord, type CandidateEvent, type Conversation, type FunnelEvent } from "../../api/agent";
import { ApiError } from "../../api/client";
import { Avatar, Button } from "../../components/ui";
import type { DeviceView } from "./useReception";
import { parseDbTime } from "./triage";

const FUNNEL: Array<{ value: FunnelEvent; label: string }> = [
  { value: "invited", label: "已邀约" },
  { value: "checked_in", label: "已到场" },
  { value: "disqualified", label: "不合格" },
];

export const DEVICE_STATE_LABEL: Record<DeviceView["state"], string> = {
  online: "在线",
  scanning: "扫码中",
  offline: "掉线",
  unpaired: "未连接",
};

function dateLabel(value: string): string {
  const ms = parseDbTime(value);
  return ms === null ? "" : new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function useCandidateHistory(conversation: Conversation, reloadToken: number) {
  const [funnel, setFunnel] = useState<CandidateEvent[]>([]);
  const [activation, setActivation] = useState<ActivationRecord[] | null>(null);
  const { device_code: deviceCode, customer_id: customerId } = conversation;

  useEffect(() => {
    let cancelled = false;
    setActivation(null);
    agentApi
      .listCandidateEvents()
      .then(({ items }) => {
        if (!cancelled) setFunnel(items.filter((e) => e.device_code === deviceCode && e.customer_id === String(customerId)));
      })
      .catch(() => !cancelled && setFunnel([]));
    agentApi
      .activationHistory(customerId)
      .then(({ records }) => !cancelled && setActivation(records))
      // 404 means this person has never been picked for a re-chat.
      .catch(() => !cancelled && setActivation([]));
    return () => {
      cancelled = true;
    };
  }, [deviceCode, customerId, reloadToken]);

  return { funnel, activation };
}

export function CandidateCard({ conversation, device }: { conversation: Conversation; device: DeviceView | undefined }) {
  const [reloadToken, setReloadToken] = useState(0);
  const { funnel, activation } = useCandidateHistory(conversation, reloadToken);
  const [marking, setMarking] = useState<FunnelEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = conversation.nickname || `候选人 ${conversation.customer_id}`;
  const place = [conversation.city, conversation.district].filter(Boolean).join(" · ");
  const latest = funnel[0];
  const latestLabel = FUNNEL.find((f) => f.value === latest?.event_type)?.label ?? "在聊";

  async function mark(eventType: FunnelEvent) {
    setMarking(eventType);
    setError(null);
    try {
      await agentApi.markFunnel(conversation, eventType);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "标记失败，请重试");
    } finally {
      setMarking(null);
    }
  }

  return (
    <aside className="rc-card" aria-label="候选人信息">
      <div className="rc-card-id">
        <Avatar name={name} size={44} />
        <div>
          <h2>{name}</h2>
          <p>{place || "城市未知"}</p>
        </div>
      </div>

      <dl className="rc-facts">
        <dt>所在微信号</dt>
        <dd>
          {device?.device.name || conversation.device_code}
          {device && <span className={`rc-device-state is-${device.state}`}> · {DEVICE_STATE_LABEL[device.state]}</span>}
        </dd>
        <dt>漏斗状态</dt>
        <dd>
          {latestLabel}
          {latest && <span className="rc-muted"> · {dateLabel(latest.created_at)}</span>}
        </dd>
      </dl>

      <div className="rc-card-section">
        <h3>手动标记</h3>
        <div className="rc-mark-row">
          {FUNNEL.map((f) => (
            <Button
              key={f.value}
              variant={latest?.event_type === f.value ? "tinted" : "secondary"}
              size="sm"
              loading={marking === f.value}
              disabled={marking !== null}
              onClick={() => mark(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {error && <p className="rc-compose-error" role="alert">{error}</p>}
      </div>

      <div className="rc-card-section">
        <h3>复聊记录</h3>
        {activation === null ? (
          <p className="rc-muted">加载中…</p>
        ) : activation.length === 0 ? (
          <p className="rc-muted">还没被选进复聊名单</p>
        ) : (
          <ul className="rc-history">
            {activation.slice(0, 5).map((r) => (
              <li key={r.id}>
                <span>{dateLabel(r.created_at)}</span>
                <span>{r.strategy}</span>
                <span className="rc-muted">{r.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

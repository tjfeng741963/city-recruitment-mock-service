import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Skeleton } from "../../components/ui";
import { CandidateCard } from "./CandidateCard";
import { ChatPane } from "./ChatPane";
import { ConversationList } from "./ConversationList";
import { buildHook, tabTitle } from "./hook";
import { formatWait, minutesSince, triage, type TriagedConversation } from "./triage";
import { useReception, type DeviceView } from "./useReception";
import { useReentry } from "./useReentry";

const DEVICES_ROUTE = "/agent-devices";
const POSITIONS_ROUTE = "/service-positions";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function OfflineBanners({ devices, now }: { devices: DeviceView[]; now: number }) {
  const offline = devices.filter((d) => d.state === "offline");
  if (!offline.length) return null;
  return (
    <div className="rc-banners">
      {offline.map((d) => (
        <p key={d.device.device_code} className="rc-banner" role="alert">
          <span>
            {d.device.name || d.device.device_code} 掉线
            {d.heartbeatAt > 0 && ` ${formatWait(minutesSince(d.heartbeatAt, now))}`}
          </span>
          <a href={DEVICES_ROUTE}>去重新扫码 →</a>
        </p>
      ))}
    </div>
  );
}

function LinkButton({ href, primary, children }: { href: string; primary?: boolean; children: string }) {
  return (
    <a className={`ui-btn ${primary ? "ui-btn-primary" : "ui-btn-secondary"} ui-btn-md`} href={href}>
      <span className="ui-btn-label">{children}</span>
    </a>
  );
}

function ColdStart({ devices }: { devices: DeviceView[] }) {
  const online = devices.find((d) => d.state === "online");
  if (online) {
    return (
      <EmptyState
        icon="chat"
        title={`${online.device.name || online.device.device_code}在线，等第一个候选人。`}
        description="可以先去岗位页确认工价和放假安排。"
        action={<LinkButton href={POSITIONS_ROUTE}>去岗位页</LinkButton>}
      />
    );
  }
  return (
    <EmptyState
      icon="device"
      title="先接一个微信号"
      description="扫码登录后，候选人发来的消息会出现在这里。"
      action={<LinkButton href={DEVICES_ROUTE} primary>绑定微信号</LinkButton>}
    />
  );
}

function pickDefault(items: TriagedConversation[]): TriagedConversation | undefined {
  const byWait = items.filter((t) => t.group === "waiting").sort((a, b) => (b.waitingMinutes ?? 0) - (a.waitingMinutes ?? 0));
  const byRecent = items.filter((t) => t.group === "active").sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  return byWait[0] ?? byRecent[0] ?? items[0];
}

export function ReceptionPage() {
  const { data, error, refresh } = useReception();
  const now = useNow();
  const [deviceFilter, setDeviceFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const triaged = useMemo(() => (data ? triage(data.conversations, data.threads, now) : []), [data, now]);
  const failedDeliveries = useMemo(
    () => (data ? [...data.threads.values()].filter((t) => t.lastOutboundFailed).length : 0),
    [data],
  );
  const hook = useMemo(
    () => buildHook({ triaged, deviceStates: data?.devices.map((d) => d.state) ?? [], failedDeliveries, now }),
    [triaged, data, failedDeliveries, now],
  );
  const reentry = useReentry(data?.conversations ?? null);

  useEffect(() => {
    document.title = tabTitle(hook.waiting);
  }, [hook.waiting]);
  useEffect(() => () => void (document.title = tabTitle(0)), []);

  const visible = deviceFilter ? triaged.filter((t) => t.conversation.device_code === deviceFilter) : triaged;
  const selected = visible.find((t) => t.key === selectedKey) ?? pickDefault(visible);
  const selectedDevice = data?.devices.find((d) => d.device.device_code === selected?.conversation.device_code);

  if (!data) {
    return (
      <div className="rc-page">
        <header className="rc-top">
          {error ? <p className="rc-hook is-error" role="alert">{error}</p> : <Skeleton width="60%" height={22} />}
        </header>
      </div>
    );
  }

  return (
    <div className="rc-page" data-tone={hook.tone}>
      <header className="rc-top">
        <p className={`rc-hook ${hook.isAllClear ? "is-clear" : ""}`} aria-live="polite">{hook.text}</p>
        <OfflineBanners devices={data.devices} now={now} />
        {reentry && <p className="rc-reentry">{reentry}</p>}
        {error && <p className="rc-stale" role="status">{error}（显示的是上一次的数据）</p>}
      </header>

      {data.conversations.length === 0 ? (
        <div className="rc-cold">
          <ColdStart devices={data.devices} />
        </div>
      ) : (
        <div className="rc-panes">
          <div className="rc-pane-list">
            {data.devices.length > 1 && (
              <select className="rc-device-filter" aria-label="按微信号筛选" value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)}>
                <option value="">全部微信号</option>
                {data.devices.map((d) => (
                  <option key={d.device.device_code} value={d.device.device_code}>
                    {d.device.name || d.device.device_code}
                  </option>
                ))}
              </select>
            )}
            <ConversationList items={visible} selectedKey={selected?.key ?? null} onSelect={setSelectedKey} />
          </div>
          {selected ? (
            <>
              <ChatPane key={selected.key} conversation={selected.conversation} onChanged={refresh} />
              <CandidateCard key={`card-${selected.key}`} conversation={selected.conversation} device={selectedDevice} />
            </>
          ) : (
            <div className="rc-chat rc-chat-none">
              <p className="rc-muted">这个微信号下还没有会话</p>
              <Button variant="ghost" size="sm" onClick={() => setDeviceFilter("")}>看全部微信号</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

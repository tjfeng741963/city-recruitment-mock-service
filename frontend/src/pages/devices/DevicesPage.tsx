import { useCallback, useEffect, useMemo, useState } from "react";
import { agentApi, type Conversation } from "../../api/agent";
import { devicesApi, type BridgeCommand, type DeviceDetail } from "../../api/admin";
import { ApiError } from "../../api/client";
import { navigate } from "../../app/router";
import { Badge, Button, EmptyState, Skeleton } from "@ui";
import { useAuth } from "../../context/AuthContext";
import type { DeviceState } from "../reception/useReception";
import { formatWait, minutesSince } from "../reception/triage";
import { BindDialog, PairDialog } from "./DeviceDialogs";
import { DeviceDetailView } from "./DeviceDetail";
import { STATE_LABEL, STATE_TONE, receivedToday, sortByUrgency } from "./model";

export interface DeviceCard {
  device: DeviceDetail;
  name: string;
  state: DeviceState;
  heartbeatAt: number;
  accountId: string;
  today: number;
  workflow: boolean;
  commands: BridgeCommand[];
}

async function loadCard(device: DeviceDetail, now: number): Promise<DeviceCard> {
  const [bridge, convs, workflow] = await Promise.all([
    devicesApi.bridge(device.device_code).catch(() => ({ device: null, commands: [] })),
    agentApi.listConversations(device.device_code).catch(() => ({ items: [] as Conversation[] })),
    devicesApi.workflow(device.id).catch(() => ({ ok: false, message: "" })),
  ]);
  return {
    device,
    name: device.name || device.device_code,
    state: (bridge.device?.state as DeviceState | undefined) ?? "unpaired",
    heartbeatAt: bridge.device?.heartbeat_at ?? 0,
    accountId: bridge.device?.account_id ?? "",
    today: receivedToday(convs.items, now),
    workflow: workflow.ok,
    commands: bridge.commands,
  };
}

function useDeviceCards() {
  const [cards, setCards] = useState<DeviceCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const { items } = await devicesApi.list();
      const now = Date.now();
      setCards(await Promise.all(items.filter((d) => d.device_code).map((d) => loadCard(d, now))));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载失败");
    }
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { cards, error, refresh };
}

function stateLine(card: DeviceCard, now: number): string {
  if (card.state === "offline" && card.heartbeatAt > 0) return `掉线 ${formatWait(minutesSince(card.heartbeatAt, now))}`;
  return STATE_LABEL[card.state];
}

function Card({ card, now }: { card: DeviceCard; now: number }) {
  return (
    <a href={`/agent-devices/${card.device.id}`} className={`dv-card is-${card.state}`}>
      <div className="dv-card-top">
        <span className="dv-card-name">{card.name}</span>
        <Badge tone={STATE_TONE[card.state]} dot>{stateLine(card, now)}</Badge>
      </div>
      <dl className="dv-card-meta">
        <div><dt>今天接待</dt><dd className="ui-num">{card.today} 人</dd></div>
        <div><dt>工作流</dt><dd>{card.workflow ? "已挂" : <span className="dv-muted">未挂</span>}</dd></div>
      </dl>
      {card.state === "offline" && <span className="dv-card-cta">去重新扫码 →</span>}
    </a>
  );
}

export function DevicesPage({ deviceId }: { deviceId?: number }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { cards, error, refresh } = useDeviceCards();
  const [binding, setBinding] = useState(false);
  const [pairing, setPairing] = useState<DeviceDetail | null>(null);
  const now = Date.now();
  const sorted = useMemo(() => (cards ? sortByUrgency(cards) : []), [cards]);
  const pairDialog = pairing && <PairDialog device={pairing} onClose={() => { setPairing(null); refresh(); }} />;

  if (deviceId !== undefined) {
    const card = cards?.find((c) => c.device.id === deviceId);
    return (
      <>
        <DeviceDetailView card={card} loading={!cards} canPair={isAdmin} onPair={() => card && setPairing(card.device)} onRenamed={refresh} />
        {pairDialog}
      </>
    );
  }

  return (
    <div className="mod-page">
      <header className="mod-head">
        <h1>微信号</h1>
        {isAdmin && cards && cards.length > 0 && <Button size="sm" onClick={() => setBinding(true)}>绑定新号</Button>}
      </header>
      {error && <p className="mod-error" role="alert">{error}</p>}
      {!cards ? (
        <div className="dv-wall">{[0, 1, 2].map((i) => <Skeleton key={i} height={132} />)}</div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon="device"
          title="先接一个微信号"
          description={isAdmin ? "扫码登录后，候选人发来的消息会出现在接待台。" : "还没有分配给你的微信号，请联系管理员。"}
          action={isAdmin ? <Button onClick={() => setBinding(true)}>绑定微信号</Button> : undefined}
        />
      ) : (
        <div className="dv-wall">{sorted.map((c) => <Card key={c.device.id} card={c} now={now} />)}</div>
      )}
      {binding && (
        <BindDialog
          onClose={() => setBinding(false)}
          onCreated={(device) => {
            setBinding(false);
            refresh();
            navigate(`/agent-devices/${device.id}`);
            setPairing(device);
          }}
        />
      )}
      {pairDialog}
    </div>
  );
}

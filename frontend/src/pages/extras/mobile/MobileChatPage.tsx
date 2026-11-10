import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Button, Dialog, Icon, Input } from "@ui";
import { mobileApi, type MobileConversation, type MobileDevice } from "../../../api/extras";
import { navigate } from "../../../app/router";
import { useAuth } from "../../../context/AuthContext";
import { errorText } from "../model";
import { MobileChatDetail } from "./MobileChatDetail";
import { MobileConversationList } from "./MobileConversationList";
import { MobileFeatured } from "./MobileFeatured";
import { inRange, lastSevenDays, statusOf, STATUS_FILTERS, type StatusKey } from "./model";

const LIST_POLL_MS = 10_000;
const DEVICE_POLL_MS = 15_000;

function unreadOf(r: { items: MobileConversation[]; total_unread?: number }): number {
  return r.total_unread ?? r.items.reduce((sum, c) => sum + (c.unread || 0), 0);
}

function DeviceSheet({
  devices,
  current,
  unread,
  showFeatured,
  onPick,
  onFeatured,
  onClose,
}: {
  devices: MobileDevice[];
  current: MobileDevice | null;
  unread: Record<number, number>;
  showFeatured: boolean;
  onPick: (d: MobileDevice) => void;
  onFeatured: () => void;
  onClose: () => void;
}) {
  const { user, logout } = useAuth();
  return (
    <Dialog open variant="sheet" onClose={onClose} title={user?.username ?? "微信号"} description="选一个微信号查看它的对话">
      <ul className="mx-devices">
        {devices.map((d) => (
          <li key={d.id}>
            <button type="button" className={`mx-device ${d.id === current?.id ? "is-current" : ""}`} aria-current={d.id === current?.id || undefined} onClick={() => onPick(d)}>
              <span className={`mx-dot ${d.online ? "is-on" : ""}`} aria-hidden="true" />
              <span className="mx-device-name">{d.name || d.device_code}</span>
              {!d.online && <span className="ex-muted">掉线</span>}
              {unread[d.id] ? <span className="mx-unread ui-num">{unread[d.id] > 99 ? "99+" : unread[d.id]}</span> : null}
            </button>
          </li>
        ))}
        {devices.length === 0 && <li className="ex-muted">还没有分配给你的微信号</li>}
      </ul>
      <div className="mx-sheet-actions">
        {showFeatured && <Button variant="tinted" onClick={onFeatured}>主推设置</Button>}
        <Button variant="secondary" onClick={() => navigate("/conversations")}>打开电脑版后台</Button>
        <Button variant="ghost" onClick={logout}>退出登录</Button>
      </div>
    </Dialog>
  );
}

export function MobileChatPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<MobileDevice[] | null>(null);
  const [device, setDevice] = useState<MobileDevice | null>(null);
  const [conversations, setConversations] = useState<MobileConversation[] | null>(null);
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"" | StatusKey>("");
  const [range, setRange] = useState<[string, string]>(() => lastSevenDays());
  const [open, setOpen] = useState<MobileConversation | null>(null);
  const [sheet, setSheet] = useState(false);
  const [featured, setFeatured] = useState(false);
  const showFeatured = user?.role === "recruiter" && user.recruiter_type === "service";

  const loadDevices = useCallback(async () => {
    const { items } = await mobileApi.myDevices();
    setDevices(items);
    setDevice((cur) => (cur ? items.find((d) => d.id === cur.id) ?? cur : items[0] ?? null));
    return items;
  }, []);

  const [start, end] = range;
  const deviceId = device?.id;
  const deviceCode = device?.device_code;

  const countUnread = useCallback(async (list: MobileDevice[], skipId?: number) => {
    const counts = await Promise.all(
      list
        .filter((d) => d.id !== skipId)
        .map((d) => mobileApi.conversations(d.device_code, start, end).then((r) => [d.id, unreadOf(r)] as const).catch(() => null)),
    );
    setUnread((u) => ({ ...u, ...Object.fromEntries(counts.filter((c): c is readonly [number, number] => c !== null)) }));
  }, [start, end]);

  const loadConversations = useCallback(async () => {
    if (!deviceCode || deviceId === undefined) return;
    try {
      const r = await mobileApi.conversations(deviceCode, start, end);
      setConversations(r.items);
      setUnread((u) => ({ ...u, [deviceId]: unreadOf(r) }));
      setError(null);
    } catch (err) {
      setError(errorText(err, "会话加载失败"));
    }
  }, [deviceCode, deviceId, start, end]);

  useEffect(() => {
    loadDevices()
      .then((list) => countUnread(list))
      .catch((err) => {
        setDevices([]);
        setError(errorText(err, "微信号加载失败"));
      });
  }, [loadDevices, countUnread]);

  useEffect(() => {
    setConversations(null);
    loadConversations();
  }, [loadConversations]);

  // List refresh pauses while a chat is open; the chat polls its own thread.
  useEffect(() => {
    const listTimer = window.setInterval(() => {
      if (!document.hidden && !open) loadConversations();
    }, LIST_POLL_MS);
    const deviceTimer = window.setInterval(() => {
      if (document.hidden) return;
      loadDevices().then((list) => countUnread(list, deviceId)).catch(() => undefined);
    }, DEVICE_POLL_MS);
    return () => {
      window.clearInterval(listTimer);
      window.clearInterval(deviceTimer);
    };
  }, [open, deviceId, loadConversations, loadDevices, countUnread]);

  const visible = useMemo(
    () => (conversations ?? []).filter((c) => inRange(c, start, end)).filter((c) => !filter || statusOf(c) === filter),
    [conversations, start, end, filter],
  );

  function pickDevice(d: MobileDevice) {
    setDevice(d);
    setOpen(null);
    setSheet(false);
    setRange(lastSevenDays());
  }

  let screen;
  if (featured) {
    screen = <MobileFeatured onBack={() => setFeatured(false)} />;
  } else if (open && device) {
    screen = (
      <MobileChatDetail
        key={`${device.device_code}:${open.customer_id}`}
        device={device}
        conversation={open}
        onBack={() => {
          setOpen(null);
          loadConversations();
        }}
        onUpdated={loadConversations}
      />
    );
  } else {
    screen = (
      <section className="mx-list-screen" aria-label="会话列表">
        <header className="mx-bar">
          <button type="button" className="mx-icon-btn" aria-label="切换微信号" onClick={() => setSheet(true)}>
            <Icon name="sidebar" size={20} />
          </button>
          <div className="mx-bar-title">
            <span className="mx-bar-name">
              <span className={`mx-dot ${device?.online ? "is-on" : ""}`} aria-hidden="true" />
              {device ? device.name || device.device_code : "选择微信号"}
            </span>
            <span className="mx-bar-sub">{device?.online ? "在线" : device ? "掉线" : ""}</span>
          </div>
        </header>
        <div className="mx-range">
          <Input id="mx-start" type="date" aria-label="开始日期" value={range[0]} max={range[1]} onChange={(e) => setRange([e.target.value, range[1]])} />
          <span className="ex-muted">至</span>
          <Input id="mx-end" type="date" aria-label="结束日期" value={range[1]} min={range[0]} onChange={(e) => setRange([range[0], e.target.value])} />
        </div>
        <div className="mx-chips" role="group" aria-label="按状态筛选">
          {STATUS_FILTERS.map((s) => (
            <button key={s.value || "all"} type="button" className={`mx-chip ${filter === s.value ? "is-on" : ""}`} aria-pressed={filter === s.value} onClick={() => setFilter(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
        {error && <div className="mx-pad"><Alert tone="danger" title={error} action={<Button size="sm" variant="secondary" onClick={loadConversations}>重试</Button>} /></div>}
        <MobileConversationList
          loading={devices === null || (device !== null && conversations === null)}
          hasDevice={device !== null}
          filtered={Boolean(filter) || (conversations?.length ?? 0) > 0}
          items={visible}
          onOpen={setOpen}
        />
      </section>
    );
  }

  return createPortal(
    <div className="mx-root">
      <div className="mx-column">{screen}</div>
      {sheet && (
        <DeviceSheet
          devices={devices ?? []}
          current={device}
          unread={unread}
          showFeatured={showFeatured}
          onPick={pickDevice}
          onFeatured={() => {
            setSheet(false);
            setFeatured(true);
          }}
          onClose={() => setSheet(false)}
        />
      )}
    </div>,
    document.body,
  );
}

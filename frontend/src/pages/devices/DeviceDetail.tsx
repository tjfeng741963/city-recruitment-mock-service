import { useEffect, useState, type FormEvent } from "react";
import { devicesApi } from "../../api/admin";
import { ApiError } from "../../api/client";
import { Badge, Button, EmptyState, Input, ListGroup, ListRow, Skeleton } from "@ui";
import { formatWait, minutesSince } from "../reception/triage";
import type { DeviceCard } from "./DevicesPage";
import { LocationDialog } from "./DeviceDialogs";
import { STATE_LABEL, STATE_TONE, failedCommands } from "./model";

const LEGACY_ORIGIN = import.meta.env.VITE_LEGACY_ORIGIN ?? "http://127.0.0.1:8080";

// 二维码轮询间隔。客户端约 30 秒传一帧，5 秒拉一次既能及时看到新码，也不会打太多请求。
const QR_POLL_MS = 5000;
// 超过这个秒数就提示"这张图可能已经过期"——企微二维码约 2 分钟刷新一次。
const QR_STALE_SECONDS = 90;

/**
 * 企微登录二维码面板。
 *
 * 解决的场景：账号跑在云端的机器上（用户碰不到那块屏幕）。企微被风控登出后
 * 那台机器会弹出扫码窗，但没人看得见——客户端把窗口截下来传到这里，
 * 用户就可以在自己的浏览器上扫码，重新登录云端那台机器的微信。
 *
 * 只在设备非在线时轮询：在线说明已经登上了，没必要一直拉。
 */
function LoginQrPanel({ code, state }: { code: string; state: DeviceCard["state"] }) {
  const [qr, setQr] = useState<{ image: string; captured_at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (state === "online") {
      setQr(null);
      setLoading(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await devicesApi.loginQr(code);
        if (!alive) return;
        setQr(res.available && res.image ? { image: res.image, captured_at: res.captured_at ?? "" } : null);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof ApiError ? err.detail : "读取二维码失败");
      } finally {
        if (alive) {
          setLoading(false);
          setNow(Date.now());
          timer = setTimeout(poll, QR_POLL_MS);
        }
      }
    }

    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [code, state]);

  if (state === "online") return null;

  const ageSeconds = qr?.captured_at
    ? Math.max(0, Math.round((now - new Date(qr.captured_at).getTime()) / 1000))
    : 0;
  const stale = qr !== null && Number.isFinite(ageSeconds) && ageSeconds > QR_STALE_SECONDS;

  return (
    <section className="dv-qr" aria-live="polite">
      <h2 className="dv-qr-title">用手机扫码登录云端那台电脑的微信</h2>
      <p className="dv-qr-hint">
        这台设备不在线。如果那台电脑的企业微信退出了登录，屏幕上会弹出二维码——
        下面就是它，用要登录的那个微信扫一下就行，不用去现场。
      </p>

      {loading && !qr && <p className="dv-muted">正在等设备上传二维码…</p>}

      {!loading && !qr && !error && (
        <p className="dv-muted">
          还没收到二维码。可能是设备程序没在跑，或者企业微信还停在别的界面。
          设备一旦弹出扫码窗，这里会自动出现。
        </p>
      )}

      {error && <p className="dv-qr-error">{error}</p>}

      {qr && (
        <div className="dv-qr-box">
          <img className="dv-qr-img" src={qr.image} alt="企业微信登录二维码" width={228} height={312} />
          <p className="dv-muted dv-qr-meta">
            {stale
              ? `这张图是 ${ageSeconds} 秒前的，可能已经过期，正在等新的一帧…`
              : `二维码 ${ageSeconds} 秒前更新，扫不了会在这里自动换新`}
          </p>
        </div>
      )}
    </section>
  );
}

function RenameRow({ card, onRenamed }: { card: DeviceCard; onRenamed: () => void }) {
  const [name, setName] = useState(card.device.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dirty = name.trim() !== card.device.name && name.trim() !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setError(undefined);
    try {
      await devicesApi.rename(card.device.id, name.trim());
      onRenamed();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="dv-rename" onSubmit={submit}>
      <Input id="dv-rename" label="名称" value={name} onChange={(e) => setName(e.target.value)} error={error} />
      <Button type="submit" variant="secondary" size="sm" disabled={!dirty} loading={saving}>保存</Button>
    </form>
  );
}

function scanHint(state: DeviceCard["state"]): string {
  if (state === "unpaired") return "这个号还没连上。需要在装微信的电脑上运行设备程序，并填入连接口令。";
  if (state === "scanning") return "设备程序已启动，正在等扫码。请到那台电脑上用这个微信扫二维码。";
  return "这个号掉线了。到装微信的那台电脑上看设备程序是否还在运行；如果显示二维码，用这个微信重新扫码。";
}

export function DeviceDetailView({
  card,
  loading,
  canPair,
  onPair,
  onChanged,
}: {
  card: DeviceCard | undefined;
  loading: boolean;
  canPair: boolean;
  onPair: () => void;
  onChanged: () => void;
}) {
  const now = Date.now();
  const [locating, setLocating] = useState(false);
  if (loading) {
    return (
      <div className="mod-page">
        <Skeleton width="40%" height={28} />
      </div>
    );
  }
  if (!card) {
    return (
      <div className="mod-page">
        <EmptyState
          icon="device"
          title="找不到这个微信号"
          description="可能已被删除，或没有分配给你。"
          action={<a className="ui-btn ui-btn-secondary ui-btn-md" href="/agent-devices"><span className="ui-btn-label">回到微信号</span></a>}
        />
      </div>
    );
  }

  const failed = failedCommands(card.commands);
  const stateText = card.state === "offline" && card.heartbeatAt > 0 ? `掉线 ${formatWait(minutesSince(card.heartbeatAt, now))}` : STATE_LABEL[card.state];

  return (
    <div className="mod-page mod-narrow">
      <nav className="mod-crumb" aria-label="位置"><a href="/agent-devices">微信号</a> / {card.name}</nav>
      <header className="mod-head">
        <h1>{card.name}</h1>
        <Badge tone={STATE_TONE[card.state]} dot>{stateText}</Badge>
      </header>

      {card.state !== "online" && (
        <div className={`dv-scan is-${card.state}`}>
          <p>{scanHint(card.state)}</p>
          {canPair && card.state === "unpaired" && <Button size="sm" onClick={onPair}>生成连接口令</Button>}
        </div>
      )}

      {/* 云端机器掉登录时，二维码由客户端截屏传上来，用户在这里扫码即可 */}
      <LoginQrPanel code={card.device.device_code} state={card.state} />

      <ListGroup header="基本信息">
        <div className="ui-row"><RenameRow key={card.device.name} card={card} onRenamed={onChanged} /></div>
        <ListRow title="设备编号" detail={<code>{card.device.device_code}</code>} />
        <ListRow title="登录的微信" detail={card.accountId || <span className="dv-muted">还没登录过</span>} />
        <ListRow
          title="账号定位"
          subtitle="设备端按工厂/城市过滤知识库，留空 = 通用"
          detail={`所属工厂 ${card.device.factory_name || "通用"} · 服务城市 ${card.device.city || "通用"}`}
          trailing={<Button variant="ghost" size="sm" onClick={() => setLocating(true)}>编辑</Button>}
        />
        <ListRow title="今天接待" detail={`${card.today} 人`} />
      </ListGroup>

      <ListGroup header="工作流" footer="上传和替换工作流文件暂时在原页面操作。">
        <ListRow
          title={card.workflow ? "已挂工作流" : "还没挂工作流"}
          subtitle={card.workflow ? undefined : "没挂工作流时，AI 不会在这个号上回复"}
          trailing={
            <a className="ui-btn ui-btn-ghost ui-btn-sm" href={`${LEGACY_ORIGIN}/agent-devices`} target="_blank" rel="noopener noreferrer">
              <span className="ui-btn-label">去原页面</span>
            </a>
          }
        />
      </ListGroup>

      <ListGroup
        header="最近没发出去的消息"
        footer={failed.length ? "系统不会自动重发，避免候选人收到两遍。需要的话到接待台接管这个会话，手动再回一次。" : undefined}
      >
        {failed.length === 0 ? (
          <ListRow title="最近 50 条都发出去了" />
        ) : (
          failed.map((c) => (
            <ListRow
              key={c.id}
              icon="alert"
              iconTone={c.status === "failed" ? "danger" : "warning"}
              title={c.status === "failed" ? "发送失败" : "结果未知"}
              subtitle={new Date(c.created_at).toLocaleString("zh-CN")}
              detail={c.simulated ? "模拟发送" : undefined}
            />
          ))
        )}
      </ListGroup>

      {canPair && card.state !== "unpaired" && (
        <ListGroup header="连接口令" footer="重新生成会让设备立刻掉线，只在口令丢失或换电脑时使用。">
          <ListRow title="重新生成连接口令" trailing={<Button variant="ghost" size="sm" onClick={onPair}>重新生成</Button>} />
        </ListGroup>
      )}

      {locating && <LocationDialog device={card.device} onClose={() => setLocating(false)} onSaved={onChanged} />}
    </div>
  );
}

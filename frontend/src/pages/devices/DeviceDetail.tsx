import { useState, type FormEvent } from "react";
import { devicesApi } from "../../api/admin";
import { ApiError } from "../../api/client";
import { Badge, Button, EmptyState, Input, ListGroup, ListRow, Skeleton } from "@ui";
import { formatWait, minutesSince } from "../reception/triage";
import type { DeviceCard } from "./DevicesPage";
import { STATE_LABEL, STATE_TONE, failedCommands } from "./model";

const LEGACY_ORIGIN = import.meta.env.VITE_LEGACY_ORIGIN ?? "http://127.0.0.1:8080";

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
  onRenamed,
}: {
  card: DeviceCard | undefined;
  loading: boolean;
  canPair: boolean;
  onPair: () => void;
  onRenamed: () => void;
}) {
  const now = Date.now();
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

      <ListGroup header="基本信息">
        <div className="ui-row"><RenameRow key={card.device.name} card={card} onRenamed={onRenamed} /></div>
        <ListRow title="设备编号" detail={<code>{card.device.device_code}</code>} />
        <ListRow title="登录的微信" detail={card.accountId || <span className="dv-muted">还没登录过</span>} />
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
    </div>
  );
}

import { useEffect, type ReactNode } from "react";
import { Alert, BarChart, Button, EmptyState, Icon, Panel, Reveal, RevealItem, Skeleton, TrendChart } from "@ui";
import { statusApi, type StatusDashboard } from "../../api/candidates";
import { CountTile, LoadError, ModHead, useLoader } from "./shared";

const AUTO_REFRESH_MS = 180_000;
const QUEUE_WARN = 10;

const STATE_LABEL: Record<string, string> = {
  new: "新对话",
  active: "对话中",
  waiting: "等待回复",
  silent: "沉默",
  disqualified: "不符合",
  silent_invite: "已邀约",
  followup_invite: "已邀约（跟进）",
  pending_invite: "待邀约",
  ai_abnormal: "AI 异常",
  timeout_1: "超时 1 次",
  timeout_2: "超时 2 次",
  timeout_3: "超时 3 次",
};

function ChartOrEmpty({ empty, title, description, children }: { empty: boolean; title: string; description: string; children: ReactNode }) {
  return empty ? <EmptyState icon="chart" title={title} description={description} /> : <>{children}</>;
}

function RankList({ rows, empty }: { rows: Array<{ key: string; label: string; value: ReactNode; sub?: string; danger?: boolean }>; empty: string }) {
  if (rows.length === 0) return <p className="cd-muted cd-pad">{empty}</p>;
  return (
    <ol className="cd-rank">
      {rows.map((r, i) => (
        <li key={r.key} className="cd-rank-row">
          <span className="cd-rank-no ui-num">{i + 1}</span>
          <span className="cd-rank-name">
            {r.label}
            {r.sub && <small>{r.sub}</small>}
          </span>
          <span className={`cd-rank-value ui-num ${r.danger ? "is-danger" : ""}`}>{r.value}</span>
        </li>
      ))}
    </ol>
  );
}

function Tiles({ d }: { d: StatusDashboard | null }) {
  const pending = d?.queue.pending ?? 0;
  const failed = d?.errors.failed_today ?? 0;
  const abnormal = d?.errors.ai_abnormal ?? 0;
  return (
    <Reveal className="cd-stats cd-stats-5">
      <RevealItem><CountTile icon="device" label="微信号总数" value={d ? d.devices.total : null} unit="个" note={d ? `今日活跃 ${d.devices.active_today}` : undefined} /></RevealItem>
      <RevealItem><CountTile icon="chat" label="今日消息" value={d ? d.messages.total : null} unit="条" /></RevealItem>
      <RevealItem><CountTile icon="clock" label="排队待处理" value={d ? pending : null} unit="条" note={pending > QUEUE_WARN ? "堆积" : pending > 0 ? "待处理" : undefined} noteTone={pending > QUEUE_WARN ? "danger" : "warning"} /></RevealItem>
      <RevealItem><CountTile icon="alert" label="AI 回复失败" value={d ? failed : null} unit="次" note={failed > 0 ? "需关注" : undefined} noteTone="danger" /></RevealItem>
      <RevealItem><CountTile icon="robot" label="AI 异常" value={d ? abnormal : null} unit="次" note={abnormal > 0 ? "需关注" : undefined} noteTone="danger" /></RevealItem>
    </Reveal>
  );
}

function Charts({ d }: { d: StatusDashboard }) {
  const daily = d.daily_trend.map((p) => ({ label: `${p.date.slice(8)}日`, value: p.total }));
  const invited = d.daily_trend.map((p) => ({ label: `${p.date.slice(8)}日`, value: p.invited }));
  const hourly = d.messages.hourly.map((h) => ({ label: String(h.hour), value: h.count }));
  const states = Object.entries(d.state_distribution).map(([k, v]) => ({ label: STATE_LABEL[k] ?? k, value: v }));
  const lastRate = d.daily_trend.length ? d.daily_trend[d.daily_trend.length - 1].rate : null;
  const noDaily = d.daily_trend.length === 0;

  return (
    <>
      <div className="cd-grid-2">
        <Panel title="本月每日接待人数">
          <ChartOrEmpty empty={noDaily} title="本月还没有接待记录" description="有求职者来聊天后，这里按天显示人数。">
            <TrendChart points={daily} label="本月每日接待人数" />
          </ChartOrEmpty>
        </Panel>
        <Panel title="本月每日邀约数" actions={lastRate !== null ? <span className="cd-muted">最近一天邀约率 <span className="ui-num">{lastRate}%</span></span> : undefined}>
          <ChartOrEmpty empty={noDaily} title="本月还没有邀约" description="AI 邀约成功后，这里按天显示邀约数。">
            <BarChart data={invited} label="本月每日邀约数" />
          </ChartOrEmpty>
        </Panel>
      </div>
      <div className="cd-grid-2-1">
        <Panel title="今日每小时消息" actions={<span className="cd-muted">共 <span className="ui-num">{d.messages.total}</span> 条</span>}>
          <ChartOrEmpty empty={hourly.every((h) => h.value === 0)} title="今天还没有消息" description="收到消息后，这里按小时显示数量。">
            <BarChart data={hourly} label="今日每小时消息数" />
          </ChartOrEmpty>
        </Panel>
        <Panel title="对话状态分布">
          <ChartOrEmpty empty={states.every((s) => s.value === 0)} title="暂时没有进行中的对话" description="对话开始后，这里显示各状态的数量。">
            <BarChart data={states} label="对话状态分布" />
          </ChartOrEmpty>
        </Panel>
      </div>
      {d.degraded.length > 0 && (
        <Alert tone="warning" title="这些微信号的 AI 回复失败较多">
          {d.degraded.map((x) => `${x.device_code}（失败率 ${x.fail_rate}%）`).join("、")}
        </Alert>
      )}
      <div className="cd-grid-2">
        <Panel title="今日 AI 回复失败最多">
          <RankList
            empty="今天没有失败，AI 回复正常。"
            rows={d.dify_health.map((x) => ({ key: x.device_code, label: x.device_code, sub: x.last_fail ? `最后一次 ${x.last_fail}` : undefined, value: `${x.fail_count} 次`, danger: x.fail_count > 5 }))}
          />
        </Panel>
        <Panel title="今日消息最多的微信号">
          <RankList empty="今天还没有消息。" rows={d.device_ranking.map((x) => ({ key: x.device_code, label: x.device_code, value: `${x.count} 条` }))} />
        </Panel>
      </div>
    </>
  );
}

export function StatusDashboardPage() {
  const { data, error, loading, reload } = useLoader(() => statusApi.dashboard(), []);

  useEffect(() => {
    const t = window.setInterval(reload, AUTO_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  return (
    <div className="mod-page">
      <ModHead
        title="状态看板"
        active="/status-dashboard"
        actions={<Button size="sm" variant="secondary" loading={loading && Boolean(data)} icon={<Icon name="refresh" size={14} />} onClick={reload}>刷新</Button>}
      />
      <p className="cd-lead">AI 接待的运行情况总览，每 3 分钟自动刷新。</p>
      {error && <LoadError message={error} onRetry={reload} />}
      <Tiles d={data} />
      {data ? <Charts d={data} /> : !error && <div className="cd-grid-2"><Skeleton height={180} /><Skeleton height={180} /></div>}
    </div>
  );
}

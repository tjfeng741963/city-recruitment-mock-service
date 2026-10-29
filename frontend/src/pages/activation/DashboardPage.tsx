import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  BarChart,
  Button,
  CountUp,
  EmptyState,
  Icon,
  Panel,
  ProgressBar,
  Reveal,
  RevealItem,
  SegmentedControl,
  Skeleton,
  StatTile,
  TrendChart,
  useFeedback,
  type IconName,
} from "@ui";
import { activationApi, type DashboardStats, type FeedItem, type PopulationSlice, type StrategyEffect, type TrendPoint } from "../../api/activation";
import { ActivationHead, LoadError, PausedBanner, errText, strategyLabel } from "./shared";

const FEED_REFRESH_MS = 30_000;
const FEED_TEXT: Record<string, string> = {
  sent: "激活消息已发送",
  replied: "回复了激活消息，已转入 AI 接管",
  failed: "发送失败",
  frozen: "进入冷冻池",
};
const FEED_ICON: Record<string, IconName> = { sent: "chat", replied: "check", failed: "alert", frozen: "pause" };

const formatPercent = (n: number) => `${n.toFixed(1)}`;

function Kpi({ icon, label, value, unit, format }: { icon: IconName; label: string; value: number; unit?: string; format?: (n: number) => string }) {
  return (
    <StatTile icon={icon} label={label} value={<CountUp value={value} format={format} />} unit={unit} />
  );
}

function rateNumber(rate: DashboardStats["reply_rate"]): number {
  const n = typeof rate === "number" ? rate : parseFloat(String(rate));
  return Number.isFinite(n) ? n : 0;
}

function KpiRow({ stats }: { stats: DashboardStats | null }) {
  if (!stats) {
    return <div className="ac-kpis">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={104} />)}</div>;
  }
  return (
    <Reveal className="ac-kpis">
      <RevealItem><Kpi icon="clock" label="今日待激活" value={stats.today_pending} /></RevealItem>
      <RevealItem><Kpi icon="chat" label="今日已发送" value={stats.today_sent} /></RevealItem>
      <RevealItem><Kpi icon="check" label="今日已回复" value={stats.today_replied} /></RevealItem>
      <RevealItem><Kpi icon="chart" label="回复率" value={rateNumber(stats.reply_rate)} unit="%" format={formatPercent} /></RevealItem>
      <RevealItem><Kpi icon="pause" label="冷冻池总量" value={stats.frozen_total} /></RevealItem>
    </Reveal>
  );
}

function TrendPanel({ points }: { points: TrendPoint[] | null }) {
  const [series, setSeries] = useState<"sent" | "replied">("sent");
  return (
    <Panel
      title={`近 ${points?.length || 14} 天发送与回复`}
      actions={
        <SegmentedControl
          size="sm"
          label="趋势指标"
          value={series}
          onChange={(v) => setSeries(v as "sent" | "replied")}
          options={[{ value: "sent", label: "发送量" }, { value: "replied", label: "回复量" }]}
        />
      }
    >
      {!points ? (
        <Skeleton height={160} />
      ) : (
        <div className="ac-stack-sm">
          {points.every((p) => p[series] === 0) && <p className="ac-muted">这段时间还没有{series === "sent" ? "发送" : "回复"}记录。</p>}
          <TrendChart
            key={series}
            label={series === "sent" ? "每日发送量" : "每日回复量"}
            points={points.map((p) => ({ label: p.date.slice(5), value: p[series] }))}
          />
        </div>
      )}
    </Panel>
  );
}

function PopulationPanel({ slices }: { slices: PopulationSlice[] | null }) {
  // Same filter as the old page: only non-empty groups, B/C/D strategies hidden.
  const shown = (slices ?? []).filter((s) => s.value > 0 && !["B策略", "C策略", "D策略"].some((p) => s.name.startsWith(p)));
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  return (
    <Panel title="沉淀人群构成">
      {!slices ? (
        <Skeleton height={120} />
      ) : shown.length === 0 ? (
        <EmptyState icon="users" title="还没有沉淀客户" description="调度跑过之后，进入激活名单的客户会按来源显示在这里。" />
      ) : (
        <div className="ac-stack">
          {shown.map((s) => (
            <div key={s.name} className="ac-pop-row">
              <ProgressBar label={`${s.name}（${s.value} 人）`} value={Math.round((s.value / total) * 100)} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
function EffectPanel({ effects }: { effects: StrategyEffect[] | null }) {
  // The old page only compared the A strategy.
  const row = (effects ?? []).find((e) => e.code === "no_reply");
  const good = row ? Number(row.good) || 0 : 0;
  return (
    <Panel title="策略效果对比（近 30 天）">
      {!effects ? (
        <Skeleton height={160} />
      ) : !row ? (
        <EmptyState icon="chart" title="暂无策略效果数据" description="A 策略有发送记录后，这里会显示发送量和回复量。" />
      ) : (
        <div className="ac-stack">
          <p className="ac-muted">{strategyLabel(row.code)} · 回复率 <span className="ui-num">{typeof row.rate === "number" ? `${row.rate}%` : row.rate}</span></p>
          <BarChart
            label={`${strategyLabel(row.code)} 效果`}
            data={[
              { label: "发送量", value: row.sent },
              { label: "回复量", value: row.replied },
              { label: "招聘员好评", value: good },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

function FeedPanel({ items, error }: { items: FeedItem[] | null; error: string | null }) {
  return (
    <Panel title="实时动态" actions={<span className="ac-muted">每 30 秒刷新</span>}>
      {error && <Alert tone="danger" title={error} />}
      {!items ? (
        <div className="ac-stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={36} />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon="bell" title="暂无动态" description="激活消息发出、客户回复或进入冷冻池时，会实时出现在这里。" />
      ) : (
        <Reveal as="ul" className="ac-feed">
          {items.map((item) => (
            <RevealItem as="li" key={item.id} className={`ac-feed-item is-${item.type}`}>
              <span className="ac-feed-icon"><Icon name={FEED_ICON[item.type] ?? "info"} size={16} /></span>
              <div className="ac-feed-body">
                <div><strong>{item.nickname}</strong> {FEED_TEXT[item.type] ?? item.type}</div>
                <div className="ac-muted ui-num">{item.time} · {item.recruiter_id || "—"}</div>
              </div>
            </RevealItem>
          ))}
        </Reveal>
      )}
    </Panel>
  );
}

function useFeed() {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await activationApi.feed()).items ?? []);
      setError(null);
    } catch (err) {
      setError(errText(err, "动态加载失败"));
      setItems((prev) => prev ?? []);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, FEED_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  return { items, error };
}

export function DashboardPage() {
  const { toast, confirm } = useFeedback();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [population, setPopulation] = useState<PopulationSlice[] | null>(null);
  const [effects, setEffects] = useState<StrategyEffect[] | null>(null);
  const [toggling, setToggling] = useState(false);
  const feed = useFeed();

  const loadStats = useCallback(async () => {
    setStatsError(null);
    try {
      setStats(await activationApi.stats());
    } catch (err) {
      setStatsError(errText(err, "看板数据加载失败"));
    }
  }, []);

  useEffect(() => {
    loadStats();
    activationApi.trend().then((r) => setTrend(r.items ?? [])).catch(() => setTrend([]));
    activationApi.population().then((r) => setPopulation(r ?? [])).catch(() => setPopulation([]));
    activationApi.strategyEffect().then((r) => setEffects(r ?? [])).catch(() => setEffects([]));
  }, [loadStats]);

  const paused = Boolean(stats?.paused);

  async function togglePause() {
    const next = !paused;
    const ok = await confirm(
      next
        ? { title: "全局暂停复聊？", description: "暂停后所有设备立即停止发送激活消息，已发送消息的回复不受影响。", confirmLabel: "暂停", danger: true }
        : { title: "恢复复聊？", description: "恢复后所有已开启复聊的设备将按策略继续发送激活消息。", confirmLabel: "恢复" },
    );
    if (!ok) return;
    setToggling(true);
    try {
      const config = await activationApi.setPaused(next);
      setStats((s) => (s ? { ...s, paused: config.paused } : s));
      toast(config.paused ? "已全局暂停复聊" : "已恢复复聊");
    } catch (err) {
      toast(errText(err, "操作失败"), "danger");
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="mod-page">
      <ActivationHead
        title="复聊"
        current="/activation"
        actions={
          stats && (
            <Button size="sm" variant={paused ? "primary" : "destructive"} loading={toggling} icon={<Icon name={paused ? "play" : "pause"} size={14} />} onClick={togglePause}>
              {paused ? "恢复复聊" : "全局暂停复聊"}
            </Button>
          )
        }
      />
      {paused && <PausedBanner text="所有设备的激活消息发送已停止（已发送消息的回复仍正常接管）。需要时点右上角恢复。" />}
      {statsError ? <LoadError message={statsError} onRetry={loadStats} /> : <KpiRow stats={stats} />}
      <div className="ac-grid">
        <TrendPanel points={trend} />
        <PopulationPanel slices={population} />
      </div>
      <div className="ac-grid">
        <EffectPanel effects={effects} />
        <FeedPanel items={feed.items} error={feed.error} />
      </div>
    </div>
  );
}

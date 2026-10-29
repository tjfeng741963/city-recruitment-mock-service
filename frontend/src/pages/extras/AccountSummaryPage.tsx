import { useCallback, useEffect, useState } from "react";
import { Alert, BarChart, Button, CountUp, DataTable, EmptyState, Input, Panel, Reveal, RevealItem, SegmentedControl, Skeleton, StatTile, TrendChart, type Column, type IconName } from "@ui";
import { summaryApi, type AccountSummary, type SummaryAccount, type SummaryTotal } from "../../api/extras";
import { SettingsHead } from "./Heads";
import { errorText, localDate } from "./model";

// The old page was hard-wired to this account prefix (郎职师).
const PREFIX = "langzhishi";

type Preset = "today" | "week" | "month" | "custom";
type Metric = "new_total" | "invited" | "rate";

function presetRange(preset: Exclude<Preset, "custom">, now = new Date()): [string, string] {
  const today = localDate(now);
  if (preset === "today") return [today, today];
  if (preset === "week") {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return [localDate(monday), today];
  }
  return [localDate(new Date(now.getFullYear(), now.getMonth(), 1)), today];
}

const TILES: Array<{ key: keyof SummaryTotal; label: string; icon: IconName; unit?: string }> = [
  { key: "device_count", label: "设备数", icon: "device" },
  { key: "new_conversations", label: "新增求职者", icon: "users" },
  { key: "invited", label: "已邀约", icon: "check" },
  { key: "pending_invite", label: "待邀约", icon: "clock" },
  { key: "disqualified", label: "不符合", icon: "x" },
  { key: "checked_in", label: "已签到", icon: "pin" },
  { key: "invite_rate", label: "邀约率", icon: "chart", unit: "%" },
];

const formatRate = (n: number) => n.toFixed(1);

function CountTile({ icon, label, value, unit }: { icon: IconName; label: string; value: number; unit?: string }) {
  return <StatTile icon={icon} label={label} value={<CountUp value={value} format={unit === "%" ? formatRate : undefined} />} unit={unit} />;
}

type AccountRow = SummaryAccount & { id: string; rate: string };

const ACCOUNT_COLUMNS: Column<AccountRow>[] = [
  { key: "recruiter_id", header: "账号", sortable: true },
  { key: "name", header: "名称" },
  { key: "device_count", header: "设备数", align: "right", sortable: true },
  { key: "new_total", header: "新增", align: "right", sortable: true },
  { key: "invited", header: "邀约", align: "right", sortable: true },
  { key: "pending_invite", header: "待邀约", align: "right" },
  { key: "disqualified", header: "不符合", align: "right" },
  { key: "checked_in", header: "签到", align: "right" },
  { key: "rate", header: "邀约率", align: "right", render: (r) => r.rate || <span className="ex-muted">—</span> },
];

function TrendPanel({ data }: { data: AccountSummary }) {
  const [metric, setMetric] = useState<Metric>("new_total");
  const days = data.daily_trend ?? [];
  if (!days.length) return null;
  const points = days.map((d) => ({ label: d.date.slice(5), value: Number(d[metric] ?? 0) }));
  return (
    <Panel
      title="每日趋势"
      actions={
        <SegmentedControl
          size="sm"
          label="趋势指标"
          value={metric}
          onChange={(v) => setMetric(v as Metric)}
          options={[{ value: "new_total", label: "新增求职者" }, { value: "invited", label: "已邀约" }, { value: "rate", label: "邀约率" }]}
        />
      }
    >
      {metric === "rate" ? (
        <TrendChart points={points} label="每日邀约率（%）" />
      ) : (
        <BarChart data={points} label={metric === "invited" ? "每日已邀约人数" : "每日新增求职者"} />
      )}
    </Panel>
  );
}

export function AccountSummaryPage() {
  const [preset, setPreset] = useState<Preset>("month");
  const [range, setRange] = useState<[string, string]>(() => presetRange("month"));
  const [data, setData] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await summaryApi.get(PREFIX, start, end));
    } catch (err) {
      setError(errorText(err, "汇总数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(...presetRange("month"));
  }, [load]);

  function choosePreset(next: Preset) {
    setPreset(next);
    if (next === "custom") return;
    const r = presetRange(next);
    setRange(r);
    load(...r);
  }

  const rangeError = range[0] && range[1] && range[0] > range[1] ? "开始日期不能晚于结束日期" : undefined;
  const accounts: AccountRow[] = (data?.accounts ?? []).map((a) => ({
    ...a,
    id: a.recruiter_id,
    rate: a.new_total ? `${((a.invited / a.new_total) * 100).toFixed(1)}%` : "",
  }));
  const total = data?.total;

  return (
    <div className="mod-page">
      <SettingsHead />
      <div className="ex-toolbar">
        <div className="ex-toolbar-text">
          <h2>郎职师 · 运营汇总</h2>
          <p>按账号统计新增求职者、邀约和签到人数。</p>
        </div>
      </div>

      <div className="ex-range" role="search">
        <SegmentedControl
          size="sm"
          label="时间范围"
          value={preset}
          onChange={(v) => choosePreset(v as Preset)}
          options={[{ value: "today", label: "今天" }, { value: "week", label: "本周" }, { value: "month", label: "本月" }, { value: "custom", label: "自选" }]}
        />
        <Input id="as-start" type="date" aria-label="开始日期" value={range[0]} max={range[1] || undefined} onChange={(e) => { setPreset("custom"); setRange([e.target.value, range[1]]); }} />
        <span className="ex-muted">至</span>
        <Input id="as-end" type="date" aria-label="结束日期" value={range[1]} min={range[0] || undefined} error={rangeError} onChange={(e) => { setPreset("custom"); setRange([range[0], e.target.value]); }} />
        <Button size="sm" loading={loading} disabled={Boolean(rangeError) || !range[0] || !range[1]} onClick={() => load(...range)}>查询</Button>
      </div>

      {error && <Alert tone="danger" title={error} action={<Button size="sm" variant="secondary" onClick={() => load(...range)}>重试</Button>} />}

      {!data && loading && (
        <div className="ex-tiles" aria-hidden="true">
          {TILES.map((t) => <Skeleton key={t.key} height={104} />)}
        </div>
      )}

      {data && total && (
        <Reveal className="ex-tiles">
          {TILES.map((t) => (
            <RevealItem key={t.key}>
              <CountTile icon={t.icon} label={t.label} value={Number(total[t.key] ?? 0)} unit={t.unit} />
            </RevealItem>
          ))}
        </Reveal>
      )}

      {data && <TrendPanel key={`${data.date_range.start}-${data.date_range.end}`} data={data} />}

      {data && (
        accounts.length ? (
          <Panel title="账号明细" flush>
            <DataTable caption="账号明细" columns={ACCOUNT_COLUMNS} rows={accounts} loading={loading} />
          </Panel>
        ) : (
          !loading && <EmptyState icon="chart" title="这段时间没有账号数据" description="换一个时间范围试试；账号有新增求职者后，这里会按账号列出明细。" />
        )
      )}
    </div>
  );
}

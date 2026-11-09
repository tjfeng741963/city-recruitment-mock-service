import { Badge, BarChart, Button, DataTable, DescriptionList, EmptyState, Icon, Panel, Reveal, RevealItem, TrendChart, type Column } from "@ui";
import type { DailyMetric, EvaluationDetail, EvaluationDevice } from "../../api/candidates";
import { CountTile, downloadCsv } from "./shared";
import { DIMENSIONS, DIMENSION_LABEL, RAW_METRICS, dayTotal, levelTone } from "./evaluationModel";

export function ScoreTiles({ detail }: { detail: EvaluationDetail }) {
  const s = detail.dimension_scores ?? {};
  const level = detail.level || "N";
  return (
    <Reveal className="cd-stats cd-stats-5">
      <RevealItem>
        <CountTile icon="chart" label="综合评分" value={detail.weighted_score ?? null} unit="分" note={`等级 ${level}`} noteTone={levelTone(level)} />
      </RevealItem>
      {DIMENSIONS.map((d) => (
        <RevealItem key={d.key}>
          <CountTile icon={d.icon} label={d.label} value={s[d.key] ?? null} unit="分" />
        </RevealItem>
      ))}
    </Reveal>
  );
}

export function RawMetrics({ detail }: { detail: EvaluationDetail }) {
  const raw = detail.raw_metrics ?? {};
  return (
    <Panel title={detail.eval_date ? `原始指标（${detail.eval_date}）` : "今日原始指标"}>
      <DescriptionList columns={3} items={RAW_METRICS.map(([k, label]) => [label, <span key={k} className="ui-num">{raw[k] ?? 0}</span>])} />
    </Panel>
  );
}

export function ScoreCharts({ device, detail, days }: { device: EvaluationDevice | undefined; detail: EvaluationDetail | null; days: number }) {
  const trend = (device?.trend ?? []).filter((p) => p.score != null).map((p) => ({ label: p.date.slice(5), value: p.score as number }));
  const s = detail?.dimension_scores;
  const dims = s ? DIMENSIONS.map((d) => ({ label: d.label, value: s[d.key] ?? 0 })) : [];
  return (
    <div className="cd-grid-2">
      <Panel title={`评分趋势（近 ${days} 天）`} actions={trend.length === 1 ? <Badge tone="warning">只有 1 天数据</Badge> : undefined}>
        {trend.length ? (
          <TrendChart points={trend} label="每日综合评分" />
        ) : (
          <EmptyState icon="chart" title="这段时间没有评分" description="运行评审后，每天的综合评分会画在这里。" />
        )}
      </Panel>
      <Panel title="四个维度对比">
        {dims.length ? (
          <BarChart data={dims} label="四个维度评分" format={(n) => `${n}`} />
        ) : (
          <EmptyState icon="chart" title="还没有维度评分" description="运行评审后显示邀约转化、AI 独立性、对话深度、稳定性四项得分。" />
        )}
      </Panel>
    </div>
  );
}

export function Suggestions({ detail }: { detail: EvaluationDetail }) {
  const list = (detail.suggestions ?? []).filter((x) => x.dimension !== "quality");
  return (
    <Panel title="改进建议">
      {list.length === 0 ? (
        <EmptyState icon="info" title="暂时没有改进建议" description="评审发现问题时，会在这里给出具体建议。" />
      ) : (
        <ul className="cd-suggest">
          {list.map((x, i) => (
            <li key={`${x.dimension}-${i}`}>
              <Badge tone={x.priority === "high" ? "danger" : "warning"}>{DIMENSION_LABEL[x.dimension] ?? x.dimension}</Badge>
              <span>{x.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

type MetricRow = DailyMetric & { id: string; total: number };

const METRIC_COLUMNS: Column<MetricRow>[] = [
  { key: "date", header: "日期", sortable: true, render: (r) => <span className="ui-num">{r.date}</span> },
  { key: "new_total", header: "新增求职者", align: "right", sortable: true },
  { key: "invited", header: "邀约成功", align: "right", sortable: true },
  { key: "pending_invite", header: "待邀约", align: "right", sortable: true },
  { key: "disqualified", header: "不符合", align: "right", sortable: true },
  { key: "checked_in", header: "已签到", align: "right", sortable: true },
  { key: "total", header: "当日合计", align: "right", sortable: true },
];

export function DailyMetrics({ items, loading, fileTag }: { items: DailyMetric[]; loading: boolean; fileTag: string }) {
  const rows: MetricRow[] = items.map((m) => ({ ...m, id: m.date, total: dayTotal(m) }));
  function exportCsv() {
    downloadCsv(`运营指标_${fileTag}.csv`, [
      ["日期", "新增求职者", "邀约成功", "待邀约", "不符合", "已签到", "当日合计"],
      ...rows.map((r) => [r.date, r.new_total, r.invited, r.pending_invite, r.disqualified, r.checked_in, r.total]),
    ]);
  }
  return (
    <Panel
      title="运营指标"
      flush
      actions={<Button size="sm" variant="secondary" icon={<Icon name="download" size={14} />} disabled={rows.length === 0} onClick={exportCsv}>导出</Button>}
    >
      {!loading && rows.length === 0 ? (
        <EmptyState icon="chart" title="这段时间没有运营数据" description="换一个日期范围，或等有求职者进来后再看。" />
      ) : (
        <DataTable<MetricRow> caption="每日运营指标" columns={METRIC_COLUMNS} rows={rows} loading={loading} />
      )}
      <p className="cd-note">新增求职者＝当天新加的求职者；邀约成功、待邀约、不符合、已签到＝当天实际发生的数量（老客户跨天转化算在发生那天）；当日合计＝这四项之和。</p>
    </Panel>
  );
}

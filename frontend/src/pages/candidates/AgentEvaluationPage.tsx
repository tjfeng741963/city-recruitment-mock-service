import { useEffect, useState } from "react";
import { Button, EmptyState, FilterBar, Icon, Input, SegmentedControl, Select, Skeleton, useFeedback } from "@ui";
import { evaluationApi, type EvaluationDetail } from "../../api/candidates";
import { useAuth } from "../../context/AuthContext";
import { LoadError, ModHead, errorText, useLoader } from "./shared";
import { DailyMetrics, RawMetrics, ScoreCharts, ScoreTiles, Suggestions } from "./EvaluationSections";
import { defaultDevice, hasScores, presetRange, rangeDays, type Preset, type Range } from "./evaluationModel";

/** Old page fallback: when today has no review yet, show the latest scored day from the trend. */
async function loadDetail(device: string, lastScoredDate: string | undefined): Promise<EvaluationDetail | null> {
  if (!device) return null;
  const today = await evaluationApi.detail(device);
  if (hasScores(today) || !lastScoredDate) return today;
  const latest = await evaluationApi.detail(device, lastScoredDate);
  return hasScores(latest) ? latest : today;
}

export function AgentEvaluationPage() {
  const { toast } = useFeedback();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [range, setRange] = useState<Range>(() => presetRange("week"));
  const [device, setDevice] = useState("");
  const [version, setVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const days = rangeDays(range);

  const overview = useLoader(() => evaluationApi.overview(days), [days, version]);
  const devices = overview.data?.items ?? [];
  const current = devices.find((d) => d.device_code === device);
  const lastScored = [...(current?.trend ?? [])].reverse().find((p) => p.score != null)?.date;

  useEffect(() => {
    if (!overview.data) return;
    if (!device || !overview.data.items.some((d) => d.device_code === device)) setDevice(defaultDevice(overview.data.items));
  }, [overview.data, device]);

  const detail = useLoader(() => loadDetail(device, lastScored), [device, lastScored, version]);
  const metrics = useLoader(
    () => evaluationApi.metrics({ device_code: device, start_date: range.start, end_date: range.end }),
    [device, range.start, range.end, version],
  );

  async function runReview() {
    setRunning(true);
    try {
      const r = await evaluationApi.run(device);
      toast(`评审完成：${r.count ?? r.total ?? 1} 个微信号`);
      setVersion((v) => v + 1);
    } catch (err) {
      toast(errorText(err, "评审没能完成，请稍后再试"), "danger");
    } finally {
      setRunning(false);
    }
  }

  function setPreset(p: string) {
    if (p !== "custom") setRange(presetRange(p as Exclude<Preset, "custom">));
    else setRange((r) => ({ ...r, preset: "custom" }));
  }

  function setDate(which: "start" | "end", value: string) {
    if (!value) return;
    setRange((r) => {
      const next = { ...r, [which]: value, preset: "custom" as Preset };
      return next.start <= next.end ? next : { ...next, start: next.end, end: next.start };
    });
  }

  const runButton = isAdmin && (
    <Button size="sm" loading={running} icon={<Icon name="play" size={14} />} onClick={runReview}>运行评审</Button>
  );
  const scored = hasScores(detail.data) ? detail.data : null;
  const fileTag = `${device || "全部"}_${range.start}_${range.end}`;

  return (
    <div className="mod-page">
      <ModHead title="AI 评估" active="/agent-evaluations" actions={runButton || undefined} />
      <p className="cd-lead">按多个维度给每个微信号的 AI 打分，看对话质量和招聘效果。</p>

      <FilterBar>
        <Select
          id="ev-device"
          label="微信号"
          value={device}
          disabled={devices.length === 0}
          onChange={(e) => setDevice(e.target.value)}
          options={devices.length ? devices.map((d) => ({ value: d.device_code, label: d.device_name || d.device_code })) : [{ value: "", label: "全部微信号" }]}
        />
        <div className="cd-range">
          <span className="ui-field-label">日期范围</span>
          <SegmentedControl
            label="日期范围"
            value={range.preset}
            onChange={setPreset}
            options={[{ value: "today", label: "今天" }, { value: "week", label: "最近 7 天" }, { value: "month", label: "最近 30 天" }, { value: "custom", label: "自定义" }]}
          />
        </div>
        <Input id="ev-start" type="date" label="开始" value={range.start} max={range.end} onChange={(e) => setDate("start", e.target.value)} />
        <Input id="ev-end" type="date" label="结束" value={range.end} min={range.start} onChange={(e) => setDate("end", e.target.value)} />
        <Button variant="secondary" icon={<Icon name="refresh" size={14} />} loading={overview.loading && Boolean(overview.data)} onClick={() => setVersion((v) => v + 1)}>刷新</Button>
      </FilterBar>

      {overview.error && <LoadError message={overview.error} onRetry={overview.reload} />}
      {metrics.error && <LoadError message={metrics.error} onRetry={metrics.reload} />}

      <DailyMetrics items={metrics.data?.items ?? []} loading={metrics.loading && !metrics.data} fileTag={fileTag} />

      {!overview.data && !overview.error ? (
        <Skeleton height={120} />
      ) : devices.length === 0 ? (
        <EmptyState
          icon="robot"
          title="还没有评审数据"
          description={isAdmin ? "点「运行评审」，系统会给每个微信号的 AI 对话打分。" : "管理员运行评审后，这里会显示评分。"}
          action={runButton || undefined}
        />
      ) : detail.loading && !detail.data ? (
        <Skeleton height={120} />
      ) : detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !scored ? (
        <EmptyState
          icon="robot"
          title="这个微信号还没有评审数据"
          description={isAdmin ? "点「运行评审」给它打分，几秒后就能看到结果。" : "管理员运行评审后，这里会显示评分。"}
          action={runButton || undefined}
        />
      ) : (
        <>
          <ScoreTiles detail={scored} />
          <RawMetrics detail={scored} />
          <ScoreCharts device={current} detail={scored} days={days} />
          <Suggestions detail={scored} />
        </>
      )}
    </div>
  );
}

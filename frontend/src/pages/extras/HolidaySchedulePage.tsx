import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, DataTable, EmptyState, FilterBar, Icon, SearchField, SegmentedControl, Select, useFeedback, type Column } from "@ui";
import { holidayApi, type HolidayFilter, type HolidaySchedule, type MyCity } from "../../api/extras";
import { HolidayDialog, yearOptions } from "./HolidayDialog";
import { HolidayImportDialog } from "./HolidayImportDialog";
import { PositionsHead, Toolbar } from "./Heads";
import { Pager } from "./Pager";
import { errorText, pageSlice } from "./model";

type Status = "all" | "on" | "off";
type Row = Omit<HolidaySchedule, "id"> & { id: string; key: number; source: HolidaySchedule };
const SEARCH_DELAY_MS = 300;

function matches(row: HolidaySchedule, f: HolidayFilter): boolean {
  if (f.city_name && !row.city_name.includes(f.city_name)) return false;
  if (f.year !== undefined && Number(row.year) !== f.year) return false;
  if (f.is_active !== undefined && Boolean(row.is_active) !== f.is_active) return false;
  return true;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function HolidaySchedulePage() {
  const { toast, confirm } = useFeedback();
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<HolidaySchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cities, setCities] = useState<MyCity[]>([]);
  const [dialog, setDialog] = useState<{ editing: HolidaySchedule | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const city = useDebounced(query.trim(), SEARCH_DELAY_MS);

  const filter = useMemo<HolidayFilter>(
    () => ({ city_name: city || undefined, year: year ? Number(year) : undefined, is_active: status === "all" ? undefined : status === "on" }),
    [city, year, status],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const { items } = await holidayApi.list(filter);
      setRows(items);
    } catch (err) {
      setError(errorText(err, "放假总表加载失败"));
    }
  }, [filter]);

  useEffect(() => {
    setRows(null);
    setPage(1);
    load();
  }, [load]);

  useEffect(() => {
    holidayApi.myCities().then(setCities).catch(() => setCities([]));
  }, []);

  const visible = useMemo(() => (rows ?? []).filter((r) => matches(r, filter)), [rows, filter]);
  const activeCount = visible.filter((r) => r.is_active).length;
  const tableRows: Row[] = pageSlice(visible, page, pageSize).map((r) => ({ ...r, id: String(r.id), key: r.id, source: r }));
  const hasFilter = Boolean(query || year || status !== "all");

  async function remove(row: HolidaySchedule) {
    const ok = await confirm({
      title: `删除「${row.city_name} · ${row.holiday_name}」？`,
      description: "删除后 AI 不再按这条安排回答放假问题，无法恢复。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDeleting(row.id);
    try {
      await holidayApi.remove(row.id);
      toast("已删除");
      if (tableRows.length === 1 && page > 1) setPage(page - 1);
      await load();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    } finally {
      setDeleting(null);
    }
  }

  const columns: Column<Row>[] = [
    { key: "city_name", header: "城市", sortable: true, render: (r) => <strong className="ex-strong">{r.city_name}</strong> },
    { key: "interview_site_name", header: "面试点", render: (r) => r.interview_site_name || <span className="ex-muted">整个城市</span> },
    { key: "year", header: "年份", align: "right", sortable: true },
    { key: "holiday_name", header: "节假日" },
    { key: "start_date", header: "日期", sortable: true, render: (r) => <span className="ui-num">{r.start_date} 至 {r.end_date}</span> },
    { key: "can_interview", header: "可面试", render: (r) => <Badge tone={r.can_interview ? "success" : "neutral"}>{r.can_interview ? "可以" : "不可以"}</Badge> },
    { key: "is_makeup_day", header: "补班", render: (r) => (r.is_makeup_day ? <Badge tone="warning">补班</Badge> : <span className="ex-muted">—</span>) },
    { key: "is_active", header: "状态", render: (r) => <Badge tone={r.is_active ? "success" : "neutral"} dot>{r.is_active ? "启用" : "停用"}</Badge> },
    { key: "sort_order", header: "排序", align: "right" },
    { key: "updated_at", header: "更新时间", render: (r) => <span className="ex-muted ui-num">{r.updated_at || "—"}</span> },
    {
      key: "key",
      header: "操作",
      render: (r) => (
        <span className="ex-row-actions">
          <Button variant="ghost" size="sm" onClick={() => setDialog({ editing: r.source })}>编辑</Button>
          <Button variant="ghost" size="sm" loading={deleting === r.key} onClick={() => remove(r.source)}>删除</Button>
        </span>
      ),
    },
  ];

  const addButton = <Button icon={<Icon name="plus" size={15} />} onClick={() => setDialog({ editing: null })}>添加放假安排</Button>;

  return (
    <div className="mod-page">
      <PositionsHead active="holidays" />
      <Toolbar title="放假总表" description="按城市或面试点设置节假日安排。AI 回答「放不放假、能不能面试」时以这里为准。">
        <Button variant="secondary" icon={<Icon name="download" size={15} />} onClick={() => setImporting(true)}>岗位节假日导出 / 导入</Button>
        {addButton}
      </Toolbar>

      <FilterBar
        result={rows ? `共 ${visible.length} 条，启用 ${activeCount} 条` : undefined}
        onClear={hasFilter ? () => { setQuery(""); setYear(""); setStatus("all"); } : undefined}
      >
        <SearchField value={query} onChange={setQuery} label="按城市搜索" placeholder="搜索城市" />
        <div className="ex-filter-select">
          <Select
            id="hd-filter-year"
            aria-label="年份"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            options={[{ value: "", label: "全部年份" }, ...yearOptions().map((y) => ({ value: String(y), label: `${y} 年` }))]}
          />
        </div>
        <SegmentedControl
          size="sm"
          label="状态"
          value={status}
          onChange={(v) => setStatus(v as Status)}
          options={[{ value: "all", label: "全部" }, { value: "on", label: "启用" }, { value: "off", label: "停用" }]}
        />
      </FilterBar>

      {error && <Alert tone="danger" title={error} action={<Button size="sm" variant="secondary" onClick={load}>重试</Button>} />}

      {rows && rows.length === 0 && !hasFilter ? (
        <EmptyState icon="clock" title="还没有放假安排" description="添加春节、国庆等节假日后，AI 能直接回答应聘者「这几天能不能面试」。" action={addButton} />
      ) : (
        !error && (
          <>
            <DataTable caption="放假总表" columns={columns} rows={tableRows} loading={rows === null} />
            <Pager id="hd-page-size" page={page} pageSize={pageSize} total={visible.length} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
          </>
        )
      )}

      {dialog && (
        <HolidayDialog
          editing={dialog.editing}
          cities={cities}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            load();
          }}
        />
      )}
      {importing && <HolidayImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

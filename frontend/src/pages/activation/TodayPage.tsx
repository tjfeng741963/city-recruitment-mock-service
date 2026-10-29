import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, DataTable, FilterBar, Input, Menu, Pagination, SearchField, Select, Tag, Tooltip, useFeedback, type Column } from "@ui";
import { activationApi, type ActivationRecord, type RecordQuery } from "../../api/activation";
import { settingsApi } from "../../api/admin";
import { ActivationHead, LoadError, PAGE_SIZES, STATUS_META, errText, shortTime, statusMeta, strategyLabel } from "./shared";
import { ApproveDialog, FreezeDialog } from "./TodayDialogs";

const SEARCH_DEBOUNCE_MS = 300;
const MAX_BATCH_FAILURES = 3;
const PENDING = ["pending_review", "pending_send"];

type Row = Omit<ActivationRecord, "id"> & { id: string; record: ActivationRecord };

interface Filters {
  recruiter: string;
  status: string;
  start: string;
  end: string;
  keyword: string;
}

const INITIAL: Filters = { recruiter: "", status: "pending_review", start: "", end: "", keyword: "" };
const CLEARED: Filters = { recruiter: "", status: "", start: "", end: "", keyword: "" };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function useRecruiterOptions() {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    settingsApi
      .recruiters()
      .then((r) => setIds([...new Set((r.items ?? []).map((x) => x.recruiter_id).filter(Boolean))]))
      .catch(() => setIds([]));
  }, []);
  return ids;
}

function tierLine(r: ActivationRecord) {
  if (!r.tier || r.tier <= 0) return null;
  return (
    <div className="ac-sub">
      {r.next_push_at ? `已发 ${r.tier}/3 档 · 下档 ${shortTime(r.next_push_at)}` : `三档完成（${r.tier} 次）`}
    </div>
  );
}

function runMessage(result: Awaited<ReturnType<typeof activationApi.run>>): string {
  if (result.tier && result.tier > 0 && result.next_push_at) return `已发送（第 ${result.tier} 档），下一档 ${result.next_push_at.replace("T", " ").slice(0, 16)} 自动推`;
  return `已发送：${result.sent_content?.slice(0, 40) ?? ""}`;
}
export function TodayPage() {
  const { toast, confirm } = useFeedback();
  const recruiters = useRecruiterOptions();
  const [filters, setFilters] = useState<Filters>(INITIAL);
  const keyword = useDebounced(filters.keyword, SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<ActivationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<ActivationRecord | null>(null);
  const [freezing, setFreezing] = useState<ActivationRecord[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const q: RecordQuery = {
      page,
      page_size: pageSize,
      strategy: "no_reply",
      recruiter_id: filters.recruiter || undefined,
      status: filters.status || undefined,
      start_date: filters.start || undefined,
      end_date: filters.end || undefined,
      keyword: keyword.trim() || undefined,
    };
    try {
      const result = await activationApi.records(q);
      setRows(result.items ?? []);
      setTotal(result.total ?? 0);
      setError(null);
    } catch (err) {
      setError(errText(err, "名单加载失败"));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filters.recruiter, filters.status, filters.start, filters.end, keyword]);

  useEffect(() => {
    load();
  }, [load]);

  function setFilter(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  const tableRows: Row[] = useMemo(() => rows.map((r) => ({ ...r, id: String(r.id), record: r })), [rows]);
  const pick = (ids: string[], statuses: string[]) => rows.filter((r) => ids.includes(String(r.id)) && statuses.includes(r.status));

  async function runOne(r: ActivationRecord) {
    setRunning(String(r.id));
    try {
      toast(runMessage(await activationApi.run(r.id)));
      load();
    } catch (err) {
      toast(errText(err, "发送失败"), "danger");
    } finally {
      setRunning(null);
    }
  }

  async function skipOne(r: ActivationRecord) {
    const name = r.nickname || String(r.customer_id);
    const ok = await confirm({ title: `跳过「${name}」？`, description: "跳过后今天不再发送，明天可能重新进入名单。", confirmLabel: "跳过", danger: true });
    if (!ok) return;
    try {
      await activationApi.skip(r.id);
      toast(`已跳过：${name}`);
      load();
    } catch (err) {
      toast(errText(err, "操作失败"), "danger");
    }
  }

  async function batch(
    targets: ActivationRecord[],
    action: (r: ActivationRecord) => Promise<unknown>,
    done: (ok: number) => string,
    clear: () => void,
  ) {
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    let detail = "";
    for (const r of targets) {
      try {
        await action(r);
        ok += 1;
      } catch (err) {
        failed += 1;
        detail = errText(err, "");
        if (failed >= MAX_BATCH_FAILURES && detail) break;
      }
    }
    setBatchBusy(false);
    if (ok) toast(done(ok));
    if (failed) toast(`失败 ${failed} 条${detail ? `：${detail}` : ""}`, "danger");
    clear();
    load();
  }

  async function batchApprove(ids: string[], clear: () => void) {
    const targets = pick(ids, ["pending_review"]);
    if (!targets.length) return toast("所选记录中没有「待审核」的记录", "warning");
    const ok = await confirm({ title: `批量通过 ${targets.length} 条？`, description: "不逐条修改话术，直接加入发送队列。", confirmLabel: "通过" });
    if (ok) batch(targets, (r) => activationApi.approve(r.id), (n) => `已批量通过 ${n} 条`, clear);
  }

  async function batchSend(ids: string[], clear: () => void) {
    const targets = pick(ids, ["pending_send"]);
    if (!targets.length) return toast("所选记录中没有「待发送」的记录", "warning");
    const ok = await confirm({ title: `逐条发送给 ${targets.length} 位客户？`, description: "审核时选过话术的发选定内容，未选定的随机抽取。", confirmLabel: "发送" });
    if (ok) batch(targets, (r) => activationApi.run(r.id), (n) => `已发送 ${n} 条`, clear);
  }

  async function batchSkip(ids: string[], clear: () => void) {
    const targets = pick(ids, PENDING);
    if (!targets.length) return toast("所选记录中没有待处理的记录", "warning");
    const ok = await confirm({ title: `跳过所选 ${targets.length} 条？`, description: "跳过后今天不再发送。", confirmLabel: "跳过", danger: true });
    if (ok) batch(targets, (r) => activationApi.skip(r.id), () => "已批量跳过", clear);
  }

  function batchFreeze(ids: string[], clear: () => void) {
    const targets = pick(ids, PENDING);
    if (!targets.length) return toast("所选记录中没有待处理的记录", "warning");
    setFreezing(targets);
    clear();
  }
  const columns: Column<Row>[] = [
    {
      key: "nickname",
      header: "客户",
      render: (r) => (
        <div>
          <a className="ac-link" href={`/activation/customer/${r.customer_id}`}>{r.nickname || "未命名客户"}</a>
          <div className="ac-sub ui-num">{r.customer_id}</div>
        </div>
      ),
    },
    { key: "strategy", header: "策略", render: (r) => <Tag>{strategyLabel(r.strategy)}</Tag> },
    {
      key: "device_code",
      header: "设备 / 招聘员",
      render: (r) => (
        <div>
          <div>{r.device_name || r.device_code || "—"}</div>
          <div className="ac-sub">{r.recruiter_id || "—"}</div>
        </div>
      ),
    },
    { key: "stale_days", header: "停滞", align: "right", render: (r) => (r.stale_days != null ? `${r.stale_days} 天` : "—") },
    { key: "created_at", header: "入单时间", render: (r) => <span className="ui-num">{shortTime(r.created_at)}</span> },
    {
      key: "summary",
      header: "AI 摘要",
      render: (r) =>
        r.summary ? (
          <Tooltip content={r.summary}>
            <span className="ac-ellipsis">{r.summary}</span>
          </Tooltip>
        ) : (
          <span className="ac-sub">暂无摘要</span>
        ),
    },
    {
      key: "status",
      header: "状态",
      render: (r) => {
        const meta = statusMeta(r.status);
        return (
          <div>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {tierLine(r.record)}
          </div>
        );
      },
    },
    {
      key: "record",
      header: "操作",
      render: (r) => (
        <div className="ac-actions">
          {r.status === "pending_review" && <Button size="sm" onClick={() => setApproving(r.record)}>审核</Button>}
          {r.status === "pending_send" && (
            <Button size="sm" variant="tinted" loading={running === r.id} onClick={() => runOne(r.record)}>立即发送</Button>
          )}
          <a className="ac-link" href={`/activation/customer/${r.customer_id}`}>详情</a>
          {PENDING.includes(r.status) && (
            <Menu
              label={`更多操作：${r.nickname || r.customer_id}`}
              items={[
                { label: "跳过（今日不发）", onSelect: () => skipOne(r.record) },
                { label: "冷冻（暂停 N 天）", onSelect: () => setFreezing([r.record]) },
              ]}
            />
          )}
        </div>
      ),
    },
  ];

  const filtered = JSON.stringify(filters) !== JSON.stringify(CLEARED);

  return (
    <div className="mod-page">
      <ActivationHead title="今日任务" current="/activation/today" />
      <p className="ac-muted">待审核记录需人工确认后才会发送；未处理的记录会一直保留，不会自动清掉；已处理、已回复的可按入单日期回查。</p>
      <FilterBar result={`共 ${total} 条`} onClear={filtered ? () => setFilter(CLEARED) : undefined}>
        <Select
          id="ac-f-recruiter"
          label="招聘员"
          value={filters.recruiter}
          onChange={(e) => setFilter({ recruiter: e.target.value })}
          options={[{ value: "", label: "全部招聘员" }, ...recruiters.map((id) => ({ value: id, label: id }))]}
        />
        <Select
          id="ac-f-status"
          label="状态"
          value={filters.status}
          onChange={(e) => setFilter({ status: e.target.value })}
          options={[{ value: "", label: "全部状态" }, ...Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label }))]}
        />
        <Input id="ac-f-start" type="date" label="入单开始" value={filters.start} max={filters.end || undefined} onChange={(e) => setFilter({ start: e.target.value })} />
        <Input id="ac-f-end" type="date" label="入单结束" value={filters.end} min={filters.start || undefined} onChange={(e) => setFilter({ end: e.target.value })} />
        <div className="ac-search">
          <span className="ac-search-label" aria-hidden="true">搜索</span>
          <SearchField label="搜索昵称或客户 ID" placeholder="搜索昵称或客户 ID" value={filters.keyword} onChange={(v) => setFilter({ keyword: v })} />
        </div>
      </FilterBar>
      {error ? (
        <LoadError message={error} onRetry={load} />
      ) : (
        <DataTable
          caption="激活名单"
          columns={columns}
          rows={tableRows}
          loading={loading}
          selectable
          bulkActions={(ids, clear) => (
            <>
              <Button size="sm" disabled={batchBusy} onClick={() => batchApprove(ids, clear)}>批量审核通过</Button>
              <Button size="sm" variant="tinted" disabled={batchBusy} onClick={() => batchSend(ids, clear)}>批量发送</Button>
              <Button size="sm" variant="secondary" disabled={batchBusy} onClick={() => batchSkip(ids, clear)}>批量跳过</Button>
              <Button size="sm" variant="secondary" disabled={batchBusy} onClick={() => batchFreeze(ids, clear)}>批量冷冻</Button>
            </>
          )}
          emptyAction={filtered ? <Button variant="secondary" onClick={() => setFilter(CLEARED)}>清除筛选</Button> : undefined}
        />
      )}
      {total > 0 && (
        <div className="ac-pager">
          <Select
            id="ac-page-size"
            aria-label="每页条数"
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            options={PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
          />
          <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />
        </div>
      )}
      {approving && (
        <ApproveDialog
          record={approving}
          onClose={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            load();
          }}
        />
      )}
      {freezing && (
        <FreezeDialog
          records={freezing}
          onClose={() => setFreezing(null)}
          onDone={() => {
            setFreezing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

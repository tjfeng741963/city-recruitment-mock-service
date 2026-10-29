import { useCallback, useEffect, useState, type FormEvent } from "react";
import { unknownQuestionsApi, type UnknownQuestion } from "../../api/knowledge";
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, FilterBar, Input, SearchField, SegmentedControl, Tag, Textarea, useFeedback, type Column, type Tone } from "@ui";
import { KeywordInput, ModuleTabs, PagerRow, RetryAlertAction, errorText, useDebounced } from "./shared";

type Row = Omit<UnknownQuestion, "id"> & { id: string; num: number; actions?: never };

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "待处理", tone: "warning" },
  resolved: { label: "已处理", tone: "success" },
  ignored: { label: "已忽略", tone: "neutral" },
};

const FILTERS = [
  { value: "", label: "全部" },
  { value: "pending", label: "待处理" },
  { value: "resolved", label: "已处理" },
  { value: "ignored", label: "已忽略" },
];

const MERGED_SHOWN = 3;

function ConvertDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [question, setQuestion] = useState(row.question);
  const [answer, setAnswer] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ question?: string; answer?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = { question: question.trim() ? undefined : "请填写问题", answer: answer.trim() ? undefined : "请填写标准回答" };
    setErrors(found);
    if (found.question || found.answer) return;
    setSaving(true);
    setError(null);
    try {
      await unknownQuestionsApi.convert(row.num, { question: question.trim(), answer: answer.trim(), keywords });
      toast("已转入知识库", "success");
      onDone();
    } catch (err) {
      setError(errorText(err, "转入失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="转为知识条目"
      description="写好标准回答后，AI 下次遇到这个问题就能直接回复。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="uq-convert-form" loading={saving}>确认转入</Button>
        </>
      }
    >
      <form id="uq-convert-form" className="mod-form" onSubmit={submit} noValidate>
        <Input id="uq-question" label="问题" required value={question} error={errors.question} onChange={(e) => setQuestion(e.target.value)} />
        <Textarea id="uq-answer" label="回答" required rows={5} placeholder="输入标准回答" value={answer} error={errors.answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />
        <KeywordInput id="uq-keywords" value={keywords} onChange={setKeywords} />
        {error && <p className="mod-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

export function UnknownQuestionsPage() {
  const { toast, confirm } = useFeedback();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [converting, setConverting] = useState<Row | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => setPage(1), [status, query, pageSize]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    unknownQuestionsApi
      .list({ page, pageSize, status, search: query })
      .then((res) => {
        if (!alive) return;
        setRows(res.items.map((q) => ({ ...q, id: String(q.id), num: q.id })));
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setRows([]);
        setError(errorText(err, "未知问题加载失败"));
      });
    return () => {
      alive = false;
    };
  }, [status, query, page, pageSize, version]);

  async function remove(row: Row) {
    const ok = await confirm({ title: "删除这个问题？", description: `“${row.question}”删除后不会再出现在这里。`, confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await unknownQuestionsApi.remove(row.num);
      toast("已删除", "success");
      if (rows?.length === 1 && page > 1) setPage(page - 1);
      else reload();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    }
  }

  const columns: Column<Row>[] = [
    {
      key: "question",
      header: "问题",
      render: (r) => {
        const merged = r.merged_questions ?? [];
        return (
          <span className="kn-cell-stack">
            <span className="kn-question">{r.question}</span>
            {merged.length > 0 && (
              <span className="kn-tags">
                {merged.slice(0, MERGED_SHOWN).map((m) => <Tag key={m}>{m}</Tag>)}
                {merged.length > MERGED_SHOWN && <span className="kn-more ui-num">+{merged.length - MERGED_SHOWN}</span>}
              </span>
            )}
          </span>
        );
      },
    },
    { key: "count", header: "次数", align: "right", width: "72px", sortable: true, render: (r) => r.count ?? "—" },
    { key: "city_name", header: "城市", width: "96px", render: (r) => r.city_name || <span className="kn-muted">—</span> },
    {
      key: "status",
      header: "状态",
      width: "96px",
      render: (r) => {
        const s = STATUS[r.status] ?? { label: r.status, tone: "neutral" as Tone };
        return <Badge tone={s.tone} dot>{s.label}</Badge>;
      },
    },
    { key: "last_seen_at", header: "最近出现", width: "170px", render: (r) => <span className="kn-muted ui-num">{r.last_seen_at || "—"}</span> },
    {
      key: "actions",
      header: "操作",
      width: "160px",
      render: (r) => (
        <span className="kn-row-actions">
          {r.status === "pending" && <Button size="sm" variant="tinted" onClick={() => setConverting(r)}>转知识库</Button>}
          <Button size="sm" variant="ghost" onClick={() => remove(r)}>删除</Button>
        </span>
      ),
    },
  ];

  const isEmptyAll = rows !== null && rows.length === 0 && !query && !status && !error;

  return (
    <div className="mod-page">
      <header className="mod-head">
        <h1>知识库</h1>
        <ModuleTabs active="unknown" />
      </header>
      <p className="kn-note">AI 答不上来的问题会记在这里。写好回答后转入知识库，下次就能直接回复。</p>

      <FilterBar result={rows ? `共 ${total} 条` : undefined} onClear={search || status ? () => { setSearch(""); setStatus(""); } : undefined}>
        <SegmentedControl label="处理状态" size="sm" options={FILTERS} value={status} onChange={setStatus} />
        <SearchField label="搜索问题" placeholder="搜索问题" value={search} onChange={setSearch} />
      </FilterBar>

      {error && <Alert tone="danger" title="未知问题加载失败" action={<RetryAlertAction onRetry={reload} />}>{error}</Alert>}

      {isEmptyAll ? (
        <EmptyState icon="check" title="暂时没有未知问题" description="AI 遇到答不上来的问题时会自动记到这里，到时再来处理。" />
      ) : (
        <>
          <DataTable caption="未知问题" columns={columns} rows={rows ?? []} loading={rows === null} />
          {total > 0 && <PagerRow id="uq-page-size" page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />}
        </>
      )}

      {converting && <ConvertDialog row={converting} onClose={() => setConverting(null)} onDone={() => { setConverting(null); reload(); }} />}
    </div>
  );
}

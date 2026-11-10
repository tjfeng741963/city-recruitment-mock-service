import { useCallback, useEffect, useState, type FormEvent } from "react";
import { kbEntriesApi, type KbEntry } from "../../api/knowledge";
import { Alert, Button, DataTable, Dialog, EmptyState, FilterBar, Icon, Input, SearchField, Textarea, useFeedback, type Column } from "@ui";
import { ModuleTabs, PagerRow, RetryAlertAction, errorText, useDebounced } from "./shared";

/** 话术库固定 kind=script。 */
const KIND = "script";

type Row = Omit<KbEntry, "id"> & { id: string; num: number; actions?: never };

function ScriptDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: Pick<KbEntry, "id" | "title" | "question" | "answer"> | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useFeedback();
  const [title, setTitle] = useState(entry?.title ?? "");
  const [question, setQuestion] = useState(entry?.question ?? "");
  const [answer, setAnswer] = useState(entry?.answer ?? "");
  const [errors, setErrors] = useState<{ title?: string; question?: string; answer?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = {
      title: title.trim() ? undefined : "请填写话术标题",
      question: question.trim() ? undefined : "请填写匹配问题",
      answer: answer.trim() ? undefined : "请填写话术内容",
    };
    setErrors(found);
    if (found.title || found.question || found.answer) return;
    setSaving(true);
    setError(null);
    const input = { title: title.trim(), question: question.trim(), answer: answer.trim(), kind: KIND };
    try {
      if (entry) await kbEntriesApi.update(entry.id, input);
      else await kbEntriesApi.create(input);
      toast(entry ? "话术已更新" : "话术已添加", "success");
      onDone();
    } catch (err) {
      setError(errorText(err, entry ? "保存失败" : "添加失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? "编辑话术" : "添加话术"}
      description="AI 按标题/关键词匹配话术后直接发给候选人。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="kb-script-form" loading={saving}>保存</Button>
        </>
      }
    >
      <form id="kb-script-form" className="mod-form" onSubmit={submit} noValidate>
        <Input id="kb-script-title" label="标题" required value={title} error={errors.title} placeholder="如：体检说明" onChange={(e) => setTitle(e.target.value)} autoFocus={!entry} />
        <Input id="kb-script-question" label="匹配问题" required value={question} error={errors.question} placeholder="候选人可能会问的问题" onChange={(e) => setQuestion(e.target.value)} />
        <Textarea id="kb-script-answer" label="话术内容" required rows={5} placeholder="输入要回复的话术" value={answer} error={errors.answer} onChange={(e) => setAnswer(e.target.value)} />
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function ScriptsLibraryPage() {
  const { toast, confirm } = useFeedback();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<null | "new" | Row>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => setPage(1), [query, pageSize]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    kbEntriesApi
      .list({ kind: KIND, search: query || undefined, page, pageSize })
      .then((res) => {
        if (!alive) return;
        setRows(res.items.map((k) => ({ ...k, id: String(k.id), num: k.id })));
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setRows([]);
        setError(errorText(err, "话术库加载失败"));
      });
    return () => {
      alive = false;
    };
  }, [query, page, pageSize, version]);

  async function remove(row: Row) {
    const ok = await confirm({ title: "删除这条话术？", description: `“${row.title || row.question}”删除后 AI 不再使用它回复。`, confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await kbEntriesApi.remove(row.num);
      toast("已删除", "success");
      if (rows?.length === 1 && page > 1) setPage(page - 1);
      else reload();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    }
  }

  const columns: Column<Row>[] = [
    { key: "title", header: "标题", width: "200px", render: (r) => <span className="kn-question">{r.title || "—"}</span> },
    { key: "question", header: "匹配问题", render: (r) => r.question || <span className="kn-muted">—</span> },
    {
      key: "answer",
      header: "话术内容",
      render: (r) => {
        const text = r.answer ?? "";
        return text.length > 40 ? <span title={text}>{text.slice(0, 40)}…</span> : <span>{text || <span className="kn-muted">—</span>}</span>;
      },
    },
    { key: "updated_at", header: "更新时间", width: "170px", render: (r) => <span className="kn-muted ui-num">{r.updated_at || r.created_at || "—"}</span> },
    {
      key: "actions",
      header: "操作",
      width: "140px",
      render: (r) => (
        <span className="kn-row-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => remove(r)}>删除</Button>
        </span>
      ),
    },
  ];

  const isEmptyAll = rows !== null && rows.length === 0 && !query && !error;

  return (
    <div className="mod-page">
      <header className="mod-head">
        <h1>知识库</h1>
        <ModuleTabs active="scripts" />
      </header>
      <p className="kn-note">候选人插问时，AI 按标题/关键词从这里挑一条话术回复；没命中就走兜底并记入未知问题。</p>

      <div className="kn-toolbar">
        <FilterBar result={rows ? `共 ${total} 条` : undefined} onClear={search ? () => setSearch("") : undefined}>
          <SearchField label="搜索话术" placeholder="搜索标题或问题" value={search} onChange={setSearch} />
        </FilterBar>
        <div className="kn-toolbar-actions">
          <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditing("new")}>添加话术</Button>
        </div>
      </div>

      {error && <Alert tone="danger" title="话术库加载失败" action={<RetryAlertAction onRetry={reload} />}>{error}</Alert>}

      {isEmptyAll ? (
        <EmptyState
          icon="info"
          title="还没有话术"
          description="把每个节点常用的话术加进来（3-5 条），AI 遇到对应问题就能直接回复。"
          action={<Button onClick={() => setEditing("new")}>添加第一条话术</Button>}
        />
      ) : (
        <>
          <DataTable
            key={`${page}-${pageSize}-${query}-${version}`}
            caption="话术库"
            columns={columns}
            rows={rows ?? []}
            loading={rows === null}
          />
          {total > 0 && <PagerRow id="kb-script-page-size" page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />}
        </>
      )}

      {editing && (
        <ScriptDialog
          key={editing === "new" ? "new" : `edit-${editing.num}`}
          entry={editing === "new" ? null : { id: editing.num, title: editing.title, question: editing.question, answer: editing.answer }}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, DataTable, FilterBar, Icon, Pagination, SearchField, Select, Switch, Tag, useFeedback, type Column } from "@ui";
import { activationApi, type Script, type ScriptList } from "../../api/activation";
import { ActivationHead, LoadError, PAGE_SIZES, errText, fullTime } from "./shared";
import { ImportExportDialog, ScriptDialog } from "./ScriptDialogs";

const SEARCH_DEBOUNCE_MS = 300;

type Row = Omit<Script, "id"> & { id: string; script: Script };

export function ScriptsPage() {
  const { toast, confirm } = useFeedback();
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [active, setActive] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<ScriptList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Script | "new" | null>(null);
  const [transfer, setTransfer] = useState(false);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [keyword]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await activationApi.scripts({ page, page_size: pageSize, keyword: debounced || undefined, category: category || undefined, is_active: active || undefined }));
      setError(null);
    } catch (err) {
      setError(errText(err, "话术加载失败"));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, debounced, category, active]);

  useEffect(() => {
    load();
  }, [load]);

  const rows: Row[] = useMemo(() => (data?.items ?? []).map((s) => ({ ...s, id: String(s.id), script: s })), [data]);

  async function toggle(s: Script, isActive: boolean) {
    try {
      // Send the whole record: the backend replaces its stored fields with the request body.
      await activationApi.updateScript(s.id, { content: s.content, category: s.category, is_active: isActive });
      toast(isActive ? "已启用" : "已停用");
      load();
    } catch (err) {
      toast(errText(err, "操作失败"), "danger");
    }
  }

  async function remove(s: Script) {
    const ok = await confirm({ title: "删除这条话术？", description: "删除后不再参与发送，无法恢复。", confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await activationApi.deleteScript(s.id);
      toast("已删除");
      load();
    } catch (err) {
      toast(errText(err, "删除失败"), "danger");
    }
  }

  async function draw() {
    setDrawing(true);
    try {
      setDrawn((await activationApi.randomScript()).content);
    } catch (err) {
      setDrawn(null);
      toast(errText(err, "没有可抽取的启用话术"), "warning");
    } finally {
      setDrawing(false);
    }
  }

  function setFilter(fn: () => void) {
    fn();
    setPage(1);
  }
  const columns: Column<Row>[] = [
    { key: "id", header: "ID", align: "right", width: "64px" },
    { key: "content", header: "话术内容", render: (r) => <div className={`ac-content ${r.is_active ? "" : "is-off"}`}>{r.content}</div> },
    { key: "category", header: "分类", render: (r) => (r.category ? <Tag>{r.category}</Tag> : <span className="ac-sub">—</span>) },
    {
      key: "is_active",
      header: "启用",
      render: (r) => (
        <div className="ac-switch-cell">
          <Switch id={`ac-script-${r.id}`} label={<span className="ui-sr-only">启用话术 {r.id}</span>} checked={r.is_active} onChange={(e) => toggle(r.script, e.target.checked)} />
        </div>
      ),
    },
    { key: "used_count", header: "使用次数", align: "right" },
    { key: "last_used_at", header: "最近使用", render: (r) => <span className="ui-num">{fullTime(r.last_used_at)}</span> },
    {
      key: "script",
      header: "操作",
      render: (r) => (
        <div className="ac-actions">
          <Button size="sm" variant="secondary" onClick={() => setEditing(r.script)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => remove(r.script)}>删除</Button>
        </div>
      ),
    },
  ];

  const total = data?.total ?? 0;
  const activeTotal = data?.active_total ?? 0;
  const filtered = Boolean(keyword || category || active);

  return (
    <div className="mod-page">
      <ActivationHead
        title="复聊话术"
        current="/activation/scripts"
        actions={
          <div className="ac-actions">
            <Button size="sm" variant="secondary" onClick={() => setTransfer(true)}>导入 / 导出</Button>
            <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditing("new")}>新增话术</Button>
          </div>
        }
      />
      <p className="ac-muted">激活发送时从「启用」的话术中随机抽一条发给客户；客户回复后仍由原 Dify 对话接管。</p>
      {data && (
        <div className="ac-row-between">
          <p className="ac-statline">
            共 <b className="ui-num">{total}</b> 条 · 启用 <b className="ui-num">{activeTotal}</b> 条（参与随机抽取）
            {activeTotal === 0 && <> <Badge tone="danger">启用话术为 0，发送会被拦截</Badge></>}
          </p>
          <Button size="sm" variant="ghost" loading={drawing} icon={<Icon name="refresh" size={14} />} onClick={draw}>随机抽一条看看</Button>
        </div>
      )}
      {drawn && <Alert tone="accent" title="抽到的话术" action={<Button size="sm" variant="ghost" onClick={() => setDrawn(null)}>收起</Button>}>{drawn}</Alert>}
      <FilterBar
        result={`共 ${total} 条`}
        onClear={filtered ? () => setFilter(() => { setKeyword(""); setCategory(""); setActive(""); }) : undefined}
      >
        <div className="ac-search">
          <span className="ac-search-label" aria-hidden="true">搜索</span>
          <SearchField label="搜索话术内容" placeholder="搜索话术内容" value={keyword} onChange={(v) => setFilter(() => setKeyword(v))} />
        </div>
        <Select
          id="ac-s-category"
          label="分类"
          value={category}
          onChange={(e) => setFilter(() => setCategory(e.target.value))}
          options={[{ value: "", label: "全部分类" }, ...(data?.categories ?? []).map((c) => ({ value: c, label: c }))]}
        />
        <Select
          id="ac-s-active"
          label="启用状态"
          value={active}
          onChange={(e) => setFilter(() => setActive(e.target.value))}
          options={[{ value: "", label: "全部" }, { value: "true", label: "启用" }, { value: "false", label: "停用" }]}
        />
      </FilterBar>
      {error ? (
        <LoadError message={error} onRetry={load} />
      ) : data && total === 0 && !filtered ? (
        <Alert tone="warning" title="话术库是空的" action={<Button size="sm" onClick={() => setEditing("new")}>新增话术</Button>}>
          没有启用的话术时激活消息发不出去。先新增几条，或用「导入 / 导出」批量导入。
        </Alert>
      ) : (
        <DataTable caption="复聊话术" columns={columns} rows={rows} loading={loading && !data} />
      )}
      {total > 0 && (
        <div className="ac-pager">
          <Select
            id="ac-s-page-size"
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
      {editing && (
        <ScriptDialog
          script={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {transfer && <ImportExportDialog onClose={() => setTransfer(false)} onImported={load} />}
    </div>
  );
}

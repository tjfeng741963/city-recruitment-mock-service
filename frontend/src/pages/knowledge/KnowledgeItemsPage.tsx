import { useCallback, useEffect, useState } from "react";
import { knowledgeApi, type KnowledgeItem } from "../../api/knowledge";
import { navigate } from "../../app/router";
import { Alert, Badge, Button, DataTable, EmptyState, FilterBar, Icon, SearchField, Tag, useFeedback, type Column } from "@ui";
import { BatchUpdateDialog, ImportDialog } from "./KnowledgeBatchDialogs";
import { KnowledgeEditDialog } from "./KnowledgeEditDialog";
import { ModuleTabs, PagerRow, RetryAlertAction, errorText, useDebounced } from "./shared";

type Row = Omit<KnowledgeItem, "id"> & { id: string; num: number; actions?: never };

const KEYWORDS_SHOWN = 5;

function toRow(item: KnowledgeItem): Row {
  return { ...item, id: String(item.id), num: item.id };
}

function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** edit: undefined = closed, "new" = create, number = edit that id. Mirrors /knowledge/create and /knowledge/:id/edit. */
export function KnowledgeItemsPage({ edit }: { edit?: "new" | number }) {
  const { toast, confirm } = useFeedback();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<null | "import" | { batch: number[] }>(null);
  const [exporting, setExporting] = useState(false);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => setPage(1), [query, pageSize]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    knowledgeApi
      .list(query, page, pageSize)
      .then((res) => {
        if (!alive) return;
        setRows(res.items.map(toRow));
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setRows([]);
        setError(errorText(err, "知识列表加载失败"));
      });
    return () => {
      alive = false;
    };
  }, [query, page, pageSize, version]);

  const closeEdit = () => navigate("/knowledge");

  async function remove(row: Row) {
    const ok = await confirm({ title: "删除这条知识？", description: `“${row.question}”删除后，AI 不会再用它回复。`, confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await knowledgeApi.remove(row.num);
      toast("已删除", "success");
      if (rows?.length === 1 && page > 1) setPage(page - 1);
      else reload();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    }
  }

  async function removeMany(ids: string[], clear: () => void) {
    const ok = await confirm({ title: `删除选中的 ${ids.length} 条知识？`, description: "删除后不能恢复。", confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      const res = await knowledgeApi.batchDelete(ids.map(Number));
      toast(`已删除 ${res.deleted} 条`, "success");
      clear();
      if (rows && res.deleted >= rows.length && page > 1) setPage(page - 1);
      else reload();
    } catch (err) {
      toast(errorText(err, "批量删除失败"), "danger");
    }
  }

  async function exportAll() {
    setExporting(true);
    try {
      const data = await knowledgeApi.exportAll(query);
      downloadJson(data, `knowledge_${new Date().toISOString().slice(0, 10)}.json`);
      toast(`已导出 ${data.length} 条`, "success");
    } catch (err) {
      toast(errorText(err, "导出失败"), "danger");
    } finally {
      setExporting(false);
    }
  }

  const columns: Column<Row>[] = [
    { key: "question", header: "问题", render: (r) => <span className="kn-question">{r.question}</span> },
    {
      key: "keywords",
      header: "关键词",
      render: (r) =>
        r.keywords.length ? (
          <span className="kn-tags">
            {r.keywords.slice(0, KEYWORDS_SHOWN).map((k) => <Tag key={k}>{k}</Tag>)}
            {r.keywords.length > KEYWORDS_SHOWN && <span className="kn-more ui-num">+{r.keywords.length - KEYWORDS_SHOWN}</span>}
          </span>
        ) : (
          <span className="kn-muted">未设置</span>
        ),
    },
    { key: "is_active", header: "状态", width: "88px", render: (r) => <Badge tone={r.is_active ? "success" : "neutral"} dot>{r.is_active ? "启用" : "停用"}</Badge> },
    { key: "sort_order", header: "排序", align: "right", width: "72px", sortable: true },
    { key: "updated_at", header: "更新时间", width: "170px", render: (r) => <span className="kn-muted ui-num">{r.updated_at || "—"}</span> },
    {
      key: "actions",
      header: "操作",
      width: "140px",
      render: (r) => (
        <span className="kn-row-actions">
          <Button size="sm" variant="ghost" onClick={() => navigate(`/knowledge/${r.num}/edit`)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => remove(r)}>删除</Button>
        </span>
      ),
    },
  ];

  const isEmptyLibrary = rows !== null && rows.length === 0 && !query && !error;

  return (
    <div className="mod-page">
      <header className="mod-head">
        <h1>知识库</h1>
        <ModuleTabs active="items" />
      </header>

      <div className="kn-toolbar">
        <FilterBar result={rows ? `共 ${total} 条` : undefined} onClear={search ? () => setSearch("") : undefined}>
          <SearchField label="搜索知识" placeholder="搜索问题或关键词" value={search} onChange={setSearch} />
        </FilterBar>
        <div className="kn-toolbar-actions">
          <Button variant="secondary" size="sm" icon={<Icon name="download" size={14} />} loading={exporting} onClick={exportAll}>导出</Button>
          <Button variant="secondary" size="sm" onClick={() => setDialog("import")}>导入</Button>
          <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => navigate("/knowledge/create")}>添加知识</Button>
        </div>
      </div>

      {error && <Alert tone="danger" title="知识列表加载失败" action={<RetryAlertAction onRetry={reload} />}>{error}</Alert>}

      {isEmptyLibrary ? (
        <EmptyState
          icon="info"
          title="还没有知识条目"
          description="把候选人常问的问题和标准回答加进来，AI 会按这里的内容回复。也可以从未知问题里一键转入。"
          action={<Button onClick={() => navigate("/knowledge/create")}>添加第一条知识</Button>}
        />
      ) : (
        <>
          <DataTable
            key={`${page}-${pageSize}-${query}-${version}`}
            caption="知识条目"
            columns={columns}
            rows={rows ?? []}
            loading={rows === null}
            selectable
            bulkActions={(ids, clear) => (
              <>
                <Button size="sm" variant="secondary" onClick={() => setDialog({ batch: ids.map(Number) })}>批量修改</Button>
                <Button size="sm" variant="destructive" onClick={() => removeMany(ids, clear)}>批量删除</Button>
              </>
            )}
          />
          {total > 0 && <PagerRow id="kn-page-size" page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />}
        </>
      )}

      {edit !== undefined && (
        <KnowledgeEditDialog
          key={String(edit)}
          id={edit === "new" ? undefined : edit}
          onClose={closeEdit}
          onSaved={() => {
            closeEdit();
            reload();
          }}
        />
      )}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} onImported={() => { setDialog(null); reload(); }} />}
      {dialog && dialog !== "import" && (
        <BatchUpdateDialog ids={dialog.batch} onClose={() => setDialog(null)} onUpdated={() => { setDialog(null); reload(); }} />
      )}
    </div>
  );
}

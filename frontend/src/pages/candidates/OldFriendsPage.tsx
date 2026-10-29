import { useEffect, useMemo, useState } from "react";
import { Badge, Button, DataTable, FilterBar, Icon, Pagination, Reveal, RevealItem, SearchField, Select, useFeedback, type Column } from "@ui";
import { oldFriendsApi, type OldFriend } from "../../api/candidates";
import { AddOldFriendDialog } from "./OldFriendDialog";
import { CountTile, LoadError, ModHead, PageSizeSelect, errorText, useLoader, useMyDevices } from "./shared";

type Row = Omit<OldFriend, "id"> & { id: string; raw: OldFriend; device: string; ops: string };

const isReleased = (f: OldFriend) => f.status === "released";
const SEARCH_DELAY_MS = 300;

export function OldFriendsPage() {
  const { toast, confirm } = useFeedback();
  const { devices, names } = useMyDevices();
  const [accounts, setAccounts] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [account, setAccount] = useState("");
  const [device, setDevice] = useState("");
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    oldFriendsApi.accounts().then((r) => setAccounts(r.items ?? [])).catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setKeyword(query.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const { data, setData, error, loading, reload } = useLoader(
    () => oldFriendsApi.list({ page, page_size: pageSize, status, account, device_code: device, keyword }),
    [page, pageSize, status, account, device, keyword],
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  function patch(id: number, next: Partial<OldFriend>) {
    setData((d) => (d ? { ...d, items: d.items.map((f) => (f.id === id ? { ...f, ...next } : f)) } : d));
  }

  async function act(f: OldFriend, run: () => Promise<unknown>, done: string, next?: Partial<OldFriend>) {
    setBusyId(f.id);
    try {
      await run();
      if (next) patch(f.id, next);
      else reload();
      toast(done);
    } catch (err) {
      toast(errorText(err), "danger");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(f: OldFriend) {
    const ok = await confirm({
      title: `删除老朋友「${f.nickname || f.customer_id}」？`,
      description: "删除后 AI 会把他当成普通求职者，正常自动回复。",
      confirmLabel: "删除",
      danger: true,
    });
    if (ok) await act(f, () => oldFriendsApi.remove(f.id), "已删除");
  }

  const rows: Row[] = useMemo(
    () => items.map((f) => ({ ...f, id: String(f.id), raw: f, device: names.get(f.device_code) ?? (f.device_code || "—"), ops: "" })),
    [items, names],
  );

  const columns: Column<Row>[] = [
    { key: "nickname", header: "昵称", render: (r) => <strong className="cd-strong">{r.nickname || "—"}</strong> },
    { key: "customer_id", header: "客户 ID", render: (r) => <span className="ui-num">{r.customer_id}</span> },
    { key: "device", header: "微信号" },
    { key: "account", header: "招聘员", render: (r) => r.account || "—" },
    { key: "status", header: "状态", render: (r) => (isReleased(r.raw) ? <Badge tone="success" dot>可聊</Badge> : <Badge dot>不可聊</Badge>) },
    { key: "created_at", header: "添加时间", sortable: true, render: (r) => <span className="ui-num">{r.created_at || "—"}</span> },
    {
      key: "ops",
      header: "操作",
      render: (r) => {
        const f = r.raw;
        const busy = busyId === f.id;
        return (
          <span className="cd-row-ops">
            {isReleased(f) ? (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => act(f, () => oldFriendsApi.unrelease(f.id), "已收回，AI 不再回复他", { status: "unreleased" })}>收回</Button>
            ) : (
              <Button size="sm" variant="tinted" loading={busy} onClick={() => act(f, () => oldFriendsApi.release(f.id), "已放行，AI 会照常回复", { status: "released" })}>放行</Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} aria-label={`删除 ${f.nickname || f.customer_id}`} icon={<Icon name="trash" size={14} />} onClick={() => remove(f)}>删除</Button>
          </span>
        );
      },
    },
  ];

  const blocked = items.filter((f) => !isReleased(f)).length;
  const released = items.length - blocked;
  const hasFilter = Boolean(status || account || device || keyword);

  return (
    <div className="mod-page">
      <ModHead title="老朋友" active="/old-friends" actions={<Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setAdding(true)}>添加老朋友</Button>} />
      <p className="cd-lead">企微端上报的老客户。AI 默认不回复他们，需要时可以手动放行。</p>

      <Reveal className="cd-stats cd-stats-3">
        <RevealItem><CountTile icon="users" label="老朋友总数" value={data ? total : null} unit="人" /></RevealItem>
        <RevealItem><CountTile icon="pause" label="不可聊（本页）" value={data ? blocked : null} unit="人" /></RevealItem>
        <RevealItem><CountTile icon="chat" label="可聊（本页）" value={data ? released : null} unit="人" /></RevealItem>
      </Reveal>

      <FilterBar onClear={hasFilter ? () => { setStatus(""); setAccount(""); setDevice(""); setQuery(""); setPage(1); } : undefined}>
        <Select id="of-f-status" label="状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          options={[{ value: "", label: "全部" }, { value: "unreleased", label: "不可聊" }, { value: "released", label: "可聊" }]} />
        <Select id="of-f-account" label="招聘员" value={account} onChange={(e) => { setAccount(e.target.value); setPage(1); }}
          options={[{ value: "", label: "全部" }, ...accounts.map((a) => ({ value: a, label: a }))]} />
        <Select id="of-f-device" label="微信号" value={device} onChange={(e) => { setDevice(e.target.value); setPage(1); }}
          options={[{ value: "", label: "全部" }, ...devices.map((d) => ({ value: d.device_code, label: d.name || d.device_code }))]} />
        <div className="cd-search"><SearchField value={query} onChange={setQuery} label="搜索昵称或客户 ID" placeholder="昵称 / 客户 ID" /></div>
      </FilterBar>

      {error && <LoadError message={error} onRetry={reload} />}

      <DataTable<Row>
        caption="老朋友列表"
        columns={columns}
        rows={rows}
        loading={loading && !data}
        emptyAction={hasFilter ? undefined : <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>添加老朋友</Button>}
      />

      {total > 0 && (
        <div className="cd-pager">
          <PageSizeSelect id="of-page-size" value={pageSize} onChange={(n) => { setPageSize(n); setPage(1); }} />
          <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />
        </div>
      )}

      {adding && (
        <AddOldFriendDialog
          devices={devices}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            toast("已添加老朋友");
            reload();
          }}
        />
      )}
    </div>
  );
}

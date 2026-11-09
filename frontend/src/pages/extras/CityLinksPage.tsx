import { useCallback, useEffect, useState } from "react";
import { Alert, Button, DataTable, Dialog, EmptyState, Icon, useFeedback, type Column } from "@ui";
import { cityLinkApi } from "../../api/extras";
import { navigate } from "../../app/router";
import { PositionsHead, Toolbar } from "./Heads";
import { Pager } from "./Pager";
import { TagInput, TagPicker } from "./TagPicker";
import { errorText, pageSlice } from "./model";

interface LinkRow {
  city: string;
  count: number;
  targets: string[];
  districts: string[];
}

interface Loaded {
  rows: LinkRow[];
  defaults: Record<string, string[]>;
}

const unique = (list: string[] = []) => [...new Set(list)];

async function loadLinks(): Promise<Loaded> {
  const [opts, state] = await Promise.all([cityLinkApi.options(), cityLinkApi.list()]);
  const defaults = opts.default_districts ?? {};
  const rows = opts.options.map((o) => ({
    city: o.city,
    count: o.count,
    targets: unique(state.links?.[o.city]),
    districts: unique(state.districts?.[o.city] ?? defaults[o.city]),
  }));
  return { rows, defaults };
}

function DistrictDialog({ row, suggestions, onClose, onDone }: { row: LinkRow; suggestions: string[]; onClose: () => void; onDone: (d: string[]) => void }) {
  const [values, setValues] = useState(row.districts);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${row.city}的区县`}
      description={`应聘者说出这些区县时，会归到${row.city}，并推荐${row.city}和它周边城市的岗位。`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={() => onDone(values)}>确定</Button>
        </>
      }
    >
      <TagInput id="cl-district" label={`${row.city}的区县`} values={values} suggestions={suggestions} onChange={setValues} />
    </Dialog>
  );
}

export function CityLinksPage() {
  const { toast } = useFeedback();
  const [data, setData] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<LinkRow | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await loadLinks();
      setData(loaded);
      setRows(loaded.rows);
      setDirty(false);
      setPage(1);
    } catch (err) {
      setError(errorText(err, "周边城市设置加载失败"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function update(city: string, patch: Partial<LinkRow>) {
    setRows((list) => list.map((r) => (r.city === city ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await cityLinkApi.save(rows.map((r) => ({ source_city: r.city, target_cities: r.targets, districts: r.districts })));
      toast("周边城市设置已保存");
      await load();
    } catch (err) {
      toast(errorText(err, "保存失败，请重试"), "danger");
    } finally {
      setSaving(false);
    }
  }

  const cityNames = rows.map((r) => r.city);
  const tableRows = pageSlice(rows, page, pageSize).map((r) => ({ ...r, id: r.city }));
  const columns: Column<(typeof tableRows)[number]>[] = [
    { key: "city", header: "负责城市", sortable: true, width: "140px", render: (r) => <strong className="ex-strong">{r.city}</strong> },
    { key: "count", header: "岗位数", align: "right", width: "90px" },
    {
      key: "targets",
      header: "周边城市（可多选）",
      render: (r) => (
        <TagPicker
          label={`${r.city}的周边城市`}
          values={r.targets}
          options={cityNames.map((c) => ({ value: c, disabled: c === r.city }))}
          emptyText="未设置"
          onChange={(targets) => update(r.city, { targets })}
        />
      ),
    },
    {
      key: "districts",
      header: "区县",
      width: "120px",
      render: (r) => (
        <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
          {r.districts.length} 个区县
        </Button>
      ),
    },
  ];

  return (
    <div className="mod-page">
      <PositionsHead active="links" />
      <Toolbar
        title="周边城市设置"
        description="负责城市没有合适岗位时，AI 会推荐这里设置的周边城市的岗位。只对在「管理岗位城市」里勾选了负责城市的招聘员生效。"
      >
        {dirty && <span className="ex-dirty" role="status">有未保存的修改</span>}
        <Button icon={<Icon name="check" size={15} />} loading={saving} disabled={!dirty} onClick={save}>保存设置</Button>
      </Toolbar>

      {error && <Alert tone="danger" title={error} action={<Button size="sm" variant="secondary" onClick={load}>重试</Button>} />}

      {data && rows.length === 0 ? (
        <EmptyState icon="link" title="还没有岗位城市" description="先在「城市与岗位」里建好城市，再回来设置周边城市。" action={<Button variant="secondary" onClick={() => navigate("/service-positions")}>去建城市</Button>} />
      ) : (
        !error && (
          <>
            <DataTable caption="周边城市设置" columns={columns} rows={tableRows} loading={data === null} />
            <Pager id="cl-page-size" page={page} pageSize={pageSize} total={rows.length} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
          </>
        )
      )}

      {editing && (
        <DistrictDialog
          row={editing}
          suggestions={data?.defaults[editing.city] ?? []}
          onClose={() => setEditing(null)}
          onDone={(districts) => {
            update(editing.city, { districts });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

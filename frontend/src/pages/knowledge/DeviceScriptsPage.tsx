import { useCallback, useEffect, useState, type FormEvent } from "react";
import { deviceScriptsApi, DEVICE_SCRIPT_STAGES, stageLabel, type DeviceScript } from "../../api/deviceScripts";
import { Alert, Button, DataTable, Dialog, EmptyState, Icon, Input, Select, Tag, Textarea, useFeedback, type Column } from "@ui";
import { ModuleTabs, RetryAlertAction, errorText } from "./shared";

type Row = Omit<DeviceScript, "id"> & { id: string; num: number; actions?: never };

/** 占位符高亮：{{factory}} 等，仅展示不做替换。 */
function renderContent(text: string) {
  if (!text) return <span className="kn-muted">—</span>;
  const parts = text.split(/(\{\{(?:factory|wage|place|window)\}\})/g);
  return (
    <span title={text}>
      {parts.map((part, i) =>
        /^\{\{(?:factory|wage|place|window)\}\}$/.test(part) ? (
          <code key={i} className="kn-ph">{part}</code>
        ) : (
          part
        ),
      )}
    </span>
  );
}

function ScriptDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: Pick<DeviceScript, "id" | "device_code" | "stage" | "city" | "title" | "content" | "status"> | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useFeedback();
  const [deviceCode, setDeviceCode] = useState(entry?.device_code ?? "");
  const [stage, setStage] = useState(entry?.stage ?? "send_info");
  const [city, setCity] = useState(entry?.city ?? "");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [content, setContent] = useState(entry?.content ?? "");
  const [status, setStatus] = useState(entry?.status ?? "enabled");
  const [errors, setErrors] = useState<{ device_code?: string; content?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = {
      device_code: deviceCode.trim() ? undefined : "请填写设备码",
      content: content.trim() ? undefined : "请填写话术内容",
    };
    setErrors(found);
    if (found.device_code || found.content) return;
    setSaving(true);
    setError(null);
    try {
      await deviceScriptsApi.save({
        device_code: deviceCode.trim(),
        stage,
        city: city.trim(),
        title: title.trim(),
        content: content.trim(),
        status,
      });
      toast(entry ? "话术已保存" : "话术已添加", "success");
      onDone();
    } catch (err) {
      setError(errorText(err, "保存失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? "编辑设备话术" : "添加设备话术"}
      description="按设备码+流程节点+城市绑定话术，保存后随设备配置下发给客户端。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="ds-script-form" loading={saving}>保存</Button>
        </>
      }
    >
      <form id="ds-script-form" className="mod-form" onSubmit={submit} noValidate>
        <Input
          id="ds-device-code"
          label="设备码"
          required
          value={deviceCode}
          error={errors.device_code}
          placeholder="如：pc-office-01"
          onChange={(e) => setDeviceCode(e.target.value)}
          autoFocus={!entry}
        />
        <Select
          id="ds-stage"
          label="流程节点"
          required
          options={DEVICE_SCRIPT_STAGES.map((s) => ({ value: s.value, label: s.label }))}
          value={stage}
          onChange={(e) => setStage(e.target.value)}
        />
        <Input id="ds-city" label="城市" value={city} placeholder="选填，如：深圳" onChange={(e) => setCity(e.target.value)} />
        <Input id="ds-title" label="标题" value={title} placeholder="选填，如：龙华厂标准介绍" onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          id="ds-content"
          label="话术内容"
          required
          rows={5}
          value={content}
          error={errors.content}
          placeholder="输入要回复的话术，支持占位符：{{factory}} {{wage}} {{place}} {{window}}"
          onChange={(e) => setContent(e.target.value)}
        />
        <Select
          id="ds-status"
          label="状态"
          options={[
            { value: "enabled", label: "启用" },
            { value: "disabled", label: "停用" },
          ]}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        />
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function DeviceScriptsPage() {
  const { toast, confirm } = useFeedback();
  const [deviceInput, setDeviceInput] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [stage, setStage] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<null | "new" | Row>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    setRows(null);
    deviceScriptsApi
      .list({ device_code: deviceCode || undefined, stage: stage || undefined })
      .then((res) => {
        if (!alive) return;
        setRows(res.items.map((d) => ({ ...d, id: String(d.id), num: d.id })));
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setRows([]);
        setError(errorText(err, "设备话术加载失败"));
      });
    return () => {
      alive = false;
    };
  }, [deviceCode, stage, version]);

  function applyDevice() {
    setDeviceCode(deviceInput.trim());
  }

  async function remove(row: Row) {
    const ok = await confirm({
      title: "删除这条设备话术？",
      description: `“${row.title || stageLabel(row.stage)}”删除后该设备不再下发这条话术。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await deviceScriptsApi.remove(row.num);
      toast("已删除", "success");
      reload();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    }
  }

  const columns: Column<Row>[] = [
    { key: "device_code", header: "设备码", width: "140px", render: (r) => <span className="kn-question">{r.device_code}</span> },
    { key: "stage", header: "节点", width: "110px", render: (r) => stageLabel(r.stage) },
    { key: "city", header: "城市", width: "90px", render: (r) => r.city || <span className="kn-muted">—</span> },
    { key: "title", header: "标题", width: "160px", render: (r) => r.title || <span className="kn-muted">—</span> },
    {
      key: "content",
      header: "话术内容",
      render: (r) => {
        const text = r.content ?? "";
        if (text.length > 40) {
          const clipped = renderContent(`${text.slice(0, 40)}…`);
          return clipped;
        }
        return renderContent(text);
      },
    },
    {
      key: "status",
      header: "状态",
      width: "80px",
      render: (r) => <Tag>{r.status === "disabled" ? "停用" : "启用"}</Tag>,
    },
    { key: "updated_at", header: "更新时间", width: "170px", render: (r) => <span className="kn-muted ui-num">{r.updated_at || "—"}</span> },
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

  const isEmptyAll = rows !== null && rows.length === 0 && !deviceCode && !stage && !error;

  return (
    <div className="mod-page">
      <header className="mod-head">
        <h1>知识库</h1>
        <ModuleTabs active="device-scripts" />
      </header>
      <p className="kn-note">按设备码绑定各流程节点的话术，随设备配置下发到客户端；内容里的 {"{{factory}}"} 等占位符由后端渲染时替换。</p>

      <div className="kn-toolbar">
        <div className="kn-toolbar-filters">
          <Input
            id="ds-filter-device"
            aria-label="按设备码筛选"
            placeholder="设备码，如 pc-office-01"
            value={deviceInput}
            onChange={(e) => setDeviceInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyDevice();
            }}
            onBlur={applyDevice}
          />
          <Button size="sm" variant="secondary" onClick={applyDevice}>查询</Button>
          <Select
            id="ds-filter-stage"
            aria-label="按流程节点筛选"
            placeholder="全部节点"
            options={DEVICE_SCRIPT_STAGES.map((s) => ({ value: s.value, label: s.label }))}
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          />
        </div>
        <div className="kn-toolbar-actions">
          <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditing("new")}>添加话术</Button>
        </div>
      </div>

      {error && <Alert tone="danger" title="设备话术加载失败" action={<RetryAlertAction onRetry={reload} />}>{error}</Alert>}

      {isEmptyAll ? (
        <EmptyState
          icon="info"
          title="还没有设备话术"
          description="给指定设备绑定流程节点话术，客户端拉取配置后按节点直接使用，无需模型生成。"
          action={<Button onClick={() => setEditing("new")}>添加第一条话术</Button>}
        />
      ) : (
        <DataTable
          key={`${deviceCode}-${stage}-${version}`}
          caption="设备话术"
          columns={columns}
          rows={rows ?? []}
          loading={rows === null}
        />
      )}
      {rows !== null && !error && total > 0 && <p className="kn-note">共 {total} 条</p>}

      {editing && (
        <ScriptDialog
          key={editing === "new" ? "new" : `edit-${editing.id}`}
          entry={editing === "new" ? null : { ...editing, id: editing.num }}
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

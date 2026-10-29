import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Alert, Badge, Button, DataTable, Dialog, EmptyState, Input, Switch, useFeedback, type Column } from "@ui";
import { activationApi, type ActivationDevice, type DeviceLimits } from "../../api/activation";
import { ActivationHead, LoadError, PausedBanner, errText, useLoad } from "./shared";

type Row = ActivationDevice & { id: string };

const LIMITS: Array<{ key: keyof DeviceLimits; label: string; max: number; hint: string }> = [
  { key: "burst10_limit", label: "每 10 分钟（条）", max: 50, hint: "10 分钟内最多发送条数，超了自动顺延，保护微信账号" },
  { key: "hourly_limit", label: "每小时（条）", max: 200, hint: "1 小时内最多发送条数，超了自动顺延" },
  { key: "daily_limit", label: "每日上限（条）", max: 1000, hint: "该设备当天复聊发送总量上限，超了顺延到明天发送时段开始" },
];

async function loadDevices() {
  const [list, config] = await Promise.all([activationApi.devices(), activationApi.config().catch(() => null)]);
  return { items: list.items ?? [], paused: Boolean(config?.paused) };
}

function LimitsDialog({ device, onClose, onSaved }: { device: ActivationDevice; onClose: () => void; onSaved: (l: DeviceLimits) => void }) {
  const { toast } = useFeedback();
  const [draft, setDraft] = useState<Record<keyof DeviceLimits, string>>({
    burst10_limit: String(device.burst10_limit ?? 3),
    hourly_limit: String(device.hourly_limit ?? 10),
    daily_limit: String(device.daily_limit ?? 20),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = Object.fromEntries(
    LIMITS.map(({ key, max }) => {
      const n = Number(draft[key]);
      return [key, Number.isInteger(n) && n >= 1 && n <= max ? undefined : `请填 1–${max} 之间的整数`];
    }),
  ) as Record<keyof DeviceLimits, string | undefined>;
  const invalid = Object.values(errors).some(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    const limits: DeviceLimits = { burst10_limit: Number(draft.burst10_limit), hourly_limit: Number(draft.hourly_limit), daily_limit: Number(draft.daily_limit) };
    setSaving(true);
    setError(null);
    try {
      await activationApi.updateDevice(device.device_code, limits);
      toast("设备配置已保存");
      onSaved(limits);
    } catch (err) {
      setError(errText(err, "保存失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`设备配置 · ${device.name || device.device_code}`}
      description={<span className="ui-num">{device.device_code || "（设备编号缺失）"}</span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="ac-limits-form" loading={saving} disabled={invalid}>保存</Button>
        </>
      }
    >
      <form id="ac-limits-form" className="mod-form" noValidate onSubmit={submit}>
        <h4 className="ac-label">发送限流（账号风控）</h4>
        {LIMITS.map(({ key, label, max, hint }) => (
          <Input
            key={key}
            id={`ac-limit-${key}`}
            type="number"
            min={1}
            max={max}
            label={label}
            required
            value={draft[key]}
            error={errors[key]}
            helperText={hint}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          />
        ))}
        <Alert tone="accent" title="限流只卡自动推送">人工「立即发送」不受限制；Dify 对接在设备端上报，无需在这里配置。</Alert>
        {error && <p className="mod-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
export function DevicesPage() {
  const { toast, confirm } = useFeedback();
  const { data, setData, error, loading, reload } = useLoad(loadDevices);
  const [editing, setEditing] = useState<Row | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  // DataTable needs unique string ids; a device without a code still gets a row.
  const rows: Row[] = useMemo(() => (data?.items ?? []).map((d, i) => ({ ...d, id: d.device_code || `row-${i}` })), [data]);

  const patchDevice = useCallback(
    (id: string, patch: Partial<ActivationDevice>) =>
      setData((d) => (d ? { ...d, items: d.items.map((x, i) => ((x.device_code || `row-${i}`) === id ? { ...x, ...patch } : x)) } : d)),
    [setData],
  );

  async function toggle(row: Row, enabled: boolean) {
    patchDevice(row.id, { activation_enabled: enabled });
    try {
      await activationApi.updateDevice(row.device_code, { activation_enabled: enabled });
      toast(`「${row.name}」复聊激活已${enabled ? "开启" : "关闭"}`);
    } catch (err) {
      patchDevice(row.id, { activation_enabled: !enabled });
      toast(errText(err, "操作失败"), "danger");
    }
  }

  async function batchToggle(ids: string[], enabled: boolean, clear: () => void) {
    const codes = rows.filter((r) => ids.includes(r.id) && r.device_code).map((r) => r.device_code);
    if (!codes.length) return toast("所选设备缺少设备编号，无法批量操作", "warning");
    const ok = await confirm({
      title: `${enabled ? "开启" : "关闭"}所选 ${codes.length} 台设备的复聊激活？`,
      description: enabled ? "开启后会按策略给这些设备下的沉淀客户发激活消息。" : "关闭后这些设备立即停止发送激活消息。",
      confirmLabel: enabled ? "开启" : "关闭",
      danger: !enabled,
    });
    if (!ok) return;
    setBatchBusy(true);
    try {
      await activationApi.batchToggle(codes, enabled);
      toast(`已批量${enabled ? "开启" : "关闭"} ${codes.length} 台`);
      clear();
      reload();
    } catch (err) {
      toast(errText(err, "批量操作失败"), "danger");
    } finally {
      setBatchBusy(false);
    }
  }

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "设备",
      render: (r) => (
        <div>
          <div className="ac-strong">{r.name || "未命名设备"}</div>
          <div className="ac-sub ui-num">{r.device_code || "缺少设备编号，暂不能修改"}</div>
        </div>
      ),
    },
    { key: "recruiter_id", header: "归属招聘员", render: (r) => r.recruiter_id || "—" },
    {
      key: "activation_enabled",
      header: "复聊激活",
      render: (r) => (
        <div className="ac-switch-cell">
          <Switch
            id={`ac-dev-${r.id}`}
            label={<span className="ui-sr-only">{r.name} 复聊激活</span>}
            checked={r.activation_enabled}
            disabled={!r.device_code}
            onChange={(e) => toggle(r, e.target.checked)}
          />
        </div>
      ),
    },
    {
      key: "today_sent",
      header: "今日已发",
      align: "right",
      render: (r) => <span className={r.today_sent >= r.daily_limit ? "ac-warn" : undefined}>{r.today_sent} / {r.daily_limit}</span>,
    },
    {
      key: "dify_url",
      header: "AI 接管",
      render: (r) => (r.dify_url ? <Badge tone="success">已配置</Badge> : <Badge tone="warning">未配置（AI 不回复）</Badge>),
    },
    { key: "id", header: "操作", render: (r) => <Button size="sm" variant="secondary" disabled={!r.device_code} onClick={() => setEditing(r)}>编辑</Button> },
  ];

  return (
    <div className="mod-page">
      <ActivationHead title="激活设备" current="/activation/devices" />
      <p className="ac-muted">每台设备一个开关：开了就按策略给这台设备下的沉淀客户发激活消息，关了立即停止。勾选多台可批量开关。</p>
      {data?.paused && <PausedBanner text="下面的开关即使开启也不会发送，请先到复聊总览页恢复。" />}
      {error ? (
        <LoadError message={error} onRetry={reload} />
      ) : data && rows.length === 0 ? (
        <EmptyState icon="device" title="还没有可激活的设备" description="先在「微信号」页绑定并登录设备，设备上报后会出现在这里。" action={<a className="ac-link" href="/agent-devices">去微信号页</a>} />
      ) : (
        <DataTable
          caption="激活设备"
          columns={columns}
          rows={rows}
          loading={loading && !data}
          selectable
          bulkActions={(ids, clear) => (
            <>
              <Button size="sm" variant="secondary" disabled={batchBusy} onClick={() => batchToggle(ids, false, clear)}>批量关闭</Button>
              <Button size="sm" disabled={batchBusy} onClick={() => batchToggle(ids, true, clear)}>批量开启</Button>
            </>
          )}
        />
      )}
      {editing && (
        <LimitsDialog
          device={editing}
          onClose={() => setEditing(null)}
          onSaved={(limits) => {
            patchDevice(editing.id, limits);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

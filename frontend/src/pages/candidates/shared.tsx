import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Button, CountUp, Select, StatTile, type IconName, type Tone } from "@ui";
import { ApiError } from "../../api/client";
import { candidatesApi, type MyDevice } from "../../api/candidates";

export const PAGE_SIZES = [10, 20, 50];

const SECTIONS = [
  { href: "/candidates", label: "候选人" },
  { href: "/old-friends", label: "老朋友" },
  { href: "/status-dashboard", label: "状态看板" },
  { href: "/agent-evaluations", label: "AI 评估" },
];

export function errorText(err: unknown, fallback = "操作失败，请稍后再试"): string {
  return err instanceof ApiError ? err.detail : fallback;
}

/** Page header with the four section links shared by every page in this module. */
export function ModHead({ title, active, actions }: { title: string; active: string; actions?: ReactNode }) {
  return (
    <header className="mod-head">
      <div className="cd-head-left">
        <h1>{title}</h1>
        <nav className="mod-tabs" aria-label="候选人页签">
          {SECTIONS.map((s) =>
            s.href === active ? (
              <span key={s.href} className="mod-tab is-active" aria-current="page">{s.label}</span>
            ) : (
              <a key={s.href} className="mod-tab" href={s.href}>{s.label}</a>
            ),
          )}
        </nav>
      </div>
      {actions && <div className="cd-head-actions">{actions}</div>}
    </header>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert tone="danger" title="数据没加载出来" action={<Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>}>
      {message}
    </Alert>
  );
}

export function CountTile({
  icon,
  label,
  value,
  unit,
  note,
  noteTone = "neutral",
  format,
}: {
  icon: IconName;
  label: string;
  value: number | null;
  unit?: string;
  note?: string;
  noteTone?: Tone;
  format?: (n: number) => string;
}) {
  return (
    <StatTile
      icon={icon}
      label={label}
      value={value === null ? "—" : <CountUp value={value} format={format} />}
      unit={value === null ? undefined : unit}
      delta={note}
      deltaTone={noteTone}
    />
  );
}

export function PageSizeSelect({ id, value, onChange }: { id: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="cd-pagesize">
      <Select
        id={id}
        aria-label="每页条数"
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
      />
    </div>
  );
}

/** Loads data with `load`, re-running whenever `deps` change. Keeps the previous data while reloading. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // `load` is a fresh closure every render; `deps` decides when it is re-created.
  const run = useCallback(load, deps);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const result = await run();
      if (id !== seq.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setError(errorText(err, "加载失败，请检查网络后重试"));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}

/** Writes rows to a UTF-8 CSV (with BOM so Excel opens Chinese correctly) and downloads it. */
export function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const text = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** WeChat accounts (devices) visible to the current user, plus a code→name lookup. */
export function useMyDevices() {
  const [devices, setDevices] = useState<MyDevice[]>([]);
  useEffect(() => {
    candidatesApi.myDevices().then((r) => setDevices(r.items ?? [])).catch(() => setDevices([]));
  }, []);
  const names = useMemo(() => new Map(devices.map((d) => [d.device_code, d.name || d.device_code])), [devices]);
  return { devices, names };
}

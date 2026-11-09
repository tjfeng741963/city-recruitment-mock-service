import { useId, useState, type DragEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Icon, type IconName } from "./Icon";
import type { Tone } from "./Display";
import { EASE_SIGNATURE } from "./Motion";

export function Panel({ title, actions, children, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`ui-panel ${flush ? "is-flush" : ""}`}>
      {(title || actions) && (
        <header className="ui-panel-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="ui-panel-actions">{actions}</div>}
        </header>
      )}
      <div className="ui-panel-body">{children}</div>
    </section>
  );
}

export function FilterBar({ children, result, onClear }: { children: ReactNode; result?: ReactNode; onClear?: () => void }) {
  return (
    <div className="ui-filterbar" role="search">
      <div className="ui-filterbar-fields">{children}</div>
      {(result || onClear) && (
        <div className="ui-filterbar-meta">
          {result && <span className="ui-num">{result}</span>}
          {onClear && (
            <button type="button" className="ui-link-btn" onClick={onClear}>
              清除筛选
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DescriptionList({ items, columns = 2 }: { items: Array<[string, ReactNode]>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`ui-desc ui-desc-${columns}`}>
      {items.map(([k, v]) => (
        <div key={k} className="ui-desc-item">
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TimelineEntry {
  id: string | number;
  time: string;
  title: ReactNode;
  body?: ReactNode;
  tone?: Tone;
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="ui-timeline">
      {entries.map((e) => (
        <li key={e.id} className={`ui-timeline-item ui-tone-${e.tone ?? "neutral"}`}>
          <span className="ui-timeline-dot" aria-hidden="true" />
          <div className="ui-timeline-content">
            <div className="ui-timeline-head">
              <strong>{e.title}</strong>
              <time className="ui-num">{e.time}</time>
            </div>
            {e.body && <div className="ui-timeline-body">{e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function FileDrop({
  accept,
  label,
  hint,
  icon = "download",
  disabled,
  onFile,
}: {
  accept?: string;
  label: string;
  hint?: string;
  icon?: IconName;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const id = useId();
  const [over, setOver] = useState(false);
  const [name, setName] = useState<string | null>(null);

  function take(file: File | undefined) {
    if (!file) return;
    setName(file.name);
    onFile(file);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setOver(false);
    if (!disabled) take(e.dataTransfer.files[0]);
  }

  return (
    <label
      htmlFor={id}
      className={`ui-drop ${over ? "is-over" : ""} ${disabled ? "is-disabled" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        className="ui-sr-only"
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <span className="ui-drop-icon">
        <Icon name={icon} size={22} />
      </span>
      <span className="ui-drop-label">{name ?? label}</span>
      {hint && <span className="ui-drop-hint">{hint}</span>}
    </label>
  );
}

export interface ChartDatum {
  label: string;
  value: number;
}

export function BarChart({ data, label, format = String }: { data: ChartDatum[]; label: string; format?: (n: number) => string }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure className="ui-bars" role="img" aria-label={`${label}：${data.map((d) => `${d.label} ${format(d.value)}`).join("，")}`}>
      <div className="ui-bars-plot">
        {data.map((d, i) => (
          <div key={d.label} className="ui-bars-col" title={`${d.label}：${format(d.value)}`}>
            <span className="ui-bars-value ui-num">{format(d.value)}</span>
            <motion.span
              className="ui-bars-fill"
              style={{ height: `${(d.value / max) * 100}%`, originY: 1 }}
              initial={reduce ? false : { scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.6, ease: EASE_SIGNATURE, delay: i * 0.04 }}
            />
          </div>
        ))}
      </div>
      <div className="ui-bars-axis" aria-hidden="true">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
    </figure>
  );
}

export function TrendChart({ points, label }: { points: ChartDatum[]; label: string }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? 100 / (points.length - 1) : 0;
  const coords = points.map((p, i) => [i * step, 38 - (p.value / max) * 34] as const);
  const line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const area = coords.length ? `${line} L100 40 L0 40 Z` : "";
  const every = Math.max(1, Math.ceil(points.length / 6));
  return (
    <figure className="ui-trend" role="img" aria-label={`${label}：${points.map((p) => `${p.label} ${p.value}`).join("，")}`}>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path className="ui-trend-area" d={area} />
        <motion.path
          className="ui-trend-line"
          d={line}
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: EASE_SIGNATURE }}
        />
      </svg>
      <div className="ui-bars-axis" aria-hidden="true">
        {points.map((p, i) => (
          <span key={p.label}>{i % every === 0 || i === points.length - 1 ? p.label : ""}</span>
        ))}
      </div>
    </figure>
  );
}

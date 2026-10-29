import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`ui-badge ui-tone-${tone}`}>
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Tag({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="ui-tag">
      {children}
      {onRemove && (
        <button type="button" className="ui-tag-remove" aria-label={`移除 ${String(children)}`} onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

export function Avatar({ name, size = 32, status }: { name: string; size?: number; status?: "online" | "away" | "offline" }) {
  const initial = name.trim().slice(0, 1);
  return (
    <span className="ui-avatar" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-label={name} role="img">
      {initial}
      {status && <span className={`ui-avatar-status is-${status}`} aria-hidden="true" />}
    </span>
  );
}

export function ProgressBar({ value, label, tone = "accent" }: { value: number; label: string; tone?: Tone }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="ui-progress">
      <div className="ui-progress-head">
        <span>{label}</span>
        <span className="ui-num">{pct}%</span>
      </div>
      <div
        className={`ui-progress-track ui-tone-${tone}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="ui-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14, round }: { width?: number | string; height?: number; round?: boolean }) {
  return <span className={`ui-skeleton ${round ? "is-round" : ""}`} style={{ width, height }} aria-hidden="true" />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <p className="ui-empty-title">{title}</p>
      <p className="ui-empty-desc">{description}</p>
      {action}
    </div>
  );
}

export function StatTile({
  icon,
  label,
  value,
  unit,
  delta,
  deltaTone = "success",
  spark,
}: {
  icon: IconName;
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  deltaTone?: Tone;
  spark?: number[];
}) {
  return (
    <div className="ui-stat">
      <div className="ui-stat-top">
        <span className="ui-stat-icon">
          <Icon name={icon} size={17} />
        </span>
        {delta && <Badge tone={deltaTone}>{delta}</Badge>}
      </div>
      <span className="ui-stat-label">{label}</span>
      <span className="ui-stat-value ui-num">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {spark && <Sparkline points={spark} />}
    </div>
  );
}

export function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${((i / (points.length - 1)) * 100).toFixed(2)} ${(28 - ((p - min) / span) * 24).toFixed(2)}`)
    .join(" ");
  return (
    <svg className="ui-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

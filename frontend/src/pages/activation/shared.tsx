import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, type Tone } from "@ui";
import { ApiError } from "../../api/client";

export const STRATEGY_LABEL: Record<string, string> = {
  no_reply: "A策略 · 无回复激活",
  date_trigger: "B策略 · 到期提醒",
  misjudge: "C策略 · 误判捞回",
  paused: "D策略 · 暂停求职",
};

export const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  pending_extract: { label: "待提取", tone: "neutral" },
  pending_generate: { label: "待生成", tone: "neutral" },
  pending_review: { label: "待审核", tone: "warning" },
  pending_send: { label: "待发送", tone: "accent" },
  sent: { label: "已发送", tone: "success" },
  replied: { label: "已回复", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  skipped: { label: "已跳过", tone: "neutral" },
  frozen: { label: "冷冻中", tone: "neutral" },
  expired: { label: "已过期", tone: "neutral" },
};

export const PAGE_SIZES = [10, 20, 50];

export function strategyLabel(code: string | undefined): string {
  return (code && STRATEGY_LABEL[code]) || code || "—";
}

export function statusMeta(status: string | undefined): { label: string; tone: Tone } {
  return (status && STATUS_META[status]) || { label: status || "—", tone: "neutral" };
}

export function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.detail ? err.detail : fallback;
}

/** "2026-10-27T01:53:18.512Z" / "2026-10-27 01:53:18" → "10-27 01:53" */
export function shortTime(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(5, 16);
}

export function fullTime(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 19);
}

export function formatRate(rate: number | string | undefined): string {
  if (rate === undefined || rate === null || rate === "") return "—";
  if (typeof rate === "string") return rate;
  return `${rate.toFixed(1)}%`;
}

const TABS: Array<[string, string]> = [
  ["/activation", "总览"],
  ["/activation/today", "今日任务"],
  ["/activation/strategies", "策略"],
  ["/activation/devices", "设备"],
  ["/activation/scripts", "话术"],
];

export function ActivationHead({ title, current, actions }: { title: string; current: string; actions?: ReactNode }) {
  return (
    <header className="mod-head">
      <h1>{title}</h1>
      <div className="ac-head-right">
        <nav className="mod-tabs" aria-label="复聊页签">
          {TABS.map(([href, label]) =>
            href === current ? (
              <span key={href} className="mod-tab is-active" aria-current="page">{label}</span>
            ) : (
              <a key={href} className="mod-tab" href={href}>{label}</a>
            ),
          )}
        </nav>
        {actions}
      </div>
    </header>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert tone="danger" title={message} action={<Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>} />
  );
}

/** Data + error + reload for a page that fetches on mount. `load` must be stable (module function or useCallback). */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(errText(err, "加载失败，请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

export function PausedBanner({ text }: { text: string }) {
  return <Alert tone="warning" title="复聊已全局暂停">{text}</Alert>;
}

import { useEffect, useState, type KeyboardEvent } from "react";
import { ApiError } from "../../api/client";
import { Button, FieldShell, Pagination, Select, Tag, describedByFor } from "@ui";

export type KnowledgeTab = "items" | "unknown" | "rules";

const TABS: Array<[KnowledgeTab, string, string]> = [
  ["items", "知识条目", "/knowledge"],
  ["unknown", "未知问题", "/unknown-questions"],
  ["rules", "回复规则", "/agent-rules"],
];

export const PAGE_SIZES = [10, 20, 50];

export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.detail ? err.detail : fallback;
}

export function ModuleTabs({ active }: { active: KnowledgeTab }) {
  return (
    <nav className="mod-tabs" aria-label="知识库页签">
      {TABS.map(([key, label, href]) =>
        key === active ? (
          <span key={key} className="mod-tab is-active" aria-current="page">{label}</span>
        ) : (
          <a key={key} className="mod-tab" href={href}>{label}</a>
        ),
      )}
    </nav>
  );
}

/** Pagination plus a page-size picker (10/20/50). */
export function PagerRow({
  id,
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  id: string;
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  return (
    <div className="kn-pager">
      <Select
        id={id}
        aria-label="每页条数"
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
        value={String(pageSize)}
        onChange={(e) => onPageSize(Number(e.target.value))}
      />
      <Pagination page={page} total={total} pageSize={pageSize} onChange={onPage} />
    </div>
  );
}

/** Editable keyword chips: type and press Enter (or comma) to add. */
export function KeywordInput({ id, value, onChange }: { id: string; value: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");

  function commit() {
    const words = draft.split(/[,，]/).map((w) => w.trim()).filter(Boolean);
    const next = words.reduce((acc, w) => (acc.includes(w) ? acc : [...acc, w]), value);
    if (next !== value) onChange(next);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "，") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <FieldShell id={id} label="关键词" helperText="输入后按回车添加。候选人的话里出现这些词时，会优先匹配这条知识。">
      <div className="kn-keywords-box">
        {value.map((w) => (
          <Tag key={w} onRemove={() => onChange(value.filter((x) => x !== w))}>{w}</Tag>
        ))}
        <input
          id={id}
          className="kn-keywords-input"
          value={draft}
          placeholder={value.length ? "" : "如：转正"}
          aria-describedby={describedByFor(id, "default", true)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
    </FieldShell>
  );
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function RetryAlertAction({ onRetry }: { onRetry: () => void }) {
  return <Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>;
}

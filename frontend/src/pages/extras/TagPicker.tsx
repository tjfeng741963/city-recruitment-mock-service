import { useState, type KeyboardEvent } from "react";
import { Button, Input, Tag } from "@ui";

// Multi-select as removable tags plus an "add" dropdown. The component library has no multi-select.
export function TagPicker({
  label,
  values,
  options,
  onChange,
  emptyText,
}: {
  label: string;
  values: string[];
  options: Array<{ value: string; disabled?: boolean }>;
  onChange: (next: string[]) => void;
  emptyText: string;
}) {
  const remaining = options.filter((o) => !o.disabled && !values.includes(o.value));
  return (
    <div className="ex-tagpicker" role="group" aria-label={label}>
      {values.length === 0 && <span className="ex-muted">{emptyText}</span>}
      {values.map((v) => (
        <Tag key={v} onRemove={() => onChange(values.filter((x) => x !== v))}>{v}</Tag>
      ))}
      {remaining.length > 0 && (
        <select
          className="ex-tagpicker-add"
          aria-label={`添加${label}`}
          value=""
          onChange={(e) => e.target.value && onChange([...values, e.target.value])}
        >
          <option value="">＋ 添加</option>
          {remaining.map((o) => (
            <option key={o.value} value={o.value}>{o.value}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// Free-text tag entry with suggestions, for 区县 that may not exist in the default list yet.
export function TagInput({
  id,
  label,
  values,
  suggestions,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  suggestions: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add(draft);
    }
  };
  const unused = suggestions.filter((s) => !values.includes(s));

  return (
    <div className="ex-taginput">
      <div className="ex-tagpicker" role="group" aria-label={label}>
        {values.length === 0 && <span className="ex-muted">还没有区县</span>}
        {values.map((v) => (
          <Tag key={v} onRemove={() => onChange(values.filter((x) => x !== v))}>{v}</Tag>
        ))}
      </div>
      <div className="ex-taginput-row">
        <Input id={id} aria-label="输入区县名称" placeholder="输入区县名称，回车添加" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
        <Button variant="secondary" size="sm" disabled={!draft.trim()} onClick={() => add(draft)}>添加</Button>
      </div>
      {unused.length > 0 && (
        <div className="ex-suggest">
          <span className="ex-muted">常用：</span>
          {unused.map((s) => (
            <Button key={s} variant="tinted" size="sm" className="ex-suggest-chip" onClick={() => add(s)}>＋ {s}</Button>
          ))}
        </div>
      )}
    </div>
  );
}

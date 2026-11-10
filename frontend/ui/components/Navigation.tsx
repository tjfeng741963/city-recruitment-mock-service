import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

export function Tabs({ items, value, onChange, label }: { items: TabItem[]; value: string; onChange: (v: string) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, items.findIndex((t) => t.value === value));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div className="ui-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={i === index}
          tabIndex={i === index ? 0 : -1}
          className="ui-tab"
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined && <span className="ui-tab-count ui-num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = "搜索",
  label,
  shortcut,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  shortcut?: string;
}) {
  return (
    <div className="ui-search">
      <Icon name="search" size={16} />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
      />
      {value ? (
        <button type="button" className="ui-search-clear" aria-label="清除搜索" onClick={() => onChange("")}>
          <Icon name="x" size={12} />
        </button>
      ) : (
        shortcut && <kbd className="ui-kbd">{shortcut}</kbd>
      )}
    </div>
  );
}

export function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="ui-pager" aria-label="分页">
      <span className="ui-pager-info ui-num">
        第 {from}–{to} 条，共 {total} 条
      </span>
      <div className="ui-pager-btns">
        <button type="button" className="ui-icon-btn" aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <span className="ui-pager-current ui-num" aria-current="page">
          {page} / {pages}
        </span>
        <button type="button" className="ui-icon-btn" aria-label="下一页" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </nav>
  );
}

export function Breadcrumb({ items }: { items: string[] }) {
  return (
    <nav aria-label="面包屑" className="ui-crumbs">
      <ol>
        {items.map((item, i) => (
          <li key={item}>
            {i < items.length - 1 ? (
              <>
                <a href="#ui-kit" onClick={(e) => e.preventDefault()}>
                  {item}
                </a>
                <Icon name="chevronRight" size={12} />
              </>
            ) : (
              <span aria-current="page">{item}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="ui-steps">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s} className={`ui-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="ui-step-dot">{state === "done" ? <Icon name="check" size={12} /> : i + 1}</span>
            <span className="ui-step-label">{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function ListGroup({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ui-list-group" aria-labelledby={header ? id : undefined}>
      {header && (
        <h4 className="ui-list-header" id={id}>
          {header}
        </h4>
      )}
      <div className="ui-list">{children}</div>
      {footer && <p className="ui-list-footer">{footer}</p>}
    </section>
  );
}

export function ListRow({
  icon,
  iconTone = "accent",
  title,
  subtitle,
  detail,
  trailing,
  onClick,
}: {
  icon?: IconName;
  iconTone?: "accent" | "success" | "warning" | "danger" | "neutral";
  title: string;
  subtitle?: string;
  detail?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      {icon && (
        <span className={`ui-row-icon ui-tone-${iconTone}`}>
          <Icon name={icon} size={16} />
        </span>
      )}
      <span className="ui-row-text">
        <span className="ui-row-title">{title}</span>
        {subtitle && <span className="ui-row-sub">{subtitle}</span>}
      </span>
      {detail && <span className="ui-row-detail">{detail}</span>}
      {trailing}
      {onClick && !trailing && <Icon name="chevronRight" size={14} className="ui-row-chevron" />}
    </>
  );
  return onClick ? (
    <button type="button" className="ui-row is-link" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="ui-row">{body}</div>
  );
}

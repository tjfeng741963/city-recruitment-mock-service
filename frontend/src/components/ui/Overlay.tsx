import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "./Icon";
import type { Tone } from "./Display";

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
}

function useFocusReturn(open: boolean, panel: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus();
  }, [open, panel]);
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: "dialog" | "sheet";
}

export function Dialog({ open, onClose, title, description, children, footer, variant = "dialog" }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  useFocusReturn(open, panel);
  if (!open) return null;

  return (
    <div className={`ui-overlay ui-overlay-${variant}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={`ui-${variant}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="ui-dialog-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        {description && <p className="ui-dialog-desc">{description}</p>}
        {children && <div className="ui-dialog-body">{children}</div>}
        {footer && <footer className="ui-dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

const TONE_ICON: Record<Tone, IconName> = {
  neutral: "info",
  accent: "info",
  success: "check",
  warning: "alert",
  danger: "alert",
};

export function Alert({ tone = "accent", title, children, action }: { tone?: Tone; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`ui-alert ui-tone-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <span className="ui-alert-icon">
        <Icon name={TONE_ICON[tone]} size={16} />
      </span>
      <div className="ui-alert-body">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
      {action}
    </div>
  );
}

export interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  undo?: boolean;
}

export function ToastViewport({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="ui-toast-viewport" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`ui-toast ui-tone-${t.tone}`}>
          <Icon name={TONE_ICON[t.tone]} size={16} />
          <span>{t.title}</span>
          {t.undo && (
            <button type="button" className="ui-toast-action" onClick={() => onDismiss(t.id)}>
              撤销
            </button>
          )}
          <button type="button" className="ui-icon-btn ui-icon-btn-sm" aria-label="关闭通知" onClick={() => onDismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="ui-tooltip-anchor" aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="ui-tooltip">
        {content}
      </span>
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onSelect?: () => void;
}

export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEscape(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const nodes = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nodes[(i + 1) % nodes.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nodes[(i - 1 + nodes.length) % nodes.length]?.focus();
    }
  }

  return (
    <div className="ui-menu-root" ref={root}>
      <button
        type="button"
        className="ui-icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className="ui-menu" role="menu" id={menuId} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`ui-menu-item ${item.danger ? "is-danger" : ""}`}
              onClick={() => {
                item.onSelect?.();
                setOpen(false);
              }}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Icon, type IconName } from "./Icon";
import { EASE_SIGNATURE } from "./Motion";
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
  const reduce = useReducedMotion();
  useEscape(open, onClose);
  useFocusReturn(open, panel);

  const panelMotion =
    variant === "sheet"
      ? { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } }
      : { initial: { opacity: 0, scale: 0.94, y: 8 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.97, y: 4 } };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={`ui-overlay ui-overlay-${variant}`}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.22 }}
        >
          <motion.div
            ref={panel}
            className={`ui-${variant}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduce ? false : panelMotion.initial}
            animate={panelMotion.animate}
            exit={reduce ? undefined : panelMotion.exit}
            transition={{ duration: reduce ? 0 : 0.38, ease: EASE_SIGNATURE }}
          >
            <header className="ui-dialog-head">
              <h3 id={titleId}>{title}</h3>
              <button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>
                <Icon name="x" size={16} />
              </button>
            </header>
            {description && <p className="ui-dialog-desc">{description}</p>}
            {children && <div className="ui-dialog-body">{children}</div>}
            {footer && <footer className="ui-dialog-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
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
  return createPortal(
    <div className="ui-toast-viewport" aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`ui-toast ui-tone-${t.tone}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.18 } }}
            transition={{ duration: 0.36, ease: EASE_SIGNATURE }}
          >
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
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
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

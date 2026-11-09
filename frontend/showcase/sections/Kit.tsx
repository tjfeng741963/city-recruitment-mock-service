import type { ReactNode } from "react";

export function Chapter({ id, index, title, lead, children }: { id: string; index: string; title: string; lead: string; children: ReactNode }) {
  return (
    <section className="kit-chapter" id={id} aria-labelledby={`${id}-title`}>
      <header className="kit-chapter-head">
        <span className="kit-chapter-index">{index}</span>
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{lead}</p>
      </header>
      {children}
    </section>
  );
}

export function Spec({ title, why, children, wide }: { title: string; why?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <article className={`kit-spec ${wide ? "is-wide" : ""}`}>
      <header className="kit-spec-head">
        <h3>{title}</h3>
        {why && <p>{why}</p>}
      </header>
      <div className="kit-spec-stage">{children}</div>
    </article>
  );
}

export function UxNotes({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="kit-ux">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function States({ children }: { children: ReactNode }) {
  return <div className="kit-states">{children}</div>;
}

export function State({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="kit-state">
      <span className="kit-state-name">{name}</span>
      <div className="kit-state-body">{children}</div>
    </div>
  );
}

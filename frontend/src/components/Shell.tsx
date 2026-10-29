import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { MODULES, type ModuleKey } from "../app/routes";
import { Icon } from "./ui";

const ROLE_LABEL: Record<string, string> = { admin: "管理员", customer: "运营", recruiter: "招聘员" };

export function Shell({ active, children, fullBleed = false }: { active: ModuleKey; children: ReactNode; fullBleed?: boolean }) {
  const { user, logout } = useAuth();
  const [primary, ...rest] = MODULES;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-brand">城市招聘</div>
        <nav className="rail-nav" aria-label="主导航">
          <a
            href={primary.home}
            className={`rail-item rail-item-primary ${active === primary.key ? "is-active" : ""}`}
            aria-current={active === primary.key ? "page" : undefined}
          >
            <Icon name={primary.icon} size={18} />
            <span>{primary.label}</span>
          </a>
          <div className="rail-sep" role="presentation" />
          {rest.map((m) => (
            <a key={m.key} href={m.home} className={`rail-item ${active === m.key ? "is-active" : ""}`} aria-current={active === m.key ? "page" : undefined}>
              <Icon name={m.icon} size={16} />
              <span>{m.label}</span>
            </a>
          ))}
        </nav>
        <div className="rail-footer">
          <div className="rail-user">
            <span className="rail-user-name">{user?.username}</span>
            <span className="rail-user-role">{ROLE_LABEL[user?.role ?? ""] ?? user?.role}</span>
          </div>
          <button type="button" className="rail-logout" onClick={logout}>
            退出
          </button>
        </div>
      </aside>
      <main className={`content ${fullBleed ? "is-full-bleed" : ""}`}>{children}</main>
    </div>
  );
}

import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { MODULES, type ModuleKey } from "../app/routes";
import { motion } from "framer-motion";
import { EASE_SIGNATURE, Icon } from "@ui";

const ROLE_LABEL: Record<string, string> = { admin: "管理员", customer: "运营", recruiter: "招聘员" };

export function Shell({ active, pageKey, children, fullBleed = false }: { active: ModuleKey; pageKey: string; children: ReactNode; fullBleed?: boolean }) {
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
            {active === primary.key && <ActivePill />}
            <Icon name={primary.icon} size={18} />
            <span>{primary.label}</span>
          </a>
          <div className="rail-sep" role="presentation" />
          {rest.map((m) => (
            <a key={m.key} href={m.home} className={`rail-item ${active === m.key ? "is-active" : ""}`} aria-current={active === m.key ? "page" : undefined}>
              {active === m.key && <ActivePill />}
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
      <main className={`content ${fullBleed ? "is-full-bleed" : ""}`}>
        <div key={pageKey} className="ui-page-enter content-page">
          {children}
        </div>
      </main>
    </div>
  );
}

function ActivePill() {
  return <motion.span layoutId="rail-active" className="rail-pill" aria-hidden="true" transition={{ duration: 0.38, ease: EASE_SIGNATURE }} />;
}

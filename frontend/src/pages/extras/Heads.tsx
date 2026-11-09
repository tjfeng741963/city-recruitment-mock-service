import type { ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";

type PositionsTab = "positions" | "holidays" | "links";

const POSITIONS_TABS: Array<[PositionsTab, string, string]> = [
  ["positions", "城市与岗位", "/service-positions"],
  ["holidays", "放假总表", "/holiday-schedules"],
  ["links", "城市关联", "/city-links"],
];

function TabLinks({ label, tabs, active }: { label: string; tabs: Array<[string, string, string]>; active: string }) {
  return (
    <nav className="mod-tabs" aria-label={label}>
      {tabs.map(([key, text, href]) =>
        key === active ? (
          <span key={key} className="mod-tab is-active" aria-current="page">{text}</span>
        ) : (
          <a key={key} className="mod-tab" href={href}>{text}</a>
        ),
      )}
    </nav>
  );
}

// Mirrors the header of PositionsPage so the three 岗位 sub-pages switch in place.
export function PositionsHead({ active }: { active: PositionsTab }) {
  return (
    <header className="mod-head">
      <h1>岗位</h1>
      <TabLinks label="岗位页签" tabs={POSITIONS_TABS} active={active} />
    </header>
  );
}

// Page title, one-line explanation and the page's main actions, under the tabs.
export function Toolbar({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="ex-toolbar">
      <div className="ex-toolbar-text">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children && <div className="ex-toolbar-actions">{children}</div>}
    </div>
  );
}

// Mirrors SettingsPage's tabs, with 账户汇总 added as the active entry.
export function SettingsHead() {
  const { user } = useAuth();
  const tabs: Array<[string, string, string]> = [
    ["general", "通用", "/settings"],
    ["recruiters", "招聘员", "/recruiters"],
  ];
  if (user?.role === "admin") tabs.push(["accounts", "账号", "/users"]);
  tabs.push(["summary", "账户汇总", "/account-summary"]);
  return (
    <header className="mod-head">
      <h1>设置</h1>
      <TabLinks label="设置页签" tabs={tabs} active="summary" />
    </header>
  );
}

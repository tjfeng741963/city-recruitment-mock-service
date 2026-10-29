import { MODULES, type ModuleKey } from "../app/routes";
import { EmptyState } from "../components/ui";

const LEGACY_ORIGIN = import.meta.env.VITE_LEGACY_ORIGIN ?? "http://127.0.0.1:8080";

export function LegacyPage({ module, path }: { module: ModuleKey; path: string }) {
  const def = MODULES.find((m) => m.key === module)!;
  return (
    <div className="mod-page">
      <header className="mod-head">
        <h1>{def.label}</h1>
      </header>
      <div className="mod-legacy">
        <EmptyState
          icon={def.icon}
          title="这一页还在用原来的界面"
          description="新界面排在第二批。原页面的功能都能正常用，会在新标签页打开（第一次需要在那边登录）。"
          action={
            <a className="ui-btn ui-btn-primary ui-btn-md" href={`${LEGACY_ORIGIN}${path}`} target="_blank" rel="noopener noreferrer">
              <span className="ui-btn-label">打开原页面</span>
            </a>
          }
        />
      </div>
    </div>
  );
}

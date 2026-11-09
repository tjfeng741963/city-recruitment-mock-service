import { EmptyState } from "@ui";
import type { ModuleKey } from "../../app/routes";
import "../../styles/activation.css";
import { CustomerPage } from "./CustomerPage";
import { DashboardPage } from "./DashboardPage";
import { DevicesPage } from "./DevicesPage";
import { ScriptsPage } from "./ScriptsPage";
import { StrategiesPage } from "./StrategiesPage";
import { TodayPage } from "./TodayPage";

export function ActivationModule({ path }: { module: ModuleKey; path: string }) {
  const clean = path.replace(/\/+$/, "") || "/activation";
  const customer = /^\/activation\/customer\/([^/]+)$/.exec(clean);
  if (customer) {
    const id = decodeURIComponent(customer[1]);
    return <CustomerPage key={id} id={id} />;
  }
  switch (clean) {
    case "/activation":
      return <DashboardPage />;
    case "/activation/today":
      return <TodayPage />;
    case "/activation/strategies":
      return <StrategiesPage />;
    case "/activation/devices":
      return <DevicesPage />;
    case "/activation/scripts":
      return <ScriptsPage />;
    default:
      return (
        <div className="mod-page">
          <EmptyState
            icon="search"
            title="没有这个页面"
            description="地址可能写错了。回到复聊总览重新进入。"
            action={<a className="ui-btn ui-btn-primary ui-btn-md" href="/activation"><span className="ui-btn-label">回到复聊总览</span></a>}
          />
        </div>
      );
  }
}

import { LegacyPage } from "../LegacyPage";
import type { ModuleKey } from "../../app/routes";
import { AccountSummaryPage } from "./AccountSummaryPage";
import { CityLinksPage } from "./CityLinksPage";
import { HolidaySchedulePage } from "./HolidaySchedulePage";
import { MobileChatPage } from "./mobile/MobileChatPage";
import "../../styles/extras.css";

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function ExtrasModule({ module, path }: { module: ModuleKey; path: string }) {
  if (under(path, "/holiday-schedules")) return <HolidaySchedulePage />;
  if (under(path, "/city-links")) return <CityLinksPage />;
  if (under(path, "/account-summary")) return <AccountSummaryPage />;
  if (under(path, "/m")) return <MobileChatPage />;
  return <LegacyPage module={module} path={path} />;
}

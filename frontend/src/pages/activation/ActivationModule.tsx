import { LegacyPage } from "../LegacyPage";
import type { ModuleKey } from "../../app/routes";

export function ActivationModule({ module, path }: { module: ModuleKey; path: string }) {
  return <LegacyPage module={module} path={path} />;
}

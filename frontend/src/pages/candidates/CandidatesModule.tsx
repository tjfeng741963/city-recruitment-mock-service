import type { ModuleKey } from "../../app/routes";
import { LegacyPage } from "../LegacyPage";
import { AgentEvaluationPage } from "./AgentEvaluationPage";
import { CandidatesPage } from "./CandidatesPage";
import { OldFriendsPage } from "./OldFriendsPage";
import { StatusDashboardPage } from "./StatusDashboardPage";
import "../../styles/candidates.css";

export function CandidatesModule({ module, path }: { module: ModuleKey; path: string }) {
  if (path.startsWith("/old-friends")) return <OldFriendsPage />;
  if (path.startsWith("/status-dashboard")) return <StatusDashboardPage />;
  if (path.startsWith("/agent-evaluations")) return <AgentEvaluationPage />;
  if (path.startsWith("/candidates")) return <CandidatesPage />;
  return <LegacyPage module={module} path={path} />;
}

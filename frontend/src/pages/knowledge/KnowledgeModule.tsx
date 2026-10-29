import type { ModuleKey } from "../../app/routes";
import "../../styles/knowledge.css";
import { AgentRulesPage } from "./AgentRulesPage";
import { KnowledgeItemsPage } from "./KnowledgeItemsPage";
import { UnknownQuestionsPage } from "./UnknownQuestionsPage";

function editTarget(path: string): "new" | number | undefined {
  if (path === "/knowledge/create") return "new";
  const match = /^\/knowledge\/(\d+)\/edit$/.exec(path);
  return match ? Number(match[1]) : undefined;
}

export function KnowledgeModule({ path }: { module: ModuleKey; path: string }) {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean.startsWith("/unknown-questions")) return <UnknownQuestionsPage />;
  if (clean.startsWith("/agent-rules")) return <AgentRulesPage />;
  return <KnowledgeItemsPage edit={editTarget(clean)} />;
}

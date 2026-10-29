import type { IconName } from "../components/ui";

export type ModuleKey = "reception" | "candidates" | "activation" | "devices" | "positions" | "knowledge" | "settings";

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  icon: IconName;
  home: string;
  primary?: boolean;
}

export const MODULES: ModuleDef[] = [
  { key: "reception", label: "接待", icon: "chat", home: "/conversations", primary: true },
  { key: "candidates", label: "候选人", icon: "users", home: "/candidates" },
  { key: "activation", label: "复聊", icon: "refresh", home: "/activation" },
  { key: "devices", label: "微信号", icon: "device", home: "/agent-devices" },
  { key: "positions", label: "岗位", icon: "briefcase", home: "/service-positions" },
  { key: "knowledge", label: "知识库", icon: "info", home: "/knowledge" },
  { key: "settings", label: "设置", icon: "settings", home: "/settings" },
];

export type Route =
  | { module: "reception" }
  | { module: "devices"; deviceId?: number }
  | { module: "positions"; view: "list"; cityId?: number; featuredOnly?: boolean }
  | { module: "positions"; view: "edit"; positionId: number }
  | { module: "settings"; tab: "general" | "recruiters" | "accounts" }
  | { module: ModuleKey; legacyPath: string };

const LEGACY_PREFIXES: Array<[ModuleKey, string[]]> = [
  ["reception", ["/m"]],
  ["candidates", ["/candidates", "/old-friends", "/status-dashboard", "/agent-evaluations"]],
  ["activation", ["/activation"]],
  ["knowledge", ["/knowledge", "/unknown-questions", "/agent-rules"]],
  ["positions", ["/holiday-schedules", "/city-links"]],
  ["settings", ["/account-summary"]],
];

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function idAt(path: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(path);
  return match ? Number(match[1]) : undefined;
}

export function matchRoute(rawPath: string): Route {
  const path = rawPath.replace(/\/+$/, "") || "/";

  for (const [module, prefixes] of LEGACY_PREFIXES) {
    if (prefixes.some((p) => under(path, p))) return { module, legacyPath: path };
  }

  if (under(path, "/agent-devices")) return { module: "devices", deviceId: idAt(path, /^\/agent-devices\/(\d+)$/) };

  const positionId = idAt(path, /^\/service-positions\/(\d+)\/edit$/);
  if (positionId !== undefined) return { module: "positions", view: "edit", positionId };
  if (under(path, "/recruiter-featured")) return { module: "positions", view: "list", featuredOnly: true };
  if (under(path, "/cities")) return { module: "positions", view: "list", cityId: idAt(path, /^\/cities\/(\d+)\/edit$/) };
  if (under(path, "/factories") || under(path, "/service-positions")) return { module: "positions", view: "list" };

  if (under(path, "/recruiters")) return { module: "settings", tab: "recruiters" };
  if (under(path, "/users")) return { module: "settings", tab: "accounts" };
  if (under(path, "/settings")) return { module: "settings", tab: "general" };

  return { module: "reception" };
}

export function isLegacy(route: Route): route is { module: ModuleKey; legacyPath: string } {
  return "legacyPath" in route;
}

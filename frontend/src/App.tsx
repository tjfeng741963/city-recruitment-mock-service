import { FeedbackProvider } from "@ui";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./components/LoginPage";
import { Shell } from "./components/Shell";
import { usePathname, useLinkInterception } from "./app/router";
import { isLegacy, matchRoute, type Route } from "./app/routes";
import { CandidatesModule } from "./pages/candidates/CandidatesModule";
import { ActivationModule } from "./pages/activation/ActivationModule";
import { KnowledgeModule } from "./pages/knowledge/KnowledgeModule";
import { ExtrasModule } from "./pages/extras/ExtrasModule";
import { ReceptionPage } from "./pages/reception/ReceptionPage";
import { DevicesPage } from "./pages/devices/DevicesPage";
import { PositionsPage } from "./pages/positions/PositionsPage";
import { PositionEditPage } from "./pages/positions/PositionEditPage";
import { SettingsPage } from "./pages/settings/SettingsPage";

function Page({ route }: { route: Route }) {
  if (isLegacy(route)) {
    const { module, legacyPath: path } = route;
    if (module === "candidates") return <CandidatesModule module={module} path={path} />;
    if (module === "activation") return <ActivationModule module={module} path={path} />;
    if (module === "knowledge") return <KnowledgeModule module={module} path={path} />;
    return <ExtrasModule module={module} path={path} />;
  }
  switch (route.module) {
    case "devices":
      return <DevicesPage key={route.deviceId ?? "wall"} deviceId={route.deviceId} />;
    case "positions":
      return route.view === "edit" ? (
        <PositionEditPage key={route.positionId} positionId={route.positionId} />
      ) : (
        <PositionsPage cityId={route.cityId} featuredOnly={route.featuredOnly} />
      );
    case "settings":
      return <SettingsPage tab={route.tab} />;
    default:
      return <ReceptionPage />;
  }
}

function pageKeyOf(route: Route): string {
  if (isLegacy(route)) return `${route.module}:${route.legacyPath}`;
  if (route.module === "settings") return `settings:${route.tab}`;
  if (route.module === "positions") return route.view === "edit" ? `positions:edit:${route.positionId}` : "positions";
  return route.module;
}

function Gate() {
  const { user, loading } = useAuth();
  const path = usePathname();
  useLinkInterception();
  if (loading) return <div className="boot-screen">加载中…</div>;
  if (!user) return <LoginPage />;
  const route = matchRoute(path);
  const isReception = route.module === "reception" && !isLegacy(route);
  return (
    <Shell active={route.module} pageKey={pageKeyOf(route)} fullBleed={isReception}>
      <Page route={route} />
    </Shell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <FeedbackProvider>
        <Gate />
      </FeedbackProvider>
    </AuthProvider>
  );
}

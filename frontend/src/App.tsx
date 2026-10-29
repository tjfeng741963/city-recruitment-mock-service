import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./components/LoginPage";
import { Shell } from "./components/Shell";
import { usePathname, useLinkInterception } from "./app/router";
import { isLegacy, matchRoute, type Route } from "./app/routes";
import { UiKitShowcase } from "./pages/UiKitShowcase";
import { LegacyPage } from "./pages/LegacyPage";
import { ReceptionPage } from "./pages/reception/ReceptionPage";
import { DevicesPage } from "./pages/devices/DevicesPage";
import { PositionsPage } from "./pages/positions/PositionsPage";
import { PositionEditPage } from "./pages/positions/PositionEditPage";
import { SettingsPage } from "./pages/settings/SettingsPage";

function Page({ route }: { route: Route }) {
  if (isLegacy(route)) return <LegacyPage module={route.module} path={route.legacyPath} />;
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

function Gate() {
  const { user, loading } = useAuth();
  const path = usePathname();
  useLinkInterception();
  if (window.location.hash === "#ui-kit") return <UiKitShowcase />;
  if (loading) return <div className="boot-screen">加载中…</div>;
  if (!user) return <LoginPage />;
  const route = matchRoute(path);
  const isReception = route.module === "reception" && !isLegacy(route);
  return (
    <Shell active={route.module} fullBleed={isReception}>
      <Page route={route} />
    </Shell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

import { describe, expect, it } from "vitest";
import { MODULES, matchRoute } from "../frontend/src/app/routes";

const OLD_ROUTES = [
  "/conversations", "/m", "/candidates", "/old-friends", "/status-dashboard", "/agent-evaluations",
  "/activation", "/activation/today", "/activation/customer/12", "/activation/strategies", "/activation/devices", "/activation/scripts",
  "/agent-devices", "/cities", "/cities/create", "/cities/3/edit", "/factories", "/factories/create", "/factories/4/edit",
  "/service-positions", "/service-positions/create", "/service-positions/5/edit", "/holiday-schedules", "/city-links", "/recruiter-featured",
  "/knowledge", "/knowledge/create", "/knowledge/6/edit", "/unknown-questions", "/agent-rules",
  "/settings", "/recruiters", "/recruiters/create", "/recruiters/7/edit", "/users", "/account-summary",
];

describe("matchRoute", () => {
  it("lands on reception for the root and unknown paths", () => {
    expect(matchRoute("/")).toEqual({ module: "reception" });
    expect(matchRoute("/login")).toEqual({ module: "reception" });
    expect(matchRoute("/no-such-page")).toEqual({ module: "reception" });
  });

  it("files every old route under one of the seven modules", () => {
    const keys = new Set(MODULES.map((m) => m.key));
    expect(keys.size).toBe(7);
    for (const path of OLD_ROUTES) expect(keys.has(matchRoute(path).module), path).toBe(true);
  });

  it("sends only reception routes to reception", () => {
    for (const path of OLD_ROUTES) {
      if (path === "/conversations" || path === "/m") continue;
      expect(matchRoute(path).module, path).not.toBe("reception");
    }
  });

  it("keeps later-batch modules on their original pages", () => {
    expect(matchRoute("/activation/customer/12")).toEqual({ module: "activation", legacyPath: "/activation/customer/12" });
    expect(matchRoute("/knowledge/6/edit")).toEqual({ module: "knowledge", legacyPath: "/knowledge/6/edit" });
    expect(matchRoute("/city-links")).toEqual({ module: "positions", legacyPath: "/city-links" });
    expect(matchRoute("/m")).toEqual({ module: "reception", legacyPath: "/m" });
    expect(matchRoute("/conversations")).toEqual({ module: "reception" });
  });

  it("extracts ids for detail pages", () => {
    expect(matchRoute("/service-positions/5/edit")).toEqual({ module: "positions", view: "edit", positionId: 5 });
    expect(matchRoute("/cities/3/edit")).toEqual({ module: "positions", view: "list", cityId: 3 });
    expect(matchRoute("/agent-devices/9")).toEqual({ module: "devices", deviceId: 9 });
    expect(matchRoute("/agent-devices/")).toEqual({ module: "devices", deviceId: undefined });
  });

  it("routes settings sub-pages to tabs", () => {
    expect(matchRoute("/recruiters/7/edit")).toEqual({ module: "settings", tab: "recruiters" });
    expect(matchRoute("/users")).toEqual({ module: "settings", tab: "accounts" });
    expect(matchRoute("/recruiter-featured")).toEqual({ module: "positions", view: "list", featuredOnly: true });
  });
});

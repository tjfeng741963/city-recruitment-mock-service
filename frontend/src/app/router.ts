import { useEffect, useState } from "react";

const EVENT = "app:navigate";

/**
 * 构建时注入的部署前缀：dev 与默认 build 均为 "/"（归一后为空串），`build:admin` 为 "/admin/"。
 * 项目未使用 react-router（BrowserRouter/HashRouter），自研 History 路由在此统一拼接/剥离前缀。
 */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

function withBase(path: string): string {
  return `${BASE}${path}`;
}

/** 去掉部署前缀，还原应用内部路径（如 /admin/candidates → /candidates）。 */
function stripBase(path: string): string {
  if (BASE && (path === BASE || path.startsWith(`${BASE}/`))) {
    const rest = path.slice(BASE.length);
    return rest || "/";
  }
  return path;
}

export function navigate(path: string, { replace = false } = {}): void {
  if (path === stripBase(window.location.pathname) + window.location.search) return;
  const target = withBase(path);
  if (replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

export function usePathname(): string {
  const [path, setPath] = useState(() => stripBase(window.location.pathname));
  useEffect(() => {
    const sync = () => setPath(stripBase(window.location.pathname));
    window.addEventListener("popstate", sync);
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);
  return path;
}

// Plain <a href="/..."> links anywhere in the app navigate without a full reload.
export function useLinkInterception(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor || anchor.target || anchor.hasAttribute("download") || anchor.origin !== window.location.origin) return;
      const href = anchor.getAttribute("href");
      if (!href?.startsWith("/") || href.startsWith("/api/")) return;
      e.preventDefault();
      navigate(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}

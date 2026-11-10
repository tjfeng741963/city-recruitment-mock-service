import { useEffect, useState } from "react";

const EVENT = "app:navigate";

export function navigate(path: string, { replace = false } = {}): void {
  if (path === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
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
